import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runChecks, score } from '../src/engine.ts';
import { checksForStorage, outcomesFromRun } from '../src/stored-run.ts';
import type { StoredRun } from '../src/stored-run.ts';
import type { CheckDefinition, Finding, ScanContext } from '../src/types.ts';

/**
 * What the app keeps of a scan has one job: the page it renders again has to be the
 * page that was there. So the test that matters is the round trip - outcomes into
 * storage, out of storage, and the same score on the other side.
 *
 * The other tests pin what deliberately does not survive: accounts, and checks the
 * installed app no longer knows.
 */

const NOW = new Date('2026-08-11T00:00:00.000Z');

function ctx(): ScanContext {
  return {
    client: {} as ScanContext['client'],
    config: {} as ScanContext['config'],
    now: NOW,
  };
}

function definition(
  id: string,
  finding: Finding | null,
  extra: Partial<CheckDefinition> = {},
): CheckDefinition {
  return {
    id,
    category: 'portfolio',
    title: id,
    weight: 2,
    why: 'why',
    legitimateWhen: 'intentional in some setups',
    whatItInvolves: 'one setting',
    run: () => Promise.resolve(finding),
    ...extra,
  };
}

const dormant: Finding = {
  checkId: 'dormant',
  severity: 'high',
  headline: '3 of 40 projects saw no activity in a year',
  ratio: 0.075,
  total: 40,
  itemKind: 'project',
  evidence: [
    { label: 'Dormant projects', value: 3 },
    { label: 'Projects', value: 40 },
  ],
  items: [
    { id: '0-4', label: 'WEB', detail: 'no activity in 400 days' },
    { id: '0-9', label: 'OPS', target: 'OPS', detail: 'no activity in 380 days' },
    { id: '0-11', label: 'DOC' },
  ],
};

const accounts: Finding = {
  checkId: 'licences',
  severity: 'medium',
  headline: '2 of 10 licensed users changed nothing in 90 days',
  ratio: 0.2,
  itemKind: 'account',
  evidence: [{ label: 'Inactive users', value: 2 }],
  items: [
    { id: '1-5', label: 'j.doe', detail: 'no trace at all' },
    { id: '1-8', label: 'a.smith', detail: 'last change 2026-01-04' },
  ],
};

/* A finding whose objects weigh differently from one another. Its numbers decide
   the score of a marked object, so they have to survive storage. */
const cards: Finding = {
  checkId: 'cards',
  severity: 'critical',
  headline: '20 of 25 cards in progress have not moved',
  ratio: 0.8,
  affected: 20,
  total: 25,
  itemKind: 'board',
  evidence: [{ label: 'Boards with work in progress', value: 2 }],
  items: [
    { id: '99-1', label: 'Backlog board', detail: '18 of 18 cards', affected: 18, measured: 18 },
    { id: '99-2', label: 'Team board', detail: '2 of 7 cards', affected: 2, measured: 7 },
  ],
};

const CHECKS: CheckDefinition[] = [
  definition('dormant', dormant),
  definition('cards', cards, { category: 'process' }),
  definition('licences', accounts, { category: 'licensing', itemsNamePeople: true }),
  definition('clean', null),
];

function run(checks: StoredRun['checks']): StoredRun {
  return { at: NOW.toISOString(), requests: 412, seconds: 50, throttled: 0, checks };
}

test('a kept run renders the report it was made from', async () => {
  const outcomes = await runChecks(CHECKS, ctx());
  const restored = outcomesFromRun(run(checksForStorage(outcomes, CHECKS)), CHECKS);

  // The whole report is a function of the outcomes, so one comparison covers it.
  assert.deepEqual(
    score(restored),
    score(outcomes.map(o => {
      // Accounts are not kept, and the check that names them lists nothing.
      if (o.checkId !== 'licences' || !o.finding) {
        return o;
      }
      const { items: _dropped, ...unnamed } = o.finding;
      return { ...o, finding: unnamed };
    })),
  );

  const project = restored.find(o => o.checkId === 'dormant');
  assert.deepEqual(project?.finding?.items, dormant.items);
  assert.equal(project?.category, 'portfolio');
  assert.equal(project?.weight, 2);
});

test('a marked object keeps the weight it was measured with', async () => {
  const outcomes = await runChecks(CHECKS, ctx());
  const restored = outcomesFromRun(run(checksForStorage(outcomes, CHECKS)), CHECKS);
  const marked = new Map([['cards', new Set(['99-1'])]]);

  /* The board carrying 18 of the 25 cards is marked as intentional. Restored
     without its numbers, it would count as one board of two and the score would
     differ from the one the page showed before the reload. */
  assert.equal(
    score(restored, new Set(), marked).overallScore,
    score(outcomes, new Set(), marked).overallScore,
  );
  const kept = restored.find(o => o.checkId === 'cards');
  assert.deepEqual(kept?.finding?.items, cards.items);
  assert.equal(kept?.finding?.affected, 20);
});

test('the accounts of a check that names people are not part of a kept run', async () => {
  const outcomes = await runChecks(CHECKS, ctx());
  const stored = checksForStorage(outcomes, CHECKS);
  const licences = stored.find(c => c.id === 'licences');

  /* The number stays, and so does the sentence that states it - what a licence
     costs is not a secret. The names are the record that must not stay behind. */
  assert.equal(licences?.finding?.items, undefined);
  assert.equal(licences?.finding?.ratio, 0.2);
  assert.ok(!JSON.stringify(stored).includes('j.doe'));
});

test('a check the installed app no longer knows is left out', () => {
  const restored = outcomesFromRun(
    run([
      { id: 'dormant', status: 'finding', finding: { ...dormant, evidence: [] } },
      { id: 'retired', status: 'finding', finding: { ...dormant, evidence: [] } },
    ]),
    CHECKS,
  );

  /* Its weight and its category live in the catalog, and a score built on a guess
     for them would be a different score than the one that was stored. */
  assert.deepEqual(restored.map(o => o.checkId), ['dormant']);
});

test('a check without a measurement keeps the reason it had', async () => {
  const skipping = definition('empty', null, {
    run: () => Promise.reject(new Error('nothing to measure')),
  });
  const outcomes = await runChecks([skipping], ctx());
  const restored = outcomesFromRun(run(checksForStorage(outcomes, [skipping])), [skipping]);

  assert.equal(restored[0]?.status, 'failed');
  assert.equal(restored[0]?.reason, 'nothing to measure');
  assert.equal(restored[0]?.finding, null);
});

test('a stored check that contradicts itself is left out', () => {
  const restored = outcomesFromRun(
    run([
      { id: 'dormant', status: 'finding' },
      { id: 'clean', status: 'nonsense' as StoredRun['checks'][number]['status'] },
    ]),
    CHECKS,
  );

  // A finding that is not there cannot be scored, and an unknown status is not one.
  assert.deepEqual(restored, []);
});
