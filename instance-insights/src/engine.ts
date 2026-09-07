/**
 * Scan runner and scoring.
 *
 * Running and scoring are separate on purpose. Marking a finding as intentional
 * must move the score immediately - that is what makes the report worth reopening -
 * and asking the instance for every count again to recompute arithmetic would be
 * absurd. So `runChecks` produces outcomes, `score` turns outcomes plus a set of
 * ignored check IDs into a result, and `runScan` is the two together.
 *
 * Three hard rules shape the scoring:
 *
 *   1. Only checks that actually ran count toward the denominator. A check that
 *      failed or was skipped must not move the score.
 *   2. The score is fully recomputable by hand - the deduction per check is exactly
 *      `weight * ratio`, nothing else. (SEVERITY_FACTOR from types.ts is a display
 *      concern and stays out of the score.)
 *   3. An ignored check *did* run, so its weight stays in the denominator while its
 *      deduction becomes zero. That is what lifts the score when an administrator
 *      marks a finding as intentional. Marking single objects of a finding works the
 *      same way, one object at a time: the share is recomputed without them.
 *
 * The engine knows nothing about YouTrack or HTTP. It depends only on the check
 * contract and the category weights from types.ts.
 */

import type {
  Category,
  CheckDefinition,
  Finding,
  ScanContext,
} from './types.ts';
import { CATEGORY_WEIGHT, CheckSkipped, ScanCancelled } from './types.ts';

/**
 * What became of one check in a scan.
 * - `finding`: ran and produced a finding (counts, with a deduction).
 * - `clean`:   ran and found nothing (counts, deduction 0 - improves the score).
 * - `skipped`: not applicable to this instance (excluded from the denominator).
 * - `failed`:  threw an unexpected error (excluded; a single failure never aborts
 *              the scan).
 */
export type CheckStatus = 'finding' | 'clean' | 'skipped' | 'failed';

export interface CheckOutcome {
  checkId: string;
  category: Category;
  weight: number;
  status: CheckStatus;
  finding: Finding | null;
  /**
   * Why the check produced no measurement, for `skipped` and `failed`.
   *
   * A score that moves because a check dropped out has to be explainable, and
   * "no board has a column between the first and the last" is the explanation.
   */
  reason?: string;
  /** Set only when status is `failed`. */
  error?: Error;
}

export interface CategoryScore {
  category: Category;
  /** 0..100, or null when not a single check in this category ran. */
  score: number | null;
  /** sum of the weights of the checks that ran - the denominator of the category score. */
  ranWeight: number;
  /** sum of weight * ratio over the checks that ran and are not ignored. */
  deduction: number;
  findings: Finding[];
}

/** How far a scan has come. `running` is null once every check is done. */
export interface ScanProgressState {
  done: number;
  total: number;
  running: string | null;
  /**
   * The findings so far.
   *
   * A scan of a large instance takes minutes, and a bar that fills without showing
   * anything makes an administrator wait for a result they could already be reading.
   */
  findings: readonly Finding[];
}

export type ScanProgress = (state: ScanProgressState) => void;

export interface ScanResult {
  /** 0..100, or null when not a single check ran across the whole instance. */
  overallScore: number | null;
  /**
   * The same score, as if nothing had been marked as intentional.
   *
   * Marking a finding raises the score without anything in the instance changing,
   * and a report that only shows the raised number leaves an administrator looking
   * for a change that never happened. Equal to `overallScore` while nothing is
   * marked.
   */
  overallAsMeasured: number | null;
  categories: CategoryScore[];
  /** Findings that count - ignored ones are listed separately. */
  findings: Finding[];
  /** Findings an administrator marked as intentional. Shown, but not counted. */
  ignoredFindings: Finding[];
  outcomes: CheckOutcome[];
}

export async function runScan(
  checks: readonly CheckDefinition[],
  ctx: ScanContext,
  ignored: ReadonlySet<string> = new Set(),
  ignoredItems: IgnoredItems = NO_ITEMS_IGNORED,
): Promise<ScanResult> {
  return score(await runChecks(checks, ctx), ignored, ignoredItems);
}

