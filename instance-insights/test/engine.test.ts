import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runScan, runChecks, score } from '../src/engine.ts';
import {
  CheckSkipped,
  ScanCancelled,
  ratioAboveThreshold,
  type Category,
  type CheckDefinition,
  type Finding,
  type ScanContext,
} from '../src/types.ts';

/**
 * These tests pin the scoring rules with stub checks, so the maths is
 * isolated from the catalog. The edge cases are the ones called out in the README:
 * everything skipped, a ratio exactly at the bound, a category with no ran check,
 * and a single failing check that must not abort the scan.
 */

const NOW = new Date('2026-08-11T00:00:00.000Z');

function ctx(): ScanContext {
  // The stubs never touch the client; a bare cast keeps the fixtures short.
  return { client: {} as ScanContext['client'], config: {} as ScanContext['config'], now: NOW };
}

interface StubOptions {
  category?: Category;
  weight?: number;
}

function stub(
  id: string,
  run: () => Promise<Finding | null>,
  opts: StubOptions = {},
): CheckDefinition {
  return {
    id,
    category: opts.category ?? 'fields',
    title: id,
    weight: opts.weight ?? 1,
    why: 'why',
    legitimateWhen: 'intentional in some setups',
    whatItInvolves: 'one setting, agreed with whoever owns the project',
    run,
  };
}

function oneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

function finding(id: string, ratio: number): Finding {
  return {
    checkId: id,
    severity: 'medium',
    headline: `${id} ${ratio}`,
    ratio,
    evidence: [],
  };
}

test('category score follows 100 - 100 x sum(deductions) / sum(weights of checks that ran)', async () => {
  const checks = [
    stub('a', async () => finding('a', 0.5), { category: 'fields', weight: 10 }),
    stub('b', async () => null, { category: 'fields', weight: 6 }),
  ];

  const result = await runScan(checks, ctx());

  // deductions = 10 * 0.5 = 5, weights that ran = 16 -> 100 - 100 * 5/16 = 68.75
  const fields = result.categories.find((c) => c.category === 'fields');
  assert.equal(fields?.deduction, 5);
  assert.equal(fields?.ranWeight, 16);
  assert.equal(fields?.score, 68.75);
  assert.equal(result.overallScore, 68.75);
});

test('a clean check counts toward the denominator and lifts the score', async () => {
  const withClean = await runScan(
    [
      stub('a', async () => finding('a', 1), { weight: 10 }),
      stub('b', async () => null, { weight: 10 }),
    ],
    ctx(),
  );
  // 10 * 1 over a ran weight of 20 -> 50
  assert.equal(withClean.overallScore, 50);
});

test('a failed check is excluded and never aborts the scan', async () => {
  const checks = [
    stub('a', async () => finding('a', 0.4), { weight: 10 }),
    stub('boom', async () => {
      throw new Error('API exploded');
    }, { weight: 10 }),
    stub('c', async () => finding('c', 0.2), { weight: 10 }),
  ];

  const result = await runScan(checks, ctx());

  assert.deepEqual(
    result.outcomes.map((o) => o.status),
    ['finding', 'failed', 'finding'],
  );
  assert.equal(result.outcomes[1]?.error?.message, 'API exploded');
  // Denominator is 20 (a, c), not 30: deductions = 4 + 2 = 6 -> 100 - 100 * 6/20 = 70
  assert.equal(result.overallScore, 70);
});

test('a skipped check is excluded from the denominator', async () => {
  const checks = [
    stub('a', async () => finding('a', 1), { weight: 4 }),
    stub('skip', async () => {
      throw new CheckSkipped('not applicable');
    }, { weight: 96 }),
  ];

  const result = await runScan(checks, ctx());

  assert.equal(result.outcomes[1]?.status, 'skipped');
  // Only 'a' ran -> 100 - 100 * (4 * 1)/4 = 0, the skipped check's weight is ignored.
  assert.equal(result.overallScore, 0);
});

test('a category with no ran check scores null and drops out of the overall', async () => {
  const checks = [
    stub('a', async () => finding('a', 0.5), { category: 'fields', weight: 10 }),
    stub('p', async () => {
      throw new Error('down');
    }, { category: 'portfolio', weight: 7 }),
  ];

  const result = await runScan(checks, ctx());

  const portfolio = result.categories.find((c) => c.category === 'portfolio');
  assert.equal(portfolio?.score, null);
  assert.equal(portfolio?.ranWeight, 0);
  // Overall ignores portfolio entirely -> equals the fields score, 50.
  assert.equal(result.overallScore, 50);
});

