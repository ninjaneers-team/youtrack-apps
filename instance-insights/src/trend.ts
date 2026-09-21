/**
 * The score over time. This is what a nightly job would otherwise have produced;
 * an app package cannot declare scheduled execution, so the scans themselves are
 * the data points.
 *
 * Pure functions over the aggregates the backend stores, so the arithmetic and the
 * drawing are unit-tested instead of eyeballed in an iframe. The widgets only place
 * the result.
 */

import { plural } from './types.ts';

/**
 * What one check contributed to a scan.
 *
 * Check IDs are ours and a ratio is a number, so this is an aggregate like the rest
 * and may be stored. It is what makes a moved score explainable: without it the
 * trend can only say that the number changed, never what changed.
 */
export interface CheckAggregate {
  id: string;
  /** 'finding' | 'clean' | 'skipped' | 'failed', copied from the outcome. */
  status: string;
  /** 0 for a check that found nothing or did not run. */
  ratio: number;
}

/** One scan, reduced to the aggregates that may enter the app's storage. */
export interface ScanAggregate {
  score: number | null;
  /**
   * The score of the same scan with nothing marked as intentional.
   *
   * Kept because marking a finding revises the point rather than adding one: without
   * this number, a score that rose by a decision is indistinguishable from an
   * instance that improved. Absent in scans stored before the app kept it.
   */
  scoreAsMeasured?: number | null;
  findings: number;
  at: string;
  /** Per check. Absent in scans stored before the app kept this. */
  checks?: CheckAggregate[];
}

/**
 * What a stored scan scored before any finding was marked as intentional, or null
 * when that is the number already shown.
 *
 * Reopening a widget shows stored numbers and no findings, so a score that a
 * decision raised is indistinguishable from an instance that improved. Entries
 * stored before the app kept this carry nothing, and then there is nothing to say.
 */
export function scoreBeforeDecisions(entry: ScanAggregate): number | null {
  const measured = entry.scoreAsMeasured;
  if (measured === undefined || measured === null || entry.score === null) {
    return null;
  }
  return Math.round(measured * 10) === Math.round(entry.score * 10) ? null : measured;
}

/** How one check moved between two scans. */
export interface CheckChange {
  id: string;
  /** Ratio in the earlier scan, null if the check did not run or is new. */
  before: number | null;
  after: number | null;
  kind: 'new' | 'resolved' | 'better' | 'worse' | 'unchanged' | 'unmeasured';
  /**
   * What became of the check in the newer scan, or null if it was not in it.
   *
   * Carried so a report can tell "there was nothing to measure here" from "this
   * check hit an error" - a bare "did not run" reads as something going wrong.
   */
  status: string | null;
}

export interface TrendPoint {
  /** ISO timestamp of the scan. */
  at: string;
  score: number;
  /** The same scan before any finding was marked, or its score when none was. */
  measured: number;
}

export interface Trend {
  /** Oldest first - reading order for a chart. Only scans that produced a score. */
  points: TrendPoint[];
  /** Newest score minus the one before it. Null until two scans exist. */
  delta: number | null;
  /**
   * The same difference between the measured scores.
   *
   * This is the one a report states, because a trend is about the instance: a score
   * that rose because findings were marked as intentional did not rise from work on
   * the instance, and a line that says otherwise answers "did it get better" wrongly.
   */
  measuredDelta: number | null;
  /** True when any point scored differently before its decisions. */
  decided: boolean;
  /** Whole days between the two newest scans. Null until two scans exist. */
  daysBetween: number | null;
}

const DAY_MS = 86_400_000;

/** One percentage point of what a check measured: less is not a movement. */
const MOVED_AT_LEAST = 0.01;

/**
 * Turns stored history (newest first) into a trend.
 *
 * Scans without a score contributed no measurement - every check was skipped or
 * failed - so they are left out rather than drawn as a zero.
 */
export function trendFrom(history: readonly ScanAggregate[]): Trend {
  const scored = history.filter(
    (entry): entry is ScanAggregate & { score: number } => entry.score !== null,
  );
  const [newest, previous] = scored;
  const points = scored
    .map((entry) => ({
      at: entry.at,
      score: entry.score,
      measured: entry.scoreAsMeasured ?? entry.score,
    }))
    .reverse();
  return {
    points,
    delta: newest && previous ? newest.score - previous.score : null,
    measuredDelta:
      newest && previous
        ? (newest.scoreAsMeasured ?? newest.score) -
          (previous.scoreAsMeasured ?? previous.score)
        : null,
    decided: points.some((point) => point.measured !== point.score),
    daysBetween:
      newest && previous
        ? Math.round(
            (Date.parse(newest.at) - Date.parse(previous.at)) / DAY_MS,
          )
        : null,
  };
}

/**
 * What moved between the two newest scans that carry per-check data.
 *
 * This is the sentence an administrator actually wants from a trend: not that the
 * score fell, but which checks fell with it. Scans stored before the app kept
 * per-check data have no `checks`, so they are skipped rather than reported as a
 * set of brand-new findings.
 */
