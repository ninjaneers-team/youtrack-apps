/**
 * A stand-in for YouTrack's Host API, for looking at a widget during development.
 *
 * Why this exists: inside YouTrack a widget lives in an iframe that is sandboxed
 * without `allow-same-origin`, so its document has an opaque origin. Some browsers
 * give a document with an opaque origin no network access at all, which kills every
 * app widget in such a browser, JetBrains' own included. A widget then cannot be
 * looked at where it runs, so it is rendered here instead, in a page with a real
 * origin.
 *
 * REST calls go through the Vite dev server, which holds the token (see
 * vite.config.ts). The token never reaches the browser.
 *
 * By default `fetchApp` talks to the instance's real handler, at the same path the
 * Host API uses (`/api/extensionEndpoints/<app>/<path>`), so what shows up here is
 * what an administrator sees, down to the stored history. `?state=stub` swaps in an
 * in-session store with seeded scenarios instead, for states an instance does not
 * happen to be in.
 *
 * What this does NOT emulate, and what therefore stays unverified here: the sandbox
 * itself (print window, downloads, clipboard).
 */

/* The state the widgets read is the handler's own contract, imported rather than
   restated: a field the handler answers and the stub forgets would otherwise show
   up here as a page that works outside YouTrack and not inside it. */
import type { AppState, ScanUpload } from '../app-state.ts';
import type { StoredCheck } from '../stored-run.ts';
import type { ScanAggregate } from '../trend.ts';

const STORAGE_KEY = 'instance-insights-dev-state';

/** The one check whose objects are accounts, and are therefore never stored. */
const ACCOUNT_CHECK = 'licensing.inactive-users';
const HISTORY_LIMIT = 24;

/** Path prefix the dev server proxies to the instance, token attached there. */
const REST_PREFIX = '/yt/';

/** Where the Host API sends fetchApp, read out of YouTrack's own frontend. */
const APP_ENDPOINT_PREFIX = 'extensionEndpoints/instance-insights/';

function emptyState(): AppState {
  return {
    lastScan: null,
    lastRun: null,
    ignoredChecks: [],
    ignoredItems: [],
    history: [],
    scanStarted: null,
    host: null,
  };
}

/**
 * Scenarios, so a state that takes several scans to reach can be looked at at
 * once. `?scenario=trend` is two scans apart with different per-check ratios,
 * which is what the "Since the previous scan" section needs.
 */
function scenarioState(name: string | null): AppState {
  if (name !== 'trend') {
    return emptyState();
  }
  const checks = (licensing: number, stale: number, empty: number): ScanAggregate['checks'] => [
    { id: 'licensing.inactive-users', status: licensing > 0 ? 'finding' : 'clean', ratio: licensing },
    { id: 'process.stale-unresolved', status: stale > 0 ? 'finding' : 'clean', ratio: stale },
    { id: 'fields.empty-field', status: empty > 0 ? 'finding' : 'clean', ratio: empty },
  ];
  /* Two scans with different ratios per check, so every kind of movement the
     report can show is on screen at once: improved, resolved, new. */
  const before = {licensing: 0.9, stale: 0.4, empty: 0};
  const after = {licensing: 0.6, stale: 0.2, empty: 0.33};
  const older: ScanAggregate = {
    at: '2026-06-20T09:00:00.000Z',
    score: 38,
    findings: 11,
    checks: checks(before.licensing, before.stale, before.empty),
  };
  const newer: ScanAggregate = {
    at: '2026-08-14T09:10:00.000Z',
    score: 61.6,
    findings: 9,
    checks: checks(after.licensing, after.stale, after.empty),
  };
  return { ...emptyState(), lastScan: newer, history: [newer, older] };
}

function readState(): AppState {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as AppState;
    } catch {
      // A malformed scenario is not worth a puzzle; start over.
    }
  }
  const seeded = scenarioState(new URLSearchParams(location.search).get('scenario'));
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

