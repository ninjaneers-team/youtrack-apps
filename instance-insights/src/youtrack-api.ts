/**
 * The YouTrack REST mapping: paths, field selectors, response shapes and the
 * translation into domain types. Everything here is transport-agnostic.
 *
 * There are two transports for the same API - Node with a permanent token
 * (client.ts, used by the probe and scan scripts) and the app Host API inside the
 * widget iframe (host-client.ts). Only the transport differs, so the mapping lives
 * here once instead of being duplicated per transport.
 *
 * Verified with scripts/probe-api.ts against jetbrains/youtrack:2026.2.18194.
 * Two behaviours stay defensive because a small instance never shows them: the
 * count endpoint may answer -1 while computing, and large instances rate-limit.
 */

import { ScanCancelled } from './types.ts';
import { requireCounts } from './types.ts';
import type {
  AgileBoard,
  CountResult,
  CustomField,
  Project,
  StateBundle,
  User,
  UserGroup,
  YouTrackClient,
} from './types.ts';

/** Paths relative to the REST root (`/api`). */
const PATHS = {
  count: 'issuesGetter/count',
  activities: 'activities',
  projects: 'admin/projects',
  customFields: 'admin/customFieldSettings/customFields',
  users: 'users',
  agiles: 'agiles',
  groups: 'groups',
  stateBundles: 'admin/customFieldSettings/bundles/state',
} as const;

/** `fields=` selectors. Requesting a field YouTrack does not know is an error. */
const FIELDS = {
  project: 'id,shortName,name,archived,leader(id,login,banned)',
  /* Only the bundle's id per instance, not its values: a field lives in every
     project it is attached to, so asking for the values here would repeat them per
     project. The values come from the bundle list instead, in one request. */
  customField: 'id,name,fieldType(id),instances(id,project(shortName),bundle(id))',
  // No last-login time here: YouTrack REST drops `lastAccessTime` silently, the
  // same way it drops an invented name, and rejects it as `orderBy` with 400. Only
  // Hub carries it, and a full-page widget cannot reach Hub, so inactive-users
  // judges issue activity instead.
  user: 'id,login,fullName,banned,registered',
  // The column field and its values per column are what makes a board's own
  // definition of work-in-progress queryable (`{State}: {In Progress}`).
  agile:
    'id,name,projects(shortName),sprintsSettings(disableSprints),' +
    'columnSettings(field(name),columns(presentation,wipLimit(min,max),fieldValues(name)))',
  group: 'id,name,usersCount',
  stateBundle: 'id,name,values(name,isResolved)',
} as const;

/**
 * The project resource carries no issue total, so it is counted per project.
 *
 * Braced, like every other name that goes into a query: a short name is free to
 * contain characters the parser reads as syntax, and a query it cannot parse is a
 * 400 that would take the whole project list - and every check built on it - down.
 */
const PROJECT_ISSUES_QUERY = (shortName: string): string => `project: {${shortName}}`;

/**
 * Every way a person leaves a trace on an issue.
 *
 * The activity endpoint demands an explicit category list - it answers 400 without
 * one - and this is the reason to prefer it over a search query: a category name it
 * does not know contributes nothing silently, and a search attribute it does not
 * know answers zero just as silently, but here an unknown *author* is a 404 and a
 * missing filter is a 400, so the request cannot quietly measure the wrong thing.
 *
 * Voting and tagging are in the list on purpose. Someone who mostly reads still
 * votes and organises, and that is the person a licence check must not mistake for
 * a dormant account.
 */
const ACTIVITY_CATEGORIES = [
  'IssueCreatedCategory',
  'CommentsCategory',
  'CommentTextCategory',
  'CustomFieldCategory',
  'SummaryCategory',
  'DescriptionCategory',
  'AttachmentsCategory',
  'LinksCategory',
  'TagsCategory',
  'IssueResolvedCategory',
  'SprintCategory',
  'VotersCategory',
  // Not in the documented category table, but the instance answers with
  // WorkItemActivityItem for it, so logged work counts too.
  'WorkItemCategory',
].join(',');

