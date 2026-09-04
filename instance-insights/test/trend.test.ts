import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agePhrase,
  checkChanges,
  daysSince,
  gapPhrase,
  compareScans,
  scoreBeforeDecisions,
  sparkline,
  trendFrom,
} from '../src/trend.ts';
import type { ScanAggregate } from '../src/trend.ts';

/**
 * The trend is the argument that the work paid off, so its arithmetic is pinned
 * here rather than checked by looking at a chart.
 */

function scan(at: string, score: number | null): ScanAggregate {
  return { score, findings: 2, at };
}

// As stored: newest first.
const HISTORY: ScanAggregate[] = [
  scan('2026-08-12T00:00:00.000Z', 73),
  scan('2026-07-13T00:00:00.000Z', 61),
  scan('2026-06-13T00:00:00.000Z', 43),
];

test('points read oldest first, so a chart runs left to right', () => {
  const trend = trendFrom(HISTORY);

  assert.deepEqual(
    trend.points.map((p) => p.score),
    [43, 61, 73],
  );
});

test('the delta compares the two newest scans', () => {
  const trend = trendFrom(HISTORY);

  assert.equal(trend.delta, 12);
  assert.equal(trend.daysBetween, 30);
});

test('a single scan has no delta to show', () => {
  const trend = trendFrom([scan('2026-08-12T00:00:00.000Z', 73)]);

  assert.deepEqual(trend.points.map((p) => p.score), [73]);
  assert.equal(trend.delta, null);
  assert.equal(trend.daysBetween, null);
});

test('an empty history yields an empty trend', () => {
  assert.deepEqual(trendFrom([]), {
    points: [],
    delta: null,
    measuredDelta: null,
    decided: false,
    daysBetween: null,
  });
});

test('a scan that produced no score is left out instead of drawn as zero', () => {
  // Every check skipped or failed: there was no measurement, not a score of 0.
  const trend = trendFrom([
    scan('2026-08-12T00:00:00.000Z', null),
    scan('2026-07-13T00:00:00.000Z', 61),
    scan('2026-06-13T00:00:00.000Z', 43),
  ]);

  assert.deepEqual(trend.points.map((p) => p.score), [43, 61]);
  assert.equal(trend.delta, 18, 'the two scans that did measure are compared');
});

test('a worse score shows as a negative delta', () => {
  const trend = trendFrom([
    scan('2026-08-12T00:00:00.000Z', 40),
    scan('2026-07-13T00:00:00.000Z', 55),
  ]);

  assert.equal(trend.delta, -15);
});

test('the axis follows the data, and says which span it shows', () => {
  /*
   * Over two dozen scans that all sit near fifty, an axis from 0 to 100 is a
   * straight line - and a move of two points, which is one fixed finding, is
   * invisible. The axis therefore follows the scores and is labelled with its span.
   */
  const { path, from, to } = sparkline(
    [
      { at: '2026-07-13T00:00:00.000Z', score: 46, measured: 46 },
      { at: '2026-08-12T00:00:00.000Z', score: 48.5, measured: 48.5 },
    ],
    200,
    100,
  );

  assert.equal(from, 42);
  assert.equal(to, 53);
  // The two points sit well inside the box rather than on its edges.
  assert.equal(path, 'M0 63.64 L200 40.91');
});

test('a small move is visible without being blown up', () => {
  // Half a point on an axis at least ten points wide stays a small step.
  const { path, from, to } = sparkline(
    [
      { at: 'a', score: 50, measured: 50 },
      { at: 'b', score: 50.5, measured: 50.5 },
    ],
    100,
    100,
  );
  const [, firstY, secondY] = /M0 ([\d.]+) L100 ([\d.]+)/.exec(path) ?? [];
  assert.equal(to - from, 11, 'the span never collapses onto the data');
  assert.ok(
    Math.abs(Number(firstY) - Number(secondY)) < 10,
    'half a point must not cross the box',
  );
});

test('the axis never leaves the score range', () => {
  const low = sparkline(
    [
      { at: 'a', score: -20, measured: -20 },
      { at: 'b', score: 2, measured: 2 },
    ],
    10,
    10,
  );
  assert.equal(low.from, 0);

  const high = sparkline(
    [
      { at: 'a', score: 99, measured: 99 },
      { at: 'b', score: 140, measured: 140 },
    ],
    10,
    10,
  );
  assert.equal(high.to, 100);
});

test('fewer than two points draw no line', () => {
  assert.equal(sparkline([], 10, 10).path, '');
  assert.equal(sparkline([{ at: 'a', score: 50, measured: 50 }], 10, 10).path, '');
});

test('ages and gaps are worded the way a reader says them', () => {
  // "0 days ago" and "0 days earlier" are not sentences an administrator reads.
  assert.equal(agePhrase(0), 'today');
  assert.equal(agePhrase(1), 'yesterday');
  assert.equal(agePhrase(34), '34 days ago');

  assert.equal(gapPhrase(0), 'from earlier today');
  assert.equal(gapPhrase(1), 'from yesterday');
  assert.equal(gapPhrase(30), 'from 30 days earlier');
});