test('overall score is null when not a single check ran', async () => {
  const checks = [
    stub('x', async () => {
      throw new CheckSkipped('skip');
    }),
    stub('y', async () => {
      throw new Error('fail');
    }),
  ];

  const result = await runScan(checks, ctx());
  assert.equal(result.overallScore, null);
});

test('overall score is null for an empty check list', async () => {
  const result = await runScan([], ctx());
  assert.equal(result.overallScore, null);
  assert.deepEqual(result.categories, []);
});

test('ratio is clamped into 0..1 so the score stays bounded', async () => {
  const high = await runScan([stub('a', async () => finding('a', 1.5), { weight: 10 })], ctx());
  assert.equal(high.overallScore, 0);

  const low = await runScan([stub('a', async () => finding('a', -0.3), { weight: 10 })], ctx());
  assert.equal(low.overallScore, 100);
});

test('ratioAboveThreshold is zero at the threshold and one at full', () => {
  assert.equal(ratioAboveThreshold(0.2, 0.2), 0);
  assert.equal(ratioAboveThreshold(1, 0.2), 1);
  assert.ok(ratioAboveThreshold(0.3, 0.2) > 0 && ratioAboveThreshold(0.3, 0.2) < 0.2);
});

test('an ignored finding keeps its weight in the denominator but stops deducting', async () => {
  const checks = [
    stub('a', async () => finding('a', 1), { weight: 10 }),
    stub('b', async () => finding('b', 1), { weight: 10 }),
  ];

  const counted = await runScan(checks, ctx());
  // Both deduct fully: 20 over a ran weight of 20 -> 0.
  assert.equal(counted.overallScore, 0);

  const withIgnore = await runScan(checks, ctx(), new Set(['a']));
  // 'a' ran, so its weight stays: deduction 10 over ran weight 20 -> 50.
  assert.equal(withIgnore.overallScore, 50);
  assert.equal(withIgnore.categories[0]?.ranWeight, 20);
  assert.equal(withIgnore.categories[0]?.deduction, 10);
});

test('ignoring is not skipping: a skip drops the weight, an ignore keeps it', async () => {
  const ignoredRun = await runScan(
    [
      stub('a', async () => finding('a', 1), { weight: 10 }),
      stub('b', async () => finding('b', 1), { weight: 30 }),
    ],
    ctx(),
    new Set(['b']),
  );
  // ignore: deduction 10, denominator 40 -> 75
  assert.equal(ignoredRun.overallScore, 75);

  const skippedRun = await runScan(
    [
      stub('a', async () => finding('a', 1), { weight: 10 }),
      stub('b', async () => {
        throw new CheckSkipped('not applicable');
      }, { weight: 30 }),
    ],
    ctx(),
  );
  // skip: deduction 10, denominator 10 -> 0
  assert.equal(skippedRun.overallScore, 0);
});

test('an ignored finding is listed separately', async () => {
  const result = await runScan(
    [
      stub('a', async () => finding('a', 0.5)),
      stub('b', async () => finding('b', 0.5)),
    ],
    ctx(),
    new Set(['b']),
  );

  assert.deepEqual(result.findings.map((f) => f.checkId), ['a']);
  assert.deepEqual(result.ignoredFindings.map((f) => f.checkId), ['b']);
});

test('score() recomputes from outcomes without running the checks again', async () => {
  let runs = 0;
  const checks = [
    stub('a', async () => {
      runs++;
      return finding('a', 1);
    }, { weight: 10 }),
    stub('b', async () => {
      runs++;
      return null;
    }, { weight: 10 }),
  ];

  const outcomes = await runChecks(checks, ctx());
  assert.equal(runs, 2);

  assert.equal(score(outcomes).overallScore, 50);
  assert.equal(score(outcomes, new Set(['a'])).overallScore, 100);
  // Toggling ignores must not re-run a single check.
  assert.equal(runs, 2);
});

test('ignoring an id that produced no finding changes nothing', async () => {
  const checks = [stub('a', async () => finding('a', 0.5), { weight: 10 })];
  const plain = await runScan(checks, ctx());
  const withUnrelatedIgnore = await runScan(checks, ctx(), new Set(['does-not-exist']));
  assert.equal(withUnrelatedIgnore.overallScore, plain.overallScore);
});