/**
 * How long to wait for a count the instance is still computing.
 *
 * The endpoint answers -1 while it works, so the answer has to be asked for again.
 * A fixed pause between attempts costs that pause on every asynchronous count, and
 * a scan makes hundreds of them: at half a second each, a large instance spends
 * minutes waiting for numbers that were ready after fifty milliseconds. So the
 * first attempt follows quickly and the wait grows from there, which costs a few
 * more requests for a slow count and saves most of the waiting on a quick one.
 */
const COUNT_FIRST_WAIT_MS = 100;
const COUNT_WAIT_GROWTH = 1.6;
const COUNT_MAX_WAIT_MS = 1_000;
/** After this long, a count is treated as one the instance will not deliver. */
const COUNT_BUDGET_MS = 20_000;

/**
 * Page size for collections.
 *
 * YouTrack answers with the first 42 entries of a collection unless `$top` says
 * otherwise, so every list here is paged explicitly. Without that, an instance with
 * more than 42 users, projects or fields would be reported on as if it had 42 -
 * plausible numbers, wrong instance.
 */
const PAGE_SIZE = 500;

/**
 * Where paging gives up. Half a million entries in one collection is beyond any
 * real instance, so reaching this means something is wrong with the request, not
 * with the instance - and a scan that cannot see everything says so instead of
 * quietly reporting on a part.
 */
const MAX_PAGES = 1000;

/**
 * How many requests may be in flight at once, at most.
 *
 * A scan of a large instance spends its time waiting for answers, not sending: at
 * a tenth of a second per answer, four thousand requests are seven minutes of
 * waiting. Overlapping a few of them cuts that without asking the instance for more
 * per second than it was asked for before - the rate ceiling below is unchanged.
 *
 * It starts at one, though. The instance says what it can take, and it says it by
 * answering: after a streak of quick answers the scan allows one more request in
 * flight, and the first 429 or 503 puts it back to one for good. Nobody has to
 * choose a mode, and nothing is assumed about an instance nobody has measured.
 */
const CONCURRENCY_CAP = 3;
const RAMP_AFTER_SUCCESSES = 8;

/**
 * Minimum distance between the starts of two requests.
 *
 * A scan sends one request per project and per licensed user. Fired as fast as the
 * connection allows, that is a burst in front of an instance people are working in;
 * spaced out, it is a background load of at most twenty requests a second. The
 * pacing lives here rather than in a transport so that both transports have it.
 *
 * Measured from start to start, not as a pause after each answer: an instance
 * across the internet takes longer to answer than the gap itself, and waiting again
 * on top of that slows the scan without sparing the instance anything. The ceiling
 * of twenty requests a second is the same either way.
 */
const REQUEST_GAP_MS = 50;

/** Seconds, for the one message that states a duration. */
const MS_PER_SECOND = 1000;

/**
 * How long one request may take before the scan stops waiting for it.
 *
 * A request that never answers would otherwise hold the whole scan: everything is
 * serialised, so one hanging count blocks every check behind it. Thirty seconds is
 * far beyond any answer a count needs and short enough that the report says what
 * happened instead of showing a spinner.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Statuses that mean "not now" rather than "no": 429 is a rate limit, 503 the
 * overloaded proxy that on-premise instances usually sit behind. Both are worth
 * waiting out, and nothing else is - a 400 or a 404 answers the same way next time.
 */
const RETRY_STATUS = [429, 503];
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RequestOptions {
  query?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /**
   * Says the answer is no longer wanted, for a transport that can act on it.
   *
   * Giving up on a request and ending it are two different things: without this the
   * scan stops waiting after thirty seconds while the request itself runs on, and in
   * Node it holds its socket until the instance answers something nobody reads. The
   * Host API takes a method, a query and a body and nothing else, so inside the
   * widget this is simply unused.
   */
  signal?: AbortSignal;
}

/** Performs one REST request and returns the parsed JSON body. */
export type ApiTransport = <T>(path: string, options?: RequestOptions) => Promise<T>;

// --- Raw response shapes, limited to the fields requested above --------------

