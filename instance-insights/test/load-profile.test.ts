import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runScan } from '../src/engine.ts';
import { CHECKS } from '../src/checks/catalog.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import { CountingClient, SHAPES } from '../scripts/load-profile.ts';
import type { Shape } from '../scripts/load-profile.ts';

/**
 * The README tells an administrator what a scan will cost their instance: a table
 * of four sizes, and a rule they can apply to their own. Both are claims about this
 * code, and a check added to the catalog changes them without touching the sentence
 * that states them - which is how all four numbers came to be one short.
 */

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const NOW = new Date('2026-09-01T00:00:00.000Z');

/** The rule the README states in words, as arithmetic. */
const PER_ACCOUNT = 1;
const PER_PROJECT = 2;
const PER_BOARD = 1;
const PER_FIELD = 2;
/** The lists this app reads, plus the counts it asks once for the whole instance. */
const FLAT = 17;

function requestsFor(shape: Shape): number {
  return (
    PER_ACCOUNT * shape.users +
    PER_PROJECT * shape.projects +
    PER_BOARD * shape.boards +
    PER_FIELD * shape.fields +
    FLAT
  );
}

async function measuredRequests(shape: Shape): Promise<number> {
  const client = new CountingClient(shape, NOW);
  await runScan(CHECKS, { client, config: DEFAULT_CONFIG, now: NOW });
  return Object.values(client.calls).reduce((a, b) => a + b, 0);
}

/** A figure as the README writes it: a space groups the thousands. */
function asWritten(count: number): string {
  return count.toLocaleString('en-US').replace(',', ' ');
}

function readmeRow(shape: Shape): { requests: number; line: string } {
  const wanted = new RegExp(
    `^\\| ${asWritten(shape.users)} accounts - ${asWritten(shape.projects)} projects ` +
      `- ${shape.boards} boards - ${shape.fields} fields \\| ([\\d ]+) \\|$`,
    'm',
  );
  const found = wanted.exec(README);
  assert.ok(found, `the README states no request count for ${JSON.stringify(shape)}`);
  return { requests: Number((found[1] ?? '').replace(/\s/g, '')), line: found[0] };
}

for (const shape of SHAPES) {
  test(`the README states what a scan of ${shape.users} accounts costs, to the request`, async () => {
    const measured = await measuredRequests(shape);
    const stated = readmeRow(shape);
    assert.equal(stated.requests, measured, `${stated.line} - the scan makes ${measured}`);
  });
}

test('the rule the README gives reproduces every count in its table', async () => {
  for (const shape of SHAPES) {
    assert.equal(requestsFor(shape), await measuredRequests(shape));
  }
});

test('each part of an instance costs what the rule says it costs', async () => {
  /* A rule checked only against totals can be wrong twice and still add up. This
     grows one part of the instance at a time, so each factor answers for itself. */
  const base: Shape = { users: 100, projects: 50, boards: 20, columnsPerBoard: 6, fields: 40 };
  const flat = await measuredRequests(base);
  const step = 10;
  const perUnit: Array<[keyof Shape, number]> = [
    ['users', PER_ACCOUNT],
    ['projects', PER_PROJECT],
    ['boards', PER_BOARD],
    ['fields', PER_FIELD],
    // A board's cards are counted for the board at once, so a column is free.
    ['columnsPerBoard', 0],
  ];
  for (const [part, cost] of perUnit) {
    const grown = await measuredRequests({ ...base, [part]: base[part] + step });
    assert.equal((grown - flat) / step, cost, `${step} more ${part}`);
  }
});