test('progress is reported before each check and once at the end', async () => {
  const seen: string[] = [];
  const checks = [
    stub('a', async () => finding('a', 0.5)),
    stub('b', async () => finding('b', 0.5)),
  ];

  await runChecks(checks, ctx(), (state) => {
    seen.push(`${state.done}/${state.total} ${state.running ?? '-'}`);
  });

  // The name comes before the work, so a slow check does not look like a hang.
  assert.deepEqual(seen, ['0/2 a', '1/2 b', '2/2 -']);
});

test('a stopped scan keeps what it measured and scores only that', async () => {
  const finding = (ratio: number): Finding => ({
    checkId: 'x',
    severity: 'medium',
    headline: 'headline',
    ratio,
    evidence: [],
  });
  const checks = [
    stub('first', async () => ({ ...finding(0.5), checkId: 'first' }), { weight: 10 }),
    stub('stopped', async () => {
      throw new ScanCancelled();
    }),
    stub('never-reached', async () => {
      throw new Error('this check must not run');
    }),
  ];

  const result = await runScan(checks, ctx());

  assert.equal(result.findings.length, 1, 'the measured finding survives');
  for (const id of ['stopped', 'never-reached']) {
    const outcome = result.outcomes.find((o) => o.checkId === id);
    assert.equal(outcome?.status, 'skipped', `${id} did not run`);
    assert.equal(outcome?.reason, 'The scan was stopped.');
  }
  // Only the check that ran is in the denominator: 10 weight, ratio 0.5.
  assert.equal(result.categories[0]?.ranWeight, 10);
  assert.equal(result.overallScore, 50);
});

test('the score carries what it would be without any decision', async () => {
  const checks = [
    stub('a', async () => finding('a', 1), { weight: 10 }),
    stub('b', async () => finding('b', 1), { weight: 10 }),
  ];

  const counted = await runScan(checks, ctx());
  assert.equal(counted.overallScore, 0);
  // Nothing marked: the two numbers are the same, so no report has to explain one.
  assert.equal(counted.overallAsMeasured, 0);

  const withIgnore = await runScan(checks, ctx(), new Set(['a']));
  /* The reported score rose by a decision, and the measured one did not move: that
     difference is what a report states, so nobody looks for a change in the
     instance that never happened. */
  assert.equal(withIgnore.overallScore, 50);
  assert.equal(withIgnore.overallAsMeasured, 0);
});

test('a score of nothing measured has no measured counterpart either', async () => {
  const nothing = await runScan([], ctx(), new Set(['a']));

  assert.equal(nothing.overallScore, null);
  assert.equal(nothing.overallAsMeasured, null);
});

test('marking single objects recomputes the share from what is left', async () => {
  const withItems = stub(
    'a',
    async () => ({
      checkId: 'a',
      severity: 'high' as const,
      headline: '4 of 10 projects',
      ratio: 0.4,
      evidence: [],
      total: 10,
      items: [
        { id: 'p1', label: 'P1' },
        { id: 'p2', label: 'P2' },
        { id: 'p3', label: 'P3' },
        { id: 'p4', label: 'P4' },
      ],
    }),
    { weight: 10 },
  );

  const all = await runScan([withItems], ctx());
  // 10 * 0.4 over a ran weight of 10.
  assert.equal(all.overallScore, 60);

  const twoMarked = await runScan(
    [withItems],
    ctx(),
    new Set(),
    new Map([['a', new Set(['p1', 'p2'])]]),
  );
  /* Two of the four are deliberate, so the check measures 2 of 10 and takes away
     half of what it did: the weight stays, the share shrinks. */
  assert.equal(twoMarked.overallScore, 80);
  assert.equal(twoMarked.overallAsMeasured, 60);

  const allMarked = await runScan(
    [withItems],
    ctx(),
    new Set(),
    new Map([['a', new Set(['p1', 'p2', 'p3', 'p4'])]]),
  );
  // Every object deliberate is the same statement as marking the whole check.
  assert.equal(allMarked.overallScore, 100);
});

