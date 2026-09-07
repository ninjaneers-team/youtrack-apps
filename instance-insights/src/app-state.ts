/**
 * Client for the app's own backend (src/backend.js), which keeps the state both
 * widgets share in AppGlobalStorage: the numbers of the last twenty-four scans,
 * the findings of the most recent one, and what an administrator marked as
 * intentional.
 *
 * Kept separate from the widgets so the fetchApp paths live in one place, the same
 * way the REST paths live in youtrack-api.ts.
 */

import type { IgnoredItems } from './engine.ts';
import type { IgnoredItem, ScanUpload, StoredRun } from './stored-run.ts';
import type { ScanAggregate } from './trend.ts';

export type { IgnoredItem, ScanAggregate, ScanUpload, StoredRun };

type Host = Awaited<ReturnType<typeof YTApp.register>>;

/** `<handler file>/<endpoint path>`, per the Host API convention. */
const ENDPOINTS = {
  state: 'backend/state',
  scan: 'backend/scan',
  started: 'backend/started',
  ignore: 'backend/ignore',
} as const;

export interface AppState {
  lastScan: ScanAggregate | null;
  /**
   * The findings of the most recent scan, so the report renders without scanning.
   *
   * Null before the first scan, and after a scan whose findings did not fit the
   * budget the handler keeps for them.
   */
  lastRun: StoredRun | null;
  ignoredChecks: string[];
  /**
   * Objects marked as intentional, one entry per object.
   *
   * Configuration of the instance - a project key, a board id, a field or group
   * name. Never an account: the handler refuses those.
   */
  ignoredItems: IgnoredItem[];
  /** Newest first, at most 24 entries. Empty until the first scan. */
  history: ScanAggregate[];
  /**
   * When a scan was last started, whichever widget started it.
   *
   * Advisory, not a lock: both the report page and the score tile can scan, and two
   * scans at once ask the instance everything twice. This is what lets the second
   * one say so before it starts. A scan that was stopped or whose browser went away
   * leaves the timestamp behind, so what is shown is its age, and `scanUnderWay`
   * stops believing a mark that has outlasted ten times the length of the last
   * recorded scan - long enough for a slow instance, short enough that a warning
   * about a scan nobody is running does not stand for days.
   */
  scanStarted: string | null;
  /**
   * The host this instance was addressed under, as the handler saw it.
   *
   * A widget knows its own base but not whether that base is the instance - in the
   * development entry it is a local dev server. The host is what the report checks
   * its base against before it turns names into links.
   */
  host: string | null;
}

/** The stored list of marked objects, grouped the way the score needs it. */
export function itemsByCheck(entries: readonly IgnoredItem[]): IgnoredItems {
  const byCheck = new Map<string, Set<string>>();
  for (const entry of entries) {
    const forCheck = byCheck.get(entry.check) ?? new Set<string>();
    forCheck.add(entry.item);
    byCheck.set(entry.check, forCheck);
  }
  return byCheck;
}

/** What the handler answers after a mark was set or taken off. */
export interface IgnoredState {
  ignoredChecks: string[];
  ignoredItems: IgnoredItem[];
}

/**
 * What the handler answers when a scan is saved: the trend with it already on.
 *
 * Named rather than written into the call, like the two reads beside it - the
 * shape the handler promises belongs where it can be found, not at one of its
 * callers.
 */
export interface StoredTrend {
  history: ScanAggregate[];
}

export interface AppStateClient {
  read(): Promise<AppState>;
  /** Returns the trend as stored, with this scan already on it. */
  saveScan(upload: ScanUpload): Promise<ScanAggregate[]>;
  /**
   * Says that a scan is starting, and at the end that it is over.
   *
   * The same timestamp both times, so a scan only ever clears its own mark: with two
   * scans running, the first to finish must not tell the other one's widget that
   * nothing is under way.
   */
  markScan(at: string, done: boolean): Promise<void>;
  setIgnored(checkId: string, ignored: boolean): Promise<IgnoredState>;
  /** Marks one named object of a check, or takes the mark off again. */
  setItemIgnored(
    checkId: string,
    item: string,
    ignored: boolean,
  ): Promise<IgnoredState>;
}

/** One request, one shape of answer, whether a check or a single object was marked. */
async function marked(host: Host, body: Record<string, unknown>): Promise<IgnoredState> {
  const res = await host.fetchApp<Partial<IgnoredState>>(ENDPOINTS.ignore, {
    method: 'POST',
    body,
  });
  return {
    ignoredChecks: res.ignoredChecks ?? [],
    ignoredItems: res.ignoredItems ?? [],
  };
}

export function createAppStateClient(host: Host): AppStateClient {
  return {
    async read(): Promise<AppState> {
      const state = await host.fetchApp<Partial<AppState>>(ENDPOINTS.state, {});
      return {
        lastScan: state.lastScan ?? null,
        lastRun: state.lastRun ?? null,
        ignoredChecks: state.ignoredChecks ?? [],
        ignoredItems: state.ignoredItems ?? [],
        history: state.history ?? [],
        scanStarted: state.scanStarted ?? null,
        host: state.host ?? null,
      };
    },

    async saveScan(upload: ScanUpload): Promise<ScanAggregate[]> {
      const res = await host.fetchApp<Partial<StoredTrend>>(ENDPOINTS.scan, {
        method: 'POST',
        body: upload,
      });
      return res.history ?? [];
    },

    async markScan(at: string, done: boolean): Promise<void> {
      await host.fetchApp(ENDPOINTS.started, { method: 'POST', body: { at, done } });
    },

    async setIgnored(checkId: string, ignored: boolean): Promise<IgnoredState> {
      return marked(host, { checkId, ignored });
    },

    async setItemIgnored(
      checkId: string,
      item: string,
      ignored: boolean,
    ): Promise<IgnoredState> {
      return marked(host, { checkId, item, ignored });
    },
  };
}