interface RawLeader {
  id: string;
  login: string;
  banned?: boolean;
}
interface RawProject {
  id: string;
  shortName: string;
  name: string;
  archived?: boolean;
  leader?: RawLeader | null;
}
interface RawInstance {
  id: string;
  project?: { shortName: string } | null;
  bundle?: { id?: string } | null;
}
interface RawCustomField {
  id: string;
  name: string;
  fieldType?: { id: string } | null;
  instances?: RawInstance[] | null;
}
interface RawUser {
  id: string;
  login: string;
  fullName?: string;
  banned?: boolean;
  registered?: number;
}
interface RawColumn {
  presentation?: string;
  wipLimit?: { min?: number | null; max?: number | null } | null;
  fieldValues?: { name?: string }[] | null;
}
interface RawAgile {
  id: string;
  name: string;
  projects?: { shortName?: string }[] | null;
  sprintsSettings?: { disableSprints?: boolean } | null;
  columnSettings?: {
    field?: { name?: string } | null;
    columns?: RawColumn[] | null;
  } | null;
}
interface RawGroup {
  id: string;
  name: string;
  usersCount?: number;
}
interface RawStateBundle {
  id: string;
  name?: string;
  values?: { name?: string; isResolved?: boolean }[] | null;
}

/**
 * The answer as the list of entries it has to be.
 *
 * The shapes above say what a list holds, and a type says nothing at runtime. The
 * transport hands over whatever came back, and what comes back is not always the
 * instance answering: a gateway in front of it can put an object or a message
 * where a collection belongs. Both of those end badly on their own - an object
 * cannot be spread, and a string spreads into its own characters, which would
 * reach the report as an instance of three projects nobody has. So the shape is
 * asserted once, where every collection comes through, and a scan that cannot
 * read a list says so instead of reporting on something it invented.
 */
function listOf<T>(path: string, answer: unknown): T[] {
  if (!Array.isArray(answer)) {
    throw new Error(`${path} answered ${shapeOf(answer)} where a list of entries belongs`);
  }
  for (const entry of answer) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${path} answered a list holding ${shapeOf(entry)} instead of an entry`);
    }
  }
  return answer as T[];
}

/**
 * The same, for the collections that are asked for an id.
 *
 * Every entry of those is identified by it downstream - as the key of a count, as
 * the object a finding names, as what a mark is stored under - so an entry without
 * one is not the entry that was asked for. Carried on, it becomes the string
 * "undefined" in a report and a mark nobody can take off again.
 */
function identifiedListOf<T>(path: string, answer: unknown): T[] {
  const entries = listOf<T>(path, answer);
  for (const entry of entries) {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${path} answered an entry without an id`);
    }
  }
  return entries;
}

/** What an unexpected answer is, in one word, for the message that names it. */
function shapeOf(answer: unknown): string {
  if (answer === null || answer === undefined) {
    return 'nothing';
  }
  return Array.isArray(answer) ? 'a list' : typeof answer;
}

/**
 * The count in an answer, or null when the answer carries none.
 *
 * A count is a whole number, and -1 is the instance saying it is still computing.
 * A fraction, a string, a boolean or a missing field are none of those: passed on,
 * they would end up in a headline as the number of issues in a project, and a
 * count of `"42"` divides into a share that is not a number at all.
 */
function countIn(answer: unknown): number | null {
  if (typeof answer !== 'object' || answer === null) {
    return null;
  }
  const value = (answer as { count?: unknown }).count;
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : null;
}

/** Enough of a rejection to act on, short enough to read inside a finding. */
const DETAIL_LIMIT = 300;

/** Enough of a query to identify it; some board queries are long. */
const QUERY_IN_ERROR_LIMIT = 200;

/** The fields YouTrack answers errors with, in the order they are worth reading. */
const ERROR_FIELDS = [
  'error',
  'error_description',
  'error_developer_message',
  'message',
  'statusText',
];

/** Whatever a rejection carries, as text. */
function detailOf(fields: Record<string, unknown>): string {
  const said = ERROR_FIELDS.map(key => fields[key]).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (said.length > 0) {
    return [...new Set(said)].join(' - ');
  }
  try {
    return JSON.stringify(fields).slice(0, DETAIL_LIMIT);
  } catch {
    return 'the request was rejected without a reason';
  }
}

