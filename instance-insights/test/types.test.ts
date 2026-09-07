import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_WEIGHT,
  DEFAULT_CONFIG,
  SEVERITY_FACTOR,
  share,
} from '../src/types.ts';
import type { Severity } from '../src/types.ts';

/**
 * These tests check no logic; they pin the constants the scoring model and the
 * report are built on. Changing a weight or a threshold silently would move every
 * customer's score, so it has to be a deliberate edit here as well.
 */

test('category weights are pinned, so a change is deliberate', () => {
  assert.deepEqual(CATEGORY_WEIGHT, {
    licensing: 3,
    fields: 2,
    process: 2,
    governance: 2,
    portfolio: 1,
  });
});

test('default thresholds are pinned, so a change is deliberate', () => {
  assert.equal(DEFAULT_CONFIG.inactiveUserDays, 90);
  assert.equal(DEFAULT_CONFIG.staleIssueDays, 180);
  assert.equal(DEFAULT_CONFIG.dormantProjectDays, 180);
  assert.equal(DEFAULT_CONFIG.emptyFieldThreshold, 0.95);
  assert.equal(DEFAULT_CONFIG.minIssuesForFieldCheck, 50);
  assert.equal(DEFAULT_CONFIG.unassignedThreshold, 0.2);
  assert.equal(DEFAULT_CONFIG.maxBoardColumns, 7);
  assert.equal(DEFAULT_CONFIG.minProjectIssues, 10);
});

test('severity factors decrease strictly and stay within 0..1', () => {
  const order: Severity[] = ['critical', 'high', 'medium', 'low'];
  const factors = order.map((s) => SEVERITY_FACTOR[s]);

  for (const f of factors) {
    assert.ok(f > 0 && f <= 1, `factor ${f} is not within 0..1`);
  }
  for (let i = 1; i < factors.length; i++) {
    assert.ok(
      factors[i]! < factors[i - 1]!,
      `${order[i]} must be smaller than ${order[i - 1]}`,
    );
  }
});

test('a share of two counts stays a share', () => {
  /* Both numbers come from a search, and the two searches are answered moments
     apart: a subset counted second can come back larger than the set counted
     first - an import of old issues in between is enough. The share is bounded
     because a ratio above one would break the score's contract. */
  assert.equal(share(3, 12), 0.25);
  assert.equal(share(15, 12), 1, 'a part larger than its whole is the whole');
  assert.equal(share(0, 0), 0, 'nothing measured is no share');
  assert.equal(share(5, 0), 0);
  assert.equal(share(-3, 12), 0);
});