function writeState(state: AppState): AppState {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

function queryString(query: Record<string, string> | undefined): string {
  if (!query) {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

interface RequestLike {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** Shows what the stub is doing, since there is no YouTrack UI around it. */
function note(message: string): void {
  const bar = document.getElementById('dev-note');
  if (bar) {
    bar.textContent = message;
  }
}

async function fetchYouTrack<T>(path: string, params: RequestLike = {}): Promise<T> {
  const res = await fetch(REST_PREFIX + path + queryString(params.query), {
    method: params.method ?? 'GET',
    headers: params.body ? { 'Content-Type': 'application/json' } : undefined,
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`REST ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * Same rule as the real handler: saving under a timestamp that is already on the
 * trend revises that point instead of adding one.
 */
function withScan(state: AppState, upload: ScanUpload): AppState {
  const rest = state.history[0]?.at === upload.at ? state.history.slice(1) : state.history;
  const stored = storedLikeTheHandler(upload);
  return {
    ...state,
    lastScan: stored,
    // The findings too, so a reload here shows what a reload on the instance shows.
    lastRun: {
      at: upload.at,
      requests: upload.requests,
      seconds: upload.seconds,
      throttled: upload.throttled,
      checks: upload.checks.map(withoutAccounts),
    },
    history: [stored, ...rest].slice(0, HISTORY_LIMIT),
  };
}

/** The handler keeps no accounts, whatever the report sends it. */
function withoutAccounts(check: StoredCheck): StoredCheck {
  if (check.id !== ACCOUNT_CHECK || check.finding === undefined) {
    return check;
  }
  const finding = { ...check.finding };
  delete finding.items;
  return { ...check, finding };
}

/**
 * The trend keeps a number per check, not the finding it came from.
 *
 * The handler on the instance projects the upload onto the aggregates it may store,
 * so this has to do the same. A harness that keeps the upload as it arrived shows a
 * page the instance never shows - "NaN % affected", because the sentence about what
 * moved reads a ratio the stored entry does not carry.
 */
function storedLikeTheHandler(upload: ScanUpload): ScanAggregate {
  return {
    score: upload.score,
    scoreAsMeasured: upload.scoreAsMeasured,
    findings: upload.findings,
    at: upload.at,
    checks: upload.checks.map((check) => ({
      id: check.id,
      status: check.status,
      ratio: check.finding?.ratio ?? 0,
    })),
  };
}

function withIgnored(state: AppState, checkId: string, ignored: boolean): AppState {
  const ignoredChecks = state.ignoredChecks.filter(id => id !== checkId);
  if (ignored) {
    ignoredChecks.push(checkId);
  }
  return { ...state, ignoredChecks };
}

/**
 * Marks one object of one check, the way the handler does.
 *
 * Treating this as a mark on the whole check would show a finding moving out of
 * the score for one board, which is not what the instance does with the same
 * click.
 */
function withIgnoredItem(
  state: AppState,
  checkId: string,
  item: string,
  ignored: boolean,
): AppState {
  const kept = state.ignoredItems.filter(
    entry => entry.check !== checkId || entry.item !== item,
  );
  // The handler refuses these outright, because their objects are accounts.
  if (ignored && checkId !== ACCOUNT_CHECK) {
    kept.push({ check: checkId, item });
  }
  return { ...state, ignoredItems: kept };
}

/**
 * Notes that a scan is under way, or that it is over.
 *
 * A scan only clears its own mark, as on the instance: with two scans running, the
 * first to finish must not report the other one as over.
 */
function withScanMark(state: AppState, at: string, done: boolean): AppState {
  if (!done) {
    return { ...state, scanStarted: at };
  }
  return state.scanStarted === at ? { ...state, scanStarted: null } : state;
}

/** The instance's own handler, through the same proxy as the REST calls. */
async function fetchAppReal<T>(path: string, params: RequestLike = {}): Promise<T> {
  return fetchYouTrack<T>(APP_ENDPOINT_PREFIX + path, params);
}

/** The app's own storage, kept in the session instead of in AppGlobalStorage. */
async function fetchAppStub<T>(path: string, params: RequestLike = {}): Promise<T> {
  const state = readState();
  if (path.endsWith('/state')) {
    /* The page itself stands in for the instance, so links into it render here the
       way they do inside YouTrack. They lead nowhere in the harness - the proxy
       only carries the REST API - but a link that never appears cannot be seen. */
    return { ...state, host: location.host } as unknown as T;
  }
  if (path.endsWith('/scan')) {
    return writeState(withScan(state, params.body as ScanUpload)) as unknown as T;
  }
  if (path.endsWith('/started')) {
    const body = params.body as { at: string; done?: boolean };
    return writeState(withScanMark(state, body.at, body.done === true)) as unknown as T;
  }
  if (path.endsWith('/ignore')) {
    const body = params.body as { checkId: string; item?: string; ignored: boolean };
    const next =
      body.item === undefined
        ? withIgnored(state, body.checkId, body.ignored)
        : withIgnoredItem(state, body.checkId, body.item, body.ignored);
    return writeState(next) as unknown as T;
  }
  throw new Error(`the dev host stub does not implement ${path}`);
}

/** Installs the stub as the global the widgets register with. */
export function installHostStub(): void {
  const stubbed = new URLSearchParams(location.search).get('state') === 'stub';
  const host = {
    fetchYouTrack,
    fetchApp: stubbed ? fetchAppStub : fetchAppReal,
    alert: (message: string) => note(`host.alert: ${message}`),
    enterModalMode: async () => undefined,
    exitModalMode: async () => undefined,
    collapse: () => undefined,
    closeWidget: () => undefined,
  };

  Object.defineProperty(globalThis, 'YTApp', {
    value: { locale: 'en', register: async () => host },
    configurable: true,
  });
}

/** Forgets the stubbed app storage, so the next reload starts from a scenario. */
export function resetState(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
