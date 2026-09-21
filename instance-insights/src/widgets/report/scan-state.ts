/**
 * What the report page is showing, as one value.
 *
 * The page is a small state machine - nothing scanned yet, a scan in flight, a
 * finished scan, a scan that failed - and every part of the page reads from it.
 * Kept apart from the components so that what a phase means is stated once.
 */

import {CHECKS} from '../../checks/catalog.ts';
import {outcomesFromRun} from '../../stored-run.ts';
import type {StoredRun} from '../../stored-run.ts';
import type {CheckOutcome, ScanProgressState} from '../../engine.ts';
import type {ScanCost} from '../../scan-session.ts';
import type {ScanFate} from '../../report-shared.ts';

/** A finished scan, whether it just ran or was read back from storage. */
export interface ScanDone {
  phase: 'done';
  outcomes: CheckOutcome[];
  at: Date;
  stopped: boolean;
  cost: ScanCost;
  /**
   * True for the run the app kept, as opposed to one that just ran.
   *
   * The report is the same either way; what differs is what it may claim. A kept
   * run describes the instance as it was at its timestamp, its accounts were not
   * kept with it, and the way to a current answer is another scan.
   */
  restored: boolean;
  /** True when the run was too large to keep the objects it named. */
  itemsOmitted: boolean;
  /**
   * Whether this scan was written to the app's storage, and if not, why.
   *
   * Two scans are not written. One whose decisions were unknown, because the
   * storage could not be read when the page opened: a score computed without them
   * would have replaced the one that has them. And a stopped one, which measured
   * part of the instance - it belongs neither on the trend nor in the place the
   * next visit reads its report from.
   */
  fate: ScanFate;
}

/**
 * Whether the app's own storage answered when the page opened.
 *
 * It holds the standing decisions and the trend, so a scan started without it is
 * still worth running and must not be recorded. See the state below.
 */
export type StateRead = 'pending' | 'read' | 'failed';

/**
 * The kept run as a finished scan, or null when there is none to render.
 *
 * A run whose checks the installed app no longer knows scores nothing, and a score
 * of nothing tells the reader less than the invitation to scan.
 */
export function restoredScan(run: StoredRun | null): ScanDone | null {
  if (run === null) {
    return null;
  }
  const outcomes = outcomesFromRun(run, CHECKS);
  if (outcomes.length === 0) {
    return null;
  }
  return {
    phase: 'done',
    outcomes,
    at: new Date(run.at),
    stopped: false,
    cost: {requests: run.requests, seconds: run.seconds, throttled: run.throttled},
    restored: true,
    itemsOmitted: run.itemsOmitted === true,
    fate: 'kept'
  };
}

export type ScanState =
  | {phase: 'idle'}
  | {
      phase: 'running';
      progress: ScanProgressState;
      sent: number;
      startedAt: number;
      throttled: number;
    }
  | ScanDone
  | {phase: 'error'; message: string};