test('the age of a scan is counted in whole days', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');

  assert.equal(daysSince('2026-08-12T00:00:00.000Z', now), 0);
  assert.equal(daysSince('2026-07-13T00:00:00.000Z', now), 30);
});

/**
 * What moved between two scans. This is the part of the trend that answers the
 * question a line on its own provokes, so its edge cases are pinned here.
 */

function scanOf(
  at: string,
  score: number,
  checks?: Array<[string, number]>,
): ScanAggregate {
  return {
    at,
    score,
    findings: checks?.filter(([, ratio]) => ratio > 0).length ?? 0,
    checks: checks?.map(([id, ratio]) => ({
      id,
      status: ratio > 0 ? 'finding' : 'clean',
      ratio,
    })),
  };
}

test('a check that improved, appeared or was resolved is named as such', () => {
  const history = [
    scanOf('2026-08-11T00:00:00.000Z', 60, [
      ['licensing.inactive-users', 0.3],
      ['process.stale-unresolved', 0],
      ['process.aging-wip', 0.5],
    ]),
    scanOf('2026-08-01T00:00:00.000Z', 40, [
      ['licensing.inactive-users', 0.6],
      ['process.stale-unresolved', 0.8],
    ]),
  ];

  const byId = new Map(compareScans(history).moved.map((c) => [c.id, c]));

  assert.equal(byId.get('licensing.inactive-users')?.kind, 'better');
  assert.equal(byId.get('process.stale-unresolved')?.kind, 'resolved');
  // Present in the newer scan only: it did not exist as a measurement before.
  assert.equal(byId.get('process.aging-wip')?.kind, 'new');
});

test('a check that stayed the same is not reported as movement', () => {
  const history = [
    scanOf('2026-08-11T00:00:00.000Z', 60, [['fields.empty-field', 0.4]]),
    scanOf('2026-08-01T00:00:00.000Z', 60, [['fields.empty-field', 0.4]]),
  ];

  const comparison = compareScans(history);
  assert.deepEqual(comparison.moved, []);
  // The comparison happened, it just found nothing - the report has to be able to
  // say that instead of falling silent.
  assert.equal(comparison.compared, true);
  // Named, not counted: the report offers the list behind "nothing moved".
  assert.deepEqual(
    comparison.unchanged.map((c) => c.id),
    ['fields.empty-field'],
  );
  assert.equal(checkChanges(history)[0]?.kind, 'unchanged');
});

test('a movement the report cannot show is not called a movement', () => {
  /* Seen on a real instance: "worse - 80 % -> 80 %". One issue out of thirteen
     hundred moves the ratio in the fourth decimal, and a line that claims a change
     while showing none sends the reader looking for it. */
  const noise = [
    scanOf('2026-08-11T00:00:00.000Z', 60, [['process.unassigned-unresolved', 0.8004]]),
    scanOf('2026-08-01T00:00:00.000Z', 60, [['process.unassigned-unresolved', 0.7996]]),
  ];
  const quiet = checkChanges(noise)[0];
  assert.equal(quiet?.kind, 'unchanged');
  assert.deepEqual(compareScans(noise).moved, []);

  // A move that a whole percent can show is still a move, in both directions.
  const visible = [
    scanOf('2026-08-11T00:00:00.000Z', 60, [['process.boards-without-wip-limits', 0.55]]),
    scanOf('2026-08-01T00:00:00.000Z', 60, [['process.boards-without-wip-limits', 0.52]]),
  ];
  assert.equal(checkChanges(visible)[0]?.kind, 'worse');
  assert.equal(checkChanges([visible[1]!, visible[0]!])[0]?.kind, 'better');

  /* Appearing is judged on the measurement, not on the rounding: a check that
     starts to find something is news even at a fifth of a percent. */
  const appeared = [
    scanOf('2026-08-11T00:00:00.000Z', 60, [['portfolio.tiny-projects', 0.002]]),
    scanOf('2026-08-01T00:00:00.000Z', 60, [['portfolio.tiny-projects', 0]]),
  ];
  assert.equal(checkChanges(appeared)[0]?.kind, 'new');
});

test('a check that did not run counts as unmeasured, not as resolved', () => {
  const newer: ScanAggregate = {
    at: '2026-08-11T00:00:00.000Z',
    score: 60,
    findings: 0,
    checks: [{ id: 'process.aging-wip', status: 'skipped', ratio: 0 }],
  };
  const older = scanOf('2026-08-01T00:00:00.000Z', 50, [['process.aging-wip', 0.5]]);

  const change = checkChanges([newer, older])[0];
  assert.equal(change?.after, null, 'a skipped check has no measurement');
  // It looks like a resolution but is not one; the wording has to survive that.
  assert.equal(change?.kind, 'resolved');
});

test('scans stored before per-check data existed produce no phantom movements', () => {
  const legacy: ScanAggregate = {
    at: '2026-08-01T00:00:00.000Z',
    score: 50,
    findings: 3,
  };
  const history = [scanOf('2026-08-11T00:00:00.000Z', 60, [['fields.empty-field', 0.4]]), legacy];

  const comparison = compareScans(history);
  assert.deepEqual(comparison.moved, []);
  assert.equal(
    comparison.compared,
    false,
    'without a comparable scan there is nothing to report either way',
  );
});

