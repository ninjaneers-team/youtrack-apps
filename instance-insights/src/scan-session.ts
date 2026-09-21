/**
 * One scan, from the mark that says it started to the trend point it leaves.
 *
 * Two widgets can start a scan - the report page and the score tile - and the order
 * of what happens around it is the same either way: say that a scan is under way,
 * run the checks against a client of this scan's own, count what it cost, keep the
 * result unless keeping it would say something untrue, and take the mark off
 * however it ended. Written once per widget, that order was two orders that agreed
 * in most places; here it is one, and a test can run it without a browser.
 *
 * Nothing here knows React, the Host API or HTTP. The client and the app's storage
 * arrive as collaborators, which is also what lets the widgets keep their own
 * transport.
 */

import { runChecks, score } from './engine.ts';
import type {
  CheckOutcome,
  IgnoredItems,
  ScanProgressState,
  ScanResult,
} from './engine.ts';
import { checksForStorage } from './stored-run.ts';
import type { ScanUpload } from './stored-run.ts';
import type { ScanFate } from './report-shared.ts';
import type { ScanAggregate } from './trend.ts';
import type {
  CheckDefinition,
  ScanConfig,
  YouTrackClient,
} from './types.ts';

const MS_PER_SECOND = 1000;

/** What a scan cost: what it asked the instance, and how long that took. */
export interface ScanCost {
  requests: number;
  seconds: number;
  /** How often the instance asked for a pause; a scan then slows down by design. */
  throttled: number;
}

/**
 * What a client of one scan is given.
 *
 * The signal that stops it and the counters that show it is alive belong to the
 * scan, not to the widget that started it.
 */
export interface ScanClientHooks {
  signal: AbortSignal;
  onRequest(sent: number): void;
  onThrottle(times: number): void;
}

/** What a scan needs of the app's own storage. */
export interface ScanStore {
  markScan(at: string, done: boolean): Promise<void>;
  /** Returns the trend as stored, with this scan already on it. */
  saveScan(upload: ScanUpload): Promise<ScanAggregate[]>;
}

/** What an administrator has marked as intentional, as the score reads it. */
export interface ScanDecisions {
  checks: ReadonlySet<string>;
  items: IgnoredItems;
}

export interface ScanInput {
  checks: readonly CheckDefinition[];
  config: ScanConfig;
  store: ScanStore;
  client(hooks: ScanClientHooks): YouTrackClient;
  /**
   * The standing decisions, applied to what is stored.
   *
   * Without them the tile and the trend would carry a score the report page
   * contradicts: a decision holds for every scan, whichever widget ran it.
   */
  decisions: ScanDecisions;
  /**
   * Whether the app's storage answered when the page opened.
   *
   * False means the decisions are unknown, and a score computed without them must
   * not replace the one that has them - so the scan runs and is not kept.
   */
  stateRead: boolean;
  /**
   * When this scan started.
   *
   * The caller's, not this module's: a widget shows the seconds ticking from the
   * moment it says a scan is under way, and a scan that timed itself a moment
   * later would put that display and the trend on two different clocks.
   */
  startedAt: Date;
  /** Injected so a test is deterministic; the end of the scan is read from here. */
  now?(): Date;
  onProgress?(progress: ScanProgressState): void;
  onRequest?(sent: number): void;
  onThrottle?(times: number): void;
}

export interface ScanRun {
  outcomes: CheckOutcome[];
  at: Date;
  stopped: boolean;
  cost: ScanCost;
  fate: ScanFate;
  /** The trend as the app kept it, or null when this scan was not kept. */
  history: ScanAggregate[] | null;
}

export interface ScanHandle {
  /** Settles with what was measured, or rejects with what kept it from measuring. */
  readonly done: Promise<ScanRun>;
  /** Asks the scan to stop. What it measured until then is still reported. */
  stop(): void;
}

/**
 * Starts one scan.
 *
 * The first progress report arrives while this call is still on the stack - the
 * name of the check being worked on is what tells an administrator the scan is
 * alive, so it is not held back - which is why a caller says it is scanning before
 * calling this, not after.
 */
export function startScan(input: ScanInput): ScanHandle {
  const controller = new AbortController();
  return {
    done: run(input, controller, input.now ?? ((): Date => new Date())),
    stop: (): void => controller.abort(),
  };
}

/**
 * What became of a scan that has just run.
 *
 * A stopped scan measured part of the instance, and a part has no score that
 * belongs beside the scores of whole ones - so neither the trend nor the kept run
 * takes it. The report says which of the two happened.
 */
function fateOf(stopped: boolean, stateRead: boolean): ScanFate {
  if (stopped) {
    return 'partial';
  }
  return stateRead ? 'kept' : 'stateUnreadable';
}

async function run(
  input: ScanInput,
  controller: AbortController,
  clock: () => Date,
): Promise<ScanRun> {
  const mark = input.startedAt.toISOString();
  /* Advisory, so a storage that does not answer must not stop a scan that would
     otherwise work: the other widget then simply says nothing. */
  const marking = input.store.markScan(mark, false).catch(() => undefined);
  let sent = 0;
  let throttled = 0;
  try {
    const client = input.client({
      signal: controller.signal,
      onRequest: count => {
        sent = count;
        input.onRequest?.(count);
      },
      onThrottle: times => {
        throttled = times;
        input.onThrottle?.(times);
      },
    });
    const outcomes = await runChecks(
      input.checks,
      { client, config: input.config, now: clock() },
      input.onProgress,
    );
    const at = clock();
    const stopped = controller.signal.aborted;
    /* What the run cost, reported with the result: a scan of a large instance takes
       minutes, and "it felt slow" is not something anyone can act on. */
    const cost: ScanCost = {
      requests: sent,
      seconds: (at.getTime() - input.startedAt.getTime()) / MS_PER_SECOND,
      throttled,
    };
    const fate = fateOf(stopped, input.stateRead);
    const history = fate === 'kept' ? await keep(input, outcomes, at, cost) : null;
    return { outcomes, at, stopped, cost, fate, history };
  } finally {
    /* However it ended - finished, stopped or failed - this scan is over and takes
       its own mark off. The mark it set is waited for first, so a slow write cannot
       land after the one that clears it. */
    await marking;
    await input.store.markScan(mark, true).catch(() => undefined);
  }
}

async function keep(
  input: ScanInput,
  outcomes: readonly CheckOutcome[],
  at: Date,
  cost: ScanCost,
): Promise<ScanAggregate[]> {
  const result = score(outcomes, input.decisions.checks, input.decisions.items);
  return input.store.saveScan(uploadOf(result, at, cost, input.checks));
}

/**
 * The body that puts a scored scan on the trend.
 *
 * Also what a mark sends: marking a finding rescores the scan that is already
 * stored, and the report saves it again under the same timestamp, which revises
 * that point instead of adding one. Both paths build the same body here, or the
 * trend would hold two shapes of the same scan.
 */
export function uploadOf(
  result: ScanResult,
  at: Date,
  cost: ScanCost,
  checks: readonly CheckDefinition[],
): ScanUpload {
  return {
    score: result.overallScore,
    scoreAsMeasured: result.overallAsMeasured,
    findings: result.findings.length,
    at: at.toISOString(),
    requests: cost.requests,
    seconds: cost.seconds,
    throttled: cost.throttled,
    /* What each check found. The trend takes the measured ratios from it - marking
       a finding is bookkeeping, and the trend is about the instance - and the
       findings themselves are kept for the next time a report is opened. */
    checks: checksForStorage(result.outcomes, checks),
  };
}