export function checkChanges(history: readonly ScanAggregate[]): CheckChange[] {
  const detailed = history.filter((entry) => entry.checks !== undefined);
  const [newest, previous] = detailed;
  if (!newest?.checks || !previous?.checks) {
    return [];
  }
  const before = new Map(previous.checks.map((c) => [c.id, c]));
  const after = new Map(newest.checks.map((c) => [c.id, c]));

  const ids = new Set([...before.keys(), ...after.keys()]);
  const changes: CheckChange[] = [];
  for (const id of ids) {
    // A check that did not run contributes nothing and reads as absent, which is
    // the truth: it neither improved nor got worse, it was not measured.
    const from = ran(before.get(id)) ? (before.get(id) as CheckAggregate).ratio : null;
    const to = ran(after.get(id)) ? (after.get(id) as CheckAggregate).ratio : null;
    changes.push({
      id,
      before: from,
      after: to,
      kind: changeKind(from, to),
      status: after.get(id)?.status ?? null,
    });
  }
  return changes;
}

function ran(entry: CheckAggregate | undefined): boolean {
  return entry !== undefined && entry.status !== 'skipped' && entry.status !== 'failed';
}

/**
 * What happened to one check between two scans.
 *
 * A whole percentage point, which is what the section says of the checks it leaves
 * out: "all 20 checks came back within a percentage point of before". Comparing the
 * rounded percentages instead only caught a movement of nothing at all - a line
 * reading "worse - 80 % -> 80 %" - and let a rounding boundary through as news: on
 * an instance with 2688 open issues one issue moves the share by four hundredths of
 * a point, which was reported as "improved - 81 % -> 80 %". That also contradicted
 * the score beside it, which says "unchanged", because four hundredths of a point of
 * one check is a thousandth of the hundred.
 *
 * Appearing and disappearing are judged on the measurement itself - a check that
 * starts to find something, or stops, is news at any share.
 *
 * A check that measured something before and nothing now is the one case that is
 * not a movement. Counted as a resolution, the report claimed work that never
 * happened: "resolved - Boards with no limit on work in progress: was 55 %" for a
 * check that found no board to look at this time.
 */
function changeKind(before: number | null, after: number | null): CheckChange['kind'] {
  /* Only a check that had something to report counts as no longer measured. One
     that was clean before and is unmeasured now has lost nothing, and a line about
     it in the movements would be noise; the list of unchanged checks says what
     became of it. */
  if (after === null) {
    return before !== null && before > 0 ? 'unmeasured' : 'unchanged';
  }
  const from = before ?? 0;
  const to = after;
  if (from === 0 && to > 0) {
    return 'new';
  }
  if (from > 0 && to === 0) {
    return 'resolved';
  }
  if (Math.abs(to - from) < MOVED_AT_LEAST) {
    return 'unchanged';
  }
  return to < from ? 'better' : 'worse';
}

/** What a comparison against the previous scan came out at. */
export interface Comparison {
  /** False when there is no earlier scan carrying per-check data to compare with. */
  compared: boolean;
  /** The checks that moved, worst movement first. */
  moved: CheckChange[];
  /**
   * The checks that measured exactly the same as before.
   *
   * Named, not counted: "all thirteen checks measured the same" raises the question
   * which thirteen, and a reader who cannot answer it cannot trust the sentence.
   */
  unchanged: CheckChange[];
}

/**
 * The comparison a report shows above its findings.
 *
 * `compared` matters as much as the list: an empty list with `compared: true` means
 * the instance held still, which is a result. Hiding the section in that case makes
 * "nothing moved" indistinguishable from "this app cannot tell you".
 */
export function compareScans(history: readonly ScanAggregate[]): Comparison {
  const changes = checkChanges(history);
  const moved = changes
    .filter((c) => c.kind !== 'unchanged')
    .sort((a, b) => (b.after ?? 0) - (b.before ?? 0) - ((a.after ?? 0) - (a.before ?? 0)));
  return {
    compared: changes.length > 0,
    moved,
    unchanged: changes.filter((c) => c.kind === 'unchanged'),
  };
}

/** Whole days between a scan and the moment it is looked at. */
export function daysSince(at: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(at)) / DAY_MS);
}