test('marking an object that weighs more takes its weight out, not one of a list', async () => {
  /* The aging-work-in-progress shape: 25 cards measured across boards, and one
     board carries 18 of them. Marking that board has to take 18 cards out of both
     sides of the share - as one of two items it would take out half. */
  const boards = stub(
    'a',
    async () => ({
      checkId: 'a',
      severity: 'critical' as const,
      headline: '20 of 25 cards',
      ratio: 0.8,
      evidence: [],
      affected: 20,
      total: 25,
      items: [
        { id: 'big', label: 'Backlog board', affected: 18, measured: 18 },
        { id: 'small', label: 'Team board', affected: 2, measured: 7 },
      ],
    }),
    { weight: 10 },
  );

  const all = await runScan([boards], ctx());
  assert.equal(all.overallScore, 20);

  const bigMarked = await runScan(
    [boards],
    ctx(),
    new Set(),
    new Map([['a', new Set(['big'])]]),
  );
  // 2 of the remaining 7 cards, so 10 * 2/7 comes off: not 10 * 1/2.
  assert.equal(oneDecimal(bigMarked.overallScore ?? 0), 71.4);
  assert.equal(bigMarked.overallAsMeasured, 20);

  const bothMarked = await runScan(
    [boards],
    ctx(),
    new Set(),
    new Map([['a', new Set(['big', 'small'])]]),
  );
  // Nothing measured is left, so there is nothing to deduct for.
  assert.equal(bothMarked.overallScore, 100);
});

test('a decision never costs points', async () => {
  /* The value-list shape: two sets of values that exist forty times over and one
     that exists nine times. The small one is less affected than the average, so
     taking it out of both sides of the share leaves a *higher* share behind - 92.47
     % became 92.86 %, the score fell, and the sentence about it would have read
     "-0.1 of those points rest on that decision". A decision may take something out
     of a measurement; it may not add to it. */
  const lists = stub(
    'a',
    async () => ({
      checkId: 'a',
      severity: 'critical' as const,
      headline: '86 of 93 value lists are a copy',
      ratio: 86 / 93,
      evidence: [],
      affected: 86,
      total: 93,
      items: [
        { id: 'big', label: 'Type', affected: 39, measured: 40 },
        { id: 'other', label: 'Priority', affected: 39, measured: 40 },
        { id: 'small', label: 'Severity', affected: 8, measured: 9 },
      ],
    }),
    { weight: 10 },
  );

  const measured = await runScan([lists], ctx());
  const decided = await runScan(
    [lists],
    ctx(),
    new Set(),
    new Map([['a', new Set(['small'])]]),
  );

  assert.ok(
    (decided.overallScore ?? 0) >= (measured.overallScore ?? 0),
    `${decided.overallScore} should not be below ${measured.overallScore}`,
  );
  assert.equal(decided.overallScore, measured.overallScore);
  // Marking one that weighs more than the average still pays off.
  const better = await runScan(
    [lists],
    ctx(),
    new Set(),
    new Map([['a', new Set(['big'])]]),
  );
  assert.ok((better.overallScore ?? 0) > (measured.overallScore ?? 0));
});

test('marking an object can shrink the count without shrinking the population', async () => {
  /* The inconsistent-field-names shape: 3 of 40 fields repeat a name, listed as
     groups of names. A group marked intentional stops counting, but its fields are
     still fields - the population is all of them. */
  const groups = stub(
    'a',
    async () => ({
      checkId: 'a',
      severity: 'low' as const,
      headline: '3 of 40 custom fields',
      ratio: 0.075,
      evidence: [],
      affected: 3,
      total: 40,
      items: [
        { id: 'priority', label: 'Priority / Prioritaet', affected: 1, measured: 0 },
        { id: 'estimate', label: 'Estimate / Estimation / Est', affected: 2, measured: 0 },
      ],
    }),
    { weight: 10 },
  );

  const marked = await runScan(
    [groups],
    ctx(),
    new Set(),
    new Map([['a', new Set(['estimate'])]]),
  );

  // 1 of 40, not 1 of 38: nothing left the instance.
  assert.equal(oneDecimal(marked.overallScore ?? 0), 97.5);
});

test('an object the scan no longer finds is not still being excluded', async () => {
  const check = stub(
    'a',
    async () => ({
      checkId: 'a',
      severity: 'high' as const,
      headline: '1 of 10 projects',
      ratio: 0.1,
      evidence: [],
      total: 10,
      items: [{ id: 'p1', label: 'P1' }],
    }),
    { weight: 10 },
  );

  // 'gone' was marked once and has since been archived, so it is in no finding.
  const result = await runScan(
    [check],
    ctx(),
    new Set(),
    new Map([['a', new Set(['gone'])]]),
  );

  assert.equal(result.overallScore, 90, 'the one project still found still counts');
});

test('a finding without a population can only be marked as a whole', async () => {
  // Counted findings - "989 open issues" - name no objects to point at.
  const counted = stub('a', async () => finding('a', 0.5), { weight: 10 });

  const marked = await runScan(
    [counted],
    ctx(),
    new Set(),
    new Map([['a', new Set(['whatever'])]]),
  );

  assert.equal(marked.overallScore, 50, 'the measured share stands');
});