/**
 * Runs every check and reports what became of it. Sequential on purpose:
 * deterministic order for tests, and a natural throttle for the count-heavy real
 * client. One check throwing never aborts the rest.
 */
export async function runChecks(
  checks: readonly CheckDefinition[],
  ctx: ScanContext,
  onProgress?: ScanProgress,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  // Reported before the check runs, not after: on a large instance a single check
  // spends seconds on throttled counts, and the name of what is being worked on is
  // the part that tells the administrator the scan is alive.
  const findings: Finding[] = [];
  for (const [index, check] of checks.entries()) {
    onProgress?.({
      done: outcomes.length,
      total: checks.length,
      running: check.title,
      findings: [...findings],
    });
    let outcome: CheckOutcome;
    try {
      outcome = await runOne(check, ctx);
    } catch (err) {
      if (!(err instanceof ScanCancelled)) throw err;
      /* A stopped scan keeps what it has measured and says of every check it did
         not reach that it did not run. Those checks stay out of the score, so the
         part that was measured is still scored the way it would have been. */
      for (const missing of checks.slice(index)) {
        outcomes.push({
          checkId: missing.id,
          category: missing.category,
          weight: missing.weight,
          status: 'skipped',
          finding: null,
          reason: err.message,
        });
      }
      break;
    }
    outcomes.push(outcome);
    if (outcome.finding) findings.push(outcome.finding);
  }
  onProgress?.({
    done: outcomes.length,
    total: checks.length,
    running: null,
    findings: [...findings],
  });
  return outcomes;
}

async function runOne(
  check: CheckDefinition,
  ctx: ScanContext,
): Promise<CheckOutcome> {
  const base = {
    checkId: check.id,
    category: check.category,
    weight: check.weight,
  };
  try {
    const finding = await check.run(ctx);
    return finding === null
      ? { ...base, status: 'clean', finding: null }
      : { ...base, status: 'finding', finding };
  } catch (err) {
    // Stopping is about the whole scan, not about this check, so it travels out.
    if (err instanceof ScanCancelled) throw err;
    if (err instanceof CheckSkipped) {
      return { ...base, status: 'skipped', finding: null, reason: err.message };
    }
    const error = asError(err);
    return { ...base, status: 'failed', finding: null, reason: error.message, error };
  }
}

/**
 * Turns outcomes into scores. Pure, so the report can call it again after an
 * administrator marks a finding as intentional - no rescan involved.
 */
const NOTHING_IGNORED: ReadonlySet<string> = new Set();
const NO_ITEMS_IGNORED: IgnoredItems = new Map();

/**
 * Objects an administrator marked as intentional, per check.
 *
 * A whole check can be marked, and so can single objects it named: three of five
 * nearly empty projects can be deliberate while the other two are not. The keys are
 * check IDs, the values the `FindingItem.id` of the marked objects.
 */
export type IgnoredItems = ReadonlyMap<string, ReadonlySet<string>>;

export function score(
  outcomes: readonly CheckOutcome[],
  ignored: ReadonlySet<string> = new Set(),
  ignoredItems: IgnoredItems = NO_ITEMS_IGNORED,
): ScanResult {
  const byCategory = new Map<Category, CheckOutcome[]>();
  for (const outcome of outcomes) {
    const bucket = byCategory.get(outcome.category);
    if (bucket) bucket.push(outcome);
    else byCategory.set(outcome.category, [outcome]);
  }

  const categories: CategoryScore[] = [];
  const asMeasured: CategoryScore[] = [];
  for (const [category, group] of byCategory) {
    categories.push(scoreCategory(category, group, ignored, ignoredItems));
    /* The same arithmetic over the same outcomes, with nothing marked. Cheap, and
       it keeps the two numbers from drifting apart in two implementations. */
    asMeasured.push(
      scoreCategory(category, group, NOTHING_IGNORED, NO_ITEMS_IGNORED),
    );
  }

  const findings: Finding[] = [];
  const ignoredFindings: Finding[] = [];
  for (const outcome of outcomes) {
    if (!outcome.finding) continue;
    if (ignored.has(outcome.checkId)) ignoredFindings.push(outcome.finding);
    else findings.push(outcome.finding);
  }

  return {
    overallScore: overallScore(categories),
    overallAsMeasured: overallScore(asMeasured),
    categories,
    findings,
    ignoredFindings,
    outcomes: [...outcomes],
  };
}