/** How long ago a scan ran, as a reader would say it. */
export function agePhrase(days: number): string {
  if (days <= 0) {
    return 'today';
  }
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The distance back to the scan being compared against. */
export function gapPhrase(days: number): string {
  if (days <= 0) {
    return 'from earlier today';
  }
  return days === 1 ? 'from yesterday' : `from ${days} days earlier`;
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_SECOND = 1000;

/**
 * How long a mark may stand before the scan behind it counts as gone.
 *
 * A scan that ends stores itself and its mark falls away with it, so a mark only
 * stays behind when the browser running it went away first. That leaves a warning
 * about a scan nobody is running, and the length of a scan is the only measure of
 * how long to believe one: ten times what the last one took, which on a large
 * instance is generous and on a small one is under the floor below. The floor
 * carries the first scan of all, when nothing has been measured yet.
 */
const MARK_STANDS_FOR_FACTOR = 10;
const MARK_STANDS_FOR_FLOOR_MS = 10 * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * The scan that is under way somewhere else, or null when none appears to be.
 *
 * Both widgets can scan, and two scans at once ask the instance everything twice.
 * A scan is recorded when it finishes, so a start that is newer than the newest
 * recorded scan is one that has not arrived yet. Advisory on purpose, and it expires:
 * a mark older than any scan could plausibly be belongs to a browser that closed
 * mid-scan, and warning about that scan forever teaches a reader to ignore the
 * warning. `lastScanSeconds` is what the last recorded scan took, so the limit comes
 * from this instance rather than from a number chosen in advance.
 */
export function scanUnderWay(
  started: string | null,
  newestScanAt: string | undefined,
  now: Date,
  lastScanSeconds: number | undefined,
): string | null {
  if (started === null) {
    return null;
  }
  if (newestScanAt !== undefined && started <= newestScanAt) {
    return null;
  }
  const standsFor = Math.max(
    MARK_STANDS_FOR_FLOOR_MS,
    (lastScanSeconds ?? 0) * MS_PER_SECOND * MARK_STANDS_FOR_FACTOR,
  );
  return now.getTime() - new Date(started).getTime() > standsFor ? null : started;
}

/**
 * How long ago something happened, in words, from seconds up to days.
 *
 * Finer than `agePhrase`, which counts days, because the age carries the meaning of
 * the sentence this goes into: "a moment ago" is a scan in flight, "three days ago"
 * is a mark left standing, and the reader has to tell them apart.
 */
export function agoPhrase(when: string, now: Date): string {
  const seconds = Math.floor((now.getTime() - new Date(when).getTime()) / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) {
    return seconds <= 1 ? 'a moment ago' : `${seconds} seconds ago`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${plural(minutes, 'minute')} ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${plural(hours, 'hour')} ago`;
  }
  return `${plural(Math.floor(hours / HOURS_PER_DAY), 'day')} ago`;
}

/** Smallest span the y axis may show, so a small move cannot look like a cliff. */
const MIN_AXIS_SPAN = 10;
/** Pixels two lines need between them to read as two. */
const MIN_LINE_GAP = 2;
const FULL_SCORE = 100;

export interface Sparkline {
  /** SVG path through the points. Empty when there is nothing to draw. */
  path: string;
  /** The measured scores, empty when no point differs from what is reported. */
  measuredPath: string;
  /** The score at the bottom of the axis. */
  from: number;
  /** The score at the top of the axis. */
  to: number;
}

/**
 * SVG path through the points, and the span of the axis it was drawn on.
 *
 * The axis follows the data rather than always covering 0 to 100: over 24 scans that
 * all sit near fifty, a full-range axis is a straight line, and a move of two points
 * - which is what one fixed finding looks like - is invisible. It cannot follow the
 * data closely either, because a scale fitted to two nearby values turns half a
 * point into a cliff. So the span is the data plus a margin, at least ten points
 * wide, and it is returned so the report can say which span it is showing. A zoomed
 * axis is honest as long as it is labelled.
 */
export function sparkline(
  points: readonly TrendPoint[],
  width: number,
  height: number,
): Sparkline {
  if (points.length < 2) {
    return { path: '', measuredPath: '', from: 0, to: FULL_SCORE };
  }
  const reported = points.map((p) => inRange(p.score));
  const measured = points.map((p) => inRange(p.measured));
  /* One axis for both lines. Scaling them separately would put the two scores of the
     same scan at different heights and make the gap between them meaningless. */
  const lowest = Math.min(...reported, ...measured);
  const highest = Math.max(...reported, ...measured);
  const margin = Math.max((MIN_AXIS_SPAN - (highest - lowest)) / 2, 1);
  const from = Math.max(0, Math.floor(lowest - margin));
  const to = Math.min(FULL_SCORE, Math.ceil(highest + margin));

  const line = (scores: readonly number[]): string =>
    pathOf(scores, from, to, width, height);
  return {
    path: line(reported),
    measuredPath: separable(reported, measured, from, to, height) ? line(measured) : '',
    from,
    to,
  };
}

/**
 * Whether a second line would be visible at all.
 *
 * Half a point on a twenty-five point axis is a pixel and a quarter, so two lines
 * that close merge into one and the legend would name a difference the chart does
 * not show. The numbers next to the chart state it instead.
 */
function separable(
  reported: readonly number[],
  measured: readonly number[],
  from: number,
  to: number,
  height: number,
): boolean {
  const perPoint = height / (to - from || 1);
  return reported.some(
    (score, index) =>
      Math.abs(score - (measured[index] ?? score)) * perPoint >= MIN_LINE_GAP,
  );
}

function inRange(score: number): number {
  return Math.min(Math.max(score, 0), FULL_SCORE);
}

function pathOf(
  scores: readonly number[],
  from: number,
  to: number,
  width: number,
  height: number,
): string {
  const span = to - from || 1;
  const step = width / (scores.length - 1);
  return scores
    .map((score, index) => {
      const x = index * step;
      const y = height - ((score - from) / span) * height;
      return `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`;
    })
    .join(' ');
}

const TWO_DECIMALS = 100;

function round(n: number): number {
  return Math.round(n * TWO_DECIMALS) / TWO_DECIMALS;
}