/**
 * Any rejection, as an error that names the request and the reason.
 *
 * The Host API - the transport that runs in production - does not reject with an
 * Error. What arrives is a plain object, and `String(...)` turns that into
 * `[object Object]`: a report then offers that instead of a reason, and every
 * investigation ends there. So the shape is read here, once, for both transports.
 */
function apiErrorFrom(path: string, rejection: unknown): ApiError {
  if (rejection instanceof ApiError) {
    return rejection;
  }
  const status = statusOf(rejection);
  if (rejection instanceof Error) {
    return new ApiError(status, path, rejection.message);
  }
  if (typeof rejection !== 'object' || rejection === null) {
    return new ApiError(status, path, String(rejection));
  }
  return new ApiError(status, path, detailOf(rejection as Record<string, unknown>));
}

/**
 * The status a rejection carries, or 0.
 *
 * A `status` property is how both transports and most HTTP clients pass it. Where
 * there is none, the two statuses worth waiting out are looked for in the message -
 * and only those two, so a query that happens to contain 404 cannot be mistaken for
 * one. A status that stays unreadable means the request is not retried, which is the
 * safe direction: a check that fails visibly beats a request repeated for nothing.
 */
function statusOf(rejection: unknown): number {
  if (typeof rejection === 'object' && rejection !== null) {
    const status = (rejection as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  return Number(new RegExp(`\\b(${RETRY_STATUS.join('|')})\\b`).exec(message)?.[1] ?? 0);
}

/**
 * A request that failed with a status and a body, so the client can tell a rate
 * limit apart from a rejected query.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when the rejection carried none. */
  readonly status: number;

  constructor(status: number, path: string, detail: string) {
    // A status of zero is not a status, so it is not put in front of the reason.
    super(status > 0 ? `YouTrack ${status} on ${path}: ${detail}` : `${path}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** How the client behaves towards the instance it reads. */
export interface ClientOptions {
  /** Milliseconds between two requests. Zero only in tests. */
  gapMs?: number;
  /** Milliseconds one request may take. */
  timeoutMs?: number;
  /** First pause after a rate-limited request; it grows with each attempt. */
  backoffMs?: number;
  /** How long to wait for a count the instance is still computing. */
  countBudgetMs?: number;
  /** Called before each request with the number of requests sent so far. */
  onRequest?: (sent: number) => void;
  /**
   * Called when the instance asks for a pause, with how often it has now.
   *
   * A scan that slows down halfway through is either being throttled or waiting for
   * an instance that got busy, and those two call for different answers. The report
   * says which it was rather than leaving it to be felt.
   */
  onThrottle?: (times: number) => void;
  /** Stops the scan before its next request. */
  signal?: AbortSignal;
}

/**
 * YouTrackClient over an injected transport.
 *
 * Lists are cached per instance: a scan asks for the same list from several checks
 * and must not fetch it again each time. A list that could not be read is cached
 * as it came back, so the checks after it fail on the answer the instance gave
 * rather than asking again - reading the projects means one count per project, and
 * repeating that against an instance that has just refused is the opposite of
 * careful. The report names every check that came back without a measurement.
 */
export class YouTrackApiClient implements YouTrackClient {
  private readonly transport: ApiTransport;
  private readonly options: ClientOptions;
  private sent = 0;

  /** How many requests are in flight, and how many may be. */
  private inFlight = 0;
  /** Requests that found no room, oldest first. */
  private readonly waiting: Array<() => void> = [];
  private limit = 1;
  private successStreak = 0;
  /** Set once the instance has asked for a pause; the limit then stays at one. */
  private pressed = false;
  private throttled = 0;
  /** The start time the next request may claim, and the last one that really went. */
  private claimedStart = 0;
  private lastStart = 0;

  private projectsCache?: Promise<Project[]>;
  private customFieldsCache?: Promise<CustomField[]>;
  private usersCache?: Promise<User[]>;
  private agilesCache?: Promise<AgileBoard[]>;
  private groupsCache?: Promise<UserGroup[]>;
  private stateBundlesCache?: Promise<StateBundle[]>;

  /**
   * Settles when the scan is stopped, and never when nothing can stop it.
   *
   * Stopping is only prompt if it also ends the waiting. A batch of counts claims a
   * start time per query and queues for a slot, which is minutes of waiting on a
   * large instance - and a scan that was stopped would sit that out to the last
   * claim before its own widget noticed. So every wait is against this as well, and
   * the request that wakes up finds the scan stopped where it always did: at the
   * one place that asks, before it sends.
   */
  private readonly stopped: Promise<void>;

  constructor(transport: ApiTransport, options: ClientOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.stopped = new Promise<void>(resolve => {
      const signal = options.signal;
      if (signal === undefined) {
        return;
      }
      const stop = (): void => {
        this.wakeWaiting();
        resolve();
      };
      if (signal.aborted) {
        stop();
      } else {
        signal.addEventListener('abort', stop, { once: true });
      }
    });
  }

  /**
   * One request, once there is room for it.
   *
   * Two rules decide that room: how many requests may be in flight, and how close
   * together they may start. The second one is the promise to the instance - at most
   * one request every fifty milliseconds, whatever the concurrency - and the first
   * is what makes a scan of a slow instance finish in a reasonable time.
   */
  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.takeRoom();
    try {
      const answer = await this.send<T>(path, options);
      this.noteSuccess();
      return answer;
    } catch (err) {
      // A limit that survived every retry, so the caller sees it too.
      if (RETRY_STATUS.includes(statusOf(err))) {
        this.notePressure();
      }
      throw err;
    } finally {
      this.releaseRoom();
    }
  }

  /**
   * Waits until this request may start.
   *
   * Two rules, and each is waited out once. The gap is claimed on arrival: every
   * request takes the next free start time and sleeps until it, so a batch of eight
   * hundred counts costs eight hundred timers rather than one poll per request per
   * gap. That matters: polling for a free turn instead costs 322 000 timers for
   * such a batch, quadratic in its size, and paces the scan no differently.
   *
   * Room in flight cannot be computed the same way, because a request answers when
   * it answers; so a request that finds no room joins a queue, and whoever finishes
   * hands its slot to the one that has waited longest. The slot is counted by the
   * side that hands it over, so a slot can never be taken twice.
   */
  private async takeRoom(): Promise<void> {
    if (this.inFlight < this.limit && this.waiting.length === 0) {
      /* Taken before the wait, not after: two callers that both see a free slot
         and then sleep are two requests in flight where one was allowed. */
      this.inFlight++;
      await this.awaitGap();
      return;
    }
    /* Behind whoever was already waiting: a scan that overtakes its own queue would
       leave the first request of a batch for last. The slot is counted by whoever
       hands it over, so it cannot be taken twice. */
    await new Promise<void>(resolve => this.waiting.push(resolve));
    await this.awaitGap();
  }

  /**
   * Sleeps until this request's turn to start.
   *
   * The turn is claimed rather than waited for: every request takes the next free
   * start time off a counter that only moves forward, so it sleeps once and wakes
   * once. Polling instead costs a wake-up per waiting request per gap - 322 000
   * timers for a batch of eight hundred counts, quadratic in the batch, and not one
   * request sooner.
   *
   * A claim is a plan, though, and the promise to the instance is about actual
   * starts. A starved event loop - a busy tab, a garbage collection - brings several
   * claims due at once, and they would then leave together as a burst. So the clock
   * has the last word: whoever wakes too close behind the request that really went
   * out waits out the rest of the gap. Normally that loop does not run at all.
   */
  private async awaitGap(): Promise<void> {
    const gapMs = this.options.gapMs ?? REQUEST_GAP_MS;
    const claimed = Math.max(Date.now(), this.claimedStart + gapMs);
    this.claimedStart = claimed;
    await this.sleep(claimed - Date.now());
    for (
      let since = Date.now() - this.lastStart;
      since < gapMs && !this.isStopped();
      since = Date.now() - this.lastStart
    ) {
      await this.sleep(gapMs - since);
    }
    this.lastStart = Date.now();
  }

  /**
   * Sleeps until due, or until the scan is stopped - whichever comes first.
   *
   * The timer goes with the scan: a stopped batch would otherwise leave one pending
   * per claimed turn, which in Node keeps a script alive for as long as the longest
   * claim.
   */
  private sleep(ms: number): Promise<void> {
    if (this.options.signal === undefined) {
      return delay(ms);
    }
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms);
      void this.stopped.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private isStopped(): boolean {
    return this.options.signal?.aborted === true;
  }

  /** Gives the slot back and hands it on, if anyone is waiting for one. */
  private releaseRoom(): void {
    this.inFlight--;
    this.admitNext();
  }

  /**
   * Lets everyone queued for a slot go on, without handing out slots.
   *
   * Called when the scan is stopped: each of them then asks whether it may send,
   * finds that it may not, and leaves. The queue is emptied rather than walked, so
   * a slot that comes free afterwards is not handed to a request that already went.
   *
   * Counted like any other hand-over, even though the limit no longer matters here:
   * every one of them gives its slot back on the way out, and an increment it never
   * got would leave the count below zero.
   */
  private wakeWaiting(): void {
    for (const wake of this.waiting.splice(0)) {
      this.inFlight++;
      wake();
    }
  }

  private admitNext(): void {
    if (this.inFlight >= this.limit) {
      return;
    }
    const next = this.waiting.shift();
    if (next !== undefined) {
      this.inFlight++;
      next();
    }
  }

  /** A streak of answers is the instance saying it has room for one more. */
  private noteSuccess(): void {
    if (this.pressed || this.limit >= CONCURRENCY_CAP) {
      return;
    }
    this.successStreak++;
    if (this.successStreak >= RAMP_AFTER_SUCCESSES) {
      this.successStreak = 0;
      this.limit++;
      // The new room is of no use to a request that is already asleep in the queue.
      this.admitNext();
    }
  }

  /**
   * A rate limit is not a hint. Once the instance has asked for a pause, the scan
   * goes back to one request at a time and stays there for the rest of the run.
   */
  private notePressure(): void {
    this.pressed = true;
    this.limit = 1;
    this.successStreak = 0;
    this.throttled++;
    this.options.onThrottle?.(this.throttled);
  }

  /**
   * One request, retried while the instance says it is taking too many.
   *
   * The wait happens with the queue held, so a rate-limited instance is not sent
   * the next request either - backing off one request while the rest keep coming
   * would defeat the purpose.
   */
  private async send<T>(path: string, options: RequestOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Stopping is not a failed request, so it travels untouched.
      this.stopIfCancelled();
      this.sent++;
      this.options.onRequest?.(this.sent);
      try {
        return await this.awaitAnswer<T>(path, options);
      } catch (rejection) {
        const err = apiErrorFrom(path, rejection);
        if (!RETRY_STATUS.includes(err.status)) throw err;
        /* Noted here rather than where the error escapes: a limit that is waited
           out successfully never reaches a caller, and it is exactly as much of a
           statement by the instance as one that does. */
        this.notePressure();
        if (attempt >= RATE_LIMIT_RETRIES) {
          throw new Error(
            `The instance answered ${err.status} to ${path} on all ` +
              `${RATE_LIMIT_RETRIES + 1} attempts: it limits how many requests it ` +
              'accepts, and the scan cannot read what it needs right now.',
          );
        }
        await this.sleep((this.options.backoffMs ?? RATE_LIMIT_BACKOFF_MS) * (attempt + 1));
      }
    }
  }

  /** Gives up on a request that does not answer, so one of them cannot hold the scan. */
  private awaitAnswer<T>(path: string, options: RequestOptions): Promise<T> {
    const timeoutMs = this.options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    /* Told to stop as well as given up on: the reason the scan reports is the one
       below, and the request ends instead of running on unread. */
    const abandon = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        abandon.abort();
        reject(new Error(`${path} did not answer within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.transport<T>(path, { ...options, signal: abandon.signal }).then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        err => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private stopIfCancelled(): void {
    if (this.options.signal?.aborted) throw new ScanCancelled();
  }

  /** Reads a whole collection, page by page, and never a part of one. */
  private async requestAll<T>(path: string, fields: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = identifiedListOf<T>(
        path,
        await this.request<unknown>(path, {
          query: {
            fields,
            $top: String(PAGE_SIZE),
            $skip: String(page * PAGE_SIZE),
          },
        }),
      );
      all.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return all;
      }
    }
    throw new Error(
      `${path} returned more than ${MAX_PAGES * PAGE_SIZE} entries; ` +
        'the scan stops rather than report on a part of the instance',
    );
  }

  async count(query: string): Promise<number> {
    try {
      return await this.countOf(query);
    } catch (err) {
      /* Stopping is about the whole scan and not about this query, so it travels
         out as itself. Named as a query that failed, it would reach the report as a
         check that hit an error - and a scan an administrator stopped would read as
         an instance that refused to answer. */
      if (err instanceof ScanCancelled) {
        throw err;
      }
      /* The endpoint is the same for every check, so its name alone identifies
         nothing. The query does - a rejected one is rejected for what is in it. */
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${reason} - query: ${query.slice(0, QUERY_IN_ERROR_LIMIT)}`);
    }
  }

  /**
   * The counts of a batch, gathered as fast as the pacing allows.
   *
   * Every query is sent through the same room-keeping as a single count, so a batch
   * of eight hundred is not a burst - it is the same requests, without the scan
   * waiting for each answer before starting the next.
   */
  async countMany(queries: readonly string[]): Promise<CountResult[]> {
    return Promise.all(
      queries.map(async query => {
        try {
          return { count: await this.count(query) };
        } catch (err) {
          // A refused query is one result of the batch; a stopped scan is the end
          // of it, and the batch rejects with it rather than reporting counts that
          // failed for a reason the instance had nothing to do with.
          if (err instanceof ScanCancelled) {
            throw err;
          }
          return { failed: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  private async countOf(query: string): Promise<number> {
    const budget = this.options.countBudgetMs ?? COUNT_BUDGET_MS;
    const until = Date.now() + budget;
    let wait = COUNT_FIRST_WAIT_MS;
    for (;;) {
      const value = countIn(
        await this.request<unknown>(PATHS.count, {
          method: 'POST',
          body: { query },
          query: { fields: 'count' },
        }),
      );
      if (value === null) {
        throw new Error(`${PATHS.count} answered something that is not a count`);
      }
      if (value >= 0) {
        return value;
      }
      if (Date.now() >= until) {
        throw new Error(
          `The instance was still computing this count after ${budget / MS_PER_SECOND} seconds`,
        );
      }
      // -1 means the count is still being computed.
      await this.sleep(wait);
      wait = Math.min(COUNT_MAX_WAIT_MS, Math.round(wait * COUNT_WAIT_GROWTH));
    }
  }

  /**
   * `reverse=true` puts the newest item first, so one item is enough: its timestamp
   * is the last time this account did anything at all.
   */
  async lastActivity(userId: string): Promise<number | null> {
    const items = listOf<{ timestamp?: unknown }>(
      PATHS.activities,
      await this.request<unknown>(PATHS.activities, {
        query: {
          fields: 'timestamp',
          author: userId,
          categories: ACTIVITY_CATEGORIES,
          reverse: 'true',
          $top: '1',
        },
      }),
    );
    const first = items[0];
    // An empty list is an account that has never changed anything.
    if (first === undefined) {
      return null;
    }
    /* A trace without a readable time is not the same as no trace: read as "never",
       it would put an account that works every day on a list of dormant ones. */
    if (typeof first.timestamp !== 'number' || !Number.isFinite(first.timestamp)) {
      throw new Error(`${PATHS.activities} answered a trace without a time`);
    }
    return first.timestamp;
  }

  listProjects(): Promise<Project[]> {
    return (this.projectsCache ??= this.fetchProjects());
  }

  listCustomFields(): Promise<CustomField[]> {
    return (this.customFieldsCache ??= this.fetchCustomFields());
  }

  listUsers(): Promise<User[]> {
    return (this.usersCache ??= this.fetchUsers());
  }

  listAgileBoards(): Promise<AgileBoard[]> {
    return (this.agilesCache ??= this.fetchAgiles());
  }

  listGroups(): Promise<UserGroup[]> {
    return (this.groupsCache ??= this.fetchGroups());
  }

  listStateBundles(): Promise<StateBundle[]> {
    return (this.stateBundlesCache ??= this.fetchStateBundles());
  }

  private async fetchProjects(): Promise<Project[]> {
    const raw = await this.requestAll<RawProject>(PATHS.projects, FIELDS.project);
    /* Archived projects are not counted: search rejects one as a scope, and a single
       rejected query would take the whole list - and every check built on it - down
       with it. The rest are counted as one batch, so the scan is not waiting for one
       answer before asking the next question. */
    const active = raw.filter(p => !(p.archived ?? false));
    const counts = requireCounts(
      await this.countMany(active.map(p => PROJECT_ISSUES_QUERY(p.shortName))),
    );
    const countOf = new Map(active.map((p, index) => [p.id, counts[index] ?? 0]));
    return raw.map(p => ({
      id: p.id,
      shortName: p.shortName,
      name: p.name,
      archived: p.archived ?? false,
      issuesCount: countOf.get(p.id) ?? null,
      leader: p.leader
        ? { id: p.leader.id, login: p.leader.login, banned: p.leader.banned ?? false }
        : null,
    }));
  }

  private async fetchCustomFields(): Promise<CustomField[]> {
    const raw = await this.requestAll<RawCustomField>(PATHS.customFields, FIELDS.customField);
    return raw.map(f => ({
      id: f.id,
      name: f.name,
      fieldType: f.fieldType?.id ?? 'unknown',
      instances: (f.instances ?? [])
        .filter((i): i is RawInstance & { project: { shortName: string } } =>
          Boolean(i.project?.shortName),
        )
        .map(i => ({
          id: i.id,
          projectShortName: i.project.shortName,
          bundleId: i.bundle?.id ?? null,
        })),
    }));
  }

  private async fetchUsers(): Promise<User[]> {
    const raw = await this.requestAll<RawUser>(PATHS.users, FIELDS.user);
    return raw.map(u => ({
      id: u.id,
      login: u.login,
      fullName: u.fullName ?? u.login,
      banned: u.banned ?? false,
      // A missing date reads as "long ago", so the account is judged by activity.
      registered: u.registered ?? 0,
    }));
  }

  private async fetchAgiles(): Promise<AgileBoard[]> {
    const raw = await this.requestAll<RawAgile>(PATHS.agiles, FIELDS.agile);
    return raw.map(b => ({
      id: b.id,
      name: b.name,
      // A board with no sprint settings at all plans in sprints, which is what
      // YouTrack sets up by default.
      usesSprints: !(b.sprintsSettings?.disableSprints ?? false),
      columnField: b.columnSettings?.field?.name ?? '',
      projects: (b.projects ?? [])
        .map(p => p.shortName)
        .filter((name): name is string => Boolean(name)),
      columns: (b.columnSettings?.columns ?? []).map(c => ({
        presentation: c.presentation ?? '',
        wipLimitMin: c.wipLimit?.min ?? null,
        wipLimitMax: c.wipLimit?.max ?? null,
        fieldValues: (c.fieldValues ?? [])
          .map(v => v.name)
          .filter((name): name is string => Boolean(name)),
      })),
    }));
  }

  private async fetchStateBundles(): Promise<StateBundle[]> {
    const raw = await this.requestAll<RawStateBundle>(PATHS.stateBundles, FIELDS.stateBundle);
    return raw.map(b => ({
      id: b.id,
      name: b.name ?? b.id,
      values: (b.values ?? [])
        .filter((v): v is { name: string; isResolved?: boolean } => Boolean(v.name))
        .map(v => ({ name: v.name, resolved: v.isResolved ?? false })),
    }));
  }

  private async fetchGroups(): Promise<UserGroup[]> {
    const raw = await this.requestAll<RawGroup>(PATHS.groups, FIELDS.group);
    return raw.map(g => ({ id: g.id, name: g.name, usersCount: g.usersCount ?? 0 }));
  }
}