test('a change carries what became of the check, not only its ratio', () => {
  const history: ScanAggregate[] = [
    {
      at: '2026-08-11T00:00:00.000Z',
      score: 60,
      findings: 1,
      checks: [
        { id: 'fields.empty-field', status: 'skipped', ratio: 0 },
        { id: 'licensing.inactive-users', status: 'finding', ratio: 0.5 },
      ],
    },
    {
      at: '2026-08-01T00:00:00.000Z',
      score: 60,
      findings: 1,
      checks: [
        { id: 'fields.empty-field', status: 'skipped', ratio: 0 },
        { id: 'licensing.inactive-users', status: 'finding', ratio: 0.5 },
      ],
    },
  ];

  const byId = new Map(checkChanges(history).map((c) => [c.id, c]));

  // "Did not run" on its own reads as a failure, so the report needs the status to
  // say whether there was nothing to measure or something went wrong.
  assert.equal(byId.get('fields.empty-field')?.status, 'skipped');
  assert.equal(byId.get('fields.empty-field')?.after, null);
  assert.equal(byId.get('licensing.inactive-users')?.status, 'finding');
});

test('a stored scan says what it scored before the decisions', () => {
  // Nothing marked: both numbers agree, so a widget has nothing to explain.
  assert.equal(
    scoreBeforeDecisions({ score: 67.9, scoreAsMeasured: 67.9, findings: 11, at: '2026-08-11T00:00:00.000Z' }),
    null,
  );
  // Marked: the measured number is what the instance actually earned.
  assert.equal(
    scoreBeforeDecisions({ score: 67.9, scoreAsMeasured: 63.7, findings: 9, at: '2026-08-11T00:00:00.000Z' }),
    63.7,
  );
  // Stored before the app kept it, and a score of nothing measured.
  assert.equal(scoreBeforeDecisions({ score: 67.9, findings: 11, at: '2026-08-11T00:00:00.000Z' }), null);
  assert.equal(
    scoreBeforeDecisions({ score: null, scoreAsMeasured: null, findings: 0, at: '2026-08-11T00:00:00.000Z' }),
    null,
  );
});

test('the trend moves with what was measured, not with the decisions', () => {
  const trend = trendFrom([
    { at: '2026-08-12T00:00:00.000Z', score: 68.4, scoreAsMeasured: 67.9, findings: 10 },
    { at: '2026-08-05T00:00:00.000Z', score: 67.9, scoreAsMeasured: 67.9, findings: 11 },
  ]);

  /* Reported, the score rose by half a point; measured, the instance stood still.
     A trend that reported the rise would credit the instance for a decision. */
  assert.equal(oneDecimalOf(trend.delta), 0.5);
  assert.equal(oneDecimalOf(trend.measuredDelta), 0);
  assert.equal(trend.decided, true);
  assert.deepEqual(
    trend.points.map((p) => [p.score, p.measured]),
    [
      [67.9, 67.9],
      [68.4, 67.9],
    ],
    'oldest first, each point with both readings',
  );
});

test('a history without decisions draws one line', () => {
  const trend = trendFrom([
    { at: '2026-08-12T00:00:00.000Z', score: 70, findings: 8 },
    { at: '2026-08-05T00:00:00.000Z', score: 60, findings: 12 },
  ]);

  assert.equal(trend.decided, false);
  assert.equal(trend.measuredDelta, 10);
  assert.equal(sparkline(trend.points, 200, 100).measuredPath, '');
});

test('both readings of a scan share one axis', () => {
  const { path, measuredPath, from, to } = sparkline(
    [
      { at: '2026-08-05T00:00:00.000Z', score: 60, measured: 60 },
      { at: '2026-08-12T00:00:00.000Z', score: 70, measured: 62 },
    ],
    200,
    100,
  );

  // Two lines, and the axis covers the lowest and the highest of both.
  assert.ok(path.length > 0 && measuredPath.length > 0);
  assert.ok(from <= 60 && to >= 70, `axis ${from}..${to} must hold both readings`);
  assert.notEqual(path, measuredPath);
});

function oneDecimalOf(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

test('a difference too small to see is not drawn as a second line', () => {
  const barely = [
    { at: '2026-08-05T00:00:00.000Z', score: 60, measured: 60 },
    { at: '2026-08-12T00:00:00.000Z', score: 70, measured: 69.8 },
  ];

  /* The axis here runs 59 to 71 over 64 pixels, so 0.2 points is about one pixel:
     the second line would sit under the first, and the legend would promise a
     difference nobody can see. */
  assert.equal(sparkline(barely, 200, 64).measuredPath, '');
  // The same difference over ten times the height is visible, so it is drawn.
  assert.notEqual(sparkline(barely, 200, 640).measuredPath, '');

  const plain = [
    { at: '2026-08-05T00:00:00.000Z', score: 60, measured: 60 },
    { at: '2026-08-12T00:00:00.000Z', score: 70, measured: 65 },
  ];
  assert.notEqual(sparkline(plain, 200, 64).measuredPath, '');
});