function scoreCategory(
  category: Category,
  group: readonly CheckOutcome[],
  ignored: ReadonlySet<string>,
  ignoredItems: IgnoredItems,
): CategoryScore {
  let ranWeight = 0;
  let deduction = 0;
  const findings: Finding[] = [];

  for (const outcome of group) {
    // Only ran checks (finding + clean) enter the denominator. An ignored check
    // ran too, so it keeps its weight - it simply stops deducting.
    if (outcome.status === 'finding' || outcome.status === 'clean') {
      ranWeight += outcome.weight;
    }
    if (outcome.finding && !ignored.has(outcome.checkId)) {
      const ratio = effectiveRatio(outcome.finding, ignoredItems.get(outcome.checkId));
      deduction += outcome.weight * clampRatio(ratio);
      findings.push(outcome.finding);
    }
  }

  const score = ranWeight === 0 ? null : 100 - (100 * deduction) / ranWeight;
  return { category, score, ranWeight, deduction, findings };
}

/**
 * Weights each category score by its category weight, over the categories that
 * have a score at all. Categories with no ran check drop out of both the
 * numerator and the denominator, so they neither help nor hurt.
 */
function overallScore(categories: readonly CategoryScore[]): number | null {
  let weighted = 0;
  let weightSum = 0;
  for (const { category, score } of categories) {
    if (score === null) continue;
    const weight = CATEGORY_WEIGHT[category];
    weighted += weight * score;
    weightSum += weight;
  }
  return weightSum === 0 ? null : weighted / weightSum;
}

/**
 * The share a finding still deducts for, once single objects are marked.
 *
 * Only findings that carry both a list and the population it came out of can do
 * this: `(affected - marked) / total`. Everything else keeps the ratio it measured,
 * which is why marking an object is offered for some checks and not for others.
 * Marked objects that the current scan no longer found simply do not count - a
 * project that was archived since is not still being excluded from anything.
 *
 * Where the objects weigh differently from one another, the finding says so with
 * its own `affected` and the numbers on each item, and both sides of the fraction
 * shrink: a board with 18 of 18 stopped cards takes those 18 cards out of the
 * count, not one board out of a list.
 */
export function effectiveRatio(
  finding: Finding,
  markedItems: ReadonlySet<string> | undefined,
): number {
  const { items, total } = finding;
  if (!markedItems || markedItems.size === 0 || !items || !total) {
    return finding.ratio;
  }
  const marked = items.filter((item) => markedItems.has(item.id));
  if (finding.affected === undefined) {
    return (items.length - marked.length) / total;
  }
  const affected = finding.affected - sumOf(marked, (item) => item.affected ?? 0);
  const population = total - sumOf(marked, (item) => item.measured ?? 0);
  // Everything that was measured is marked: nothing left to deduct for.
  if (population <= 0) {
    return 0;
  }
  /*
   * Never above the share that was measured. Both sides of the fraction shrink, and
   * an object that is less affected than the average takes more off the bottom than
   * off the top: marking a set of values that exists nine times over, out of a
   * hundred that mostly exist forty times over, raised the share from 92.47 % to
   * 92.86 %. Arithmetically that is the share of what is left, but it means the
   * score falls because an administrator called something intentional - and the
   * sentence explaining it would have read "-0.1 of those 71.2 points rest on that
   * decision". A decision may take something out of a measurement; it may not add
   * to it.
   */
  return Math.min(finding.ratio, affected / population);
}

function sumOf<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((sum, item) => sum + value(item), 0);
}

/**
 * A ratio is continuous in 0..1 by contract. Clamping here defends the
 * score's bounds against a check that violates the invariant; the raw ratio is
 * still visible on the finding itself, so the bug is not hidden.
 */
function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * Anything a check threw, as an Error with a readable message.
 *
 * `String({})` is `[object Object]`, which reads in a report as if the app had
 * nothing to say about its own failure.
 */
function asError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return new Error(JSON.stringify(err).slice(0, 300));
    } catch {
      return new Error('a value that is not an error was thrown');
    }
  }
  return new Error(String(err));
}
