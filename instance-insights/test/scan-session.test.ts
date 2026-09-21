import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from '../src/checks/catalog.ts';
import { startScan } from '../src/scan-session.ts';
import type { ScanClientHooks, ScanStore } from '../src/scan-session.ts';
import type { ScanUpload } from '../src/stored-run.ts';
import type { ScanAggregate } from '../src/trend.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import type { YouTrackClient } from '../src/types.ts';
import { syntheticInstance } from './mock-client.ts';

/**
 * Both widgets scan through this, so what is pinned here is the order around a
 * scan: that a scan says it is under way and says so no longer, that what is kept
 * carries the decisions an administrator made, and that a scan which measured only
 * part of an instance is not kept at all.
 */

const STARTED = new Date('2026-08-11T09:00:00.000Z');
const FINISHED = new Date('2026-08-11T09:00:12.000Z');

interface Recorded {
  marks: Array<{ at: string; done: boolean }>;
  uploads: ScanUpload[];
}

function storeThat(saving?: () => never): { store: ScanStore; recorded: Recorded } {
  const recorded: Recorded = { marks: [], uploads: [] };
  const store: ScanStore = {
    async markScan(at: string, done: boolean): Promise<void> {
      recorded.marks.push({ at, done });
    },
    async saveScan(upload: ScanUpload): Promise<ScanAggregate[]> {
      recorded.uploads.push(upload);
      saving?.();
      return [{ score: upload.score, findings: upload.findings, at: upload.at }];
    },
  };
  return { store, recorded };
}

/** A client of the synthetic instance that reports what a real one would report. */
function clientOf(hooks: ScanClientHooks): YouTrackClient {
  hooks.onRequest(31);
  hooks.onThrottle(2);
  return syntheticInstance(STARTED);
}

function session(
  store: ScanStore,
  decisions: { checks: ReadonlySet<string>; items: Map<string, Set<string>> } = {
    checks: new Set(),
    items: new Map(),
  },
  stateRead = true,
) {
  return startScan({
    checks: CHECKS,
    config: DEFAULT_CONFIG,
    store,
    client: clientOf,
    decisions,
    stateRead,
    startedAt: STARTED,
    now: () => FINISHED,
  });
}

test('a whole scan is kept, with what it cost', async () => {
  const { store, recorded } = storeThat();
  const run = await session(store).done;

  assert.equal(run.fate, 'kept');
  assert.equal(run.stopped, false);
  assert.deepEqual(run.cost, { requests: 31, seconds: 12, throttled: 2 });
  assert.equal(recorded.uploads.length, 1);
  assert.equal(recorded.uploads[0]?.at, FINISHED.toISOString());
  assert.equal(recorded.uploads[0]?.checks.length, CHECKS.length);
  assert.ok(run.history);
});

test('a scan says it is under way and, however it ended, that it is not', async () => {
  const { store, recorded } = storeThat();
  await session(store).done;

  assert.deepEqual(recorded.marks, [
    { at: STARTED.toISOString(), done: false },
    { at: STARTED.toISOString(), done: true },
  ]);
});

test('a scan whose result cannot be stored still takes its mark off', async () => {
  const { store, recorded } = storeThat(() => {
    throw new Error('storage refused');
  });

  await assert.rejects(session(store).done, /storage refused/);
  // Or the app would claim a scan is under way until someone reinstalls it.
  assert.deepEqual(recorded.marks.at(-1), { at: STARTED.toISOString(), done: true });
});

test('a stopped scan is not kept anywhere', async () => {
  const { store, recorded } = storeThat();
  const handle = session(store);
  handle.stop();
  const run = await handle.done;

  /* It measured part of the instance. Its score would sit on the trend beside the
     scores of whole ones, and the next visit would read it as the last report. */
  assert.equal(run.stopped, true);
  assert.equal(run.fate, 'partial');
  assert.equal(run.history, null);
  assert.deepEqual(recorded.uploads, []);
  // What it did measure is still reported to the widget that asked for it.
  assert.ok(run.outcomes.length > 0);
});

test('a scan started without the standing decisions is not kept', async () => {
  const { store, recorded } = storeThat();
  const run = await session(store, { checks: new Set(), items: new Map() }, false).done;

  assert.equal(run.fate, 'stateUnreadable');
  assert.deepEqual(recorded.uploads, []);
  assert.ok(run.outcomes.length > 0);
});

test('what is kept carries the decisions, not just the measurement', async () => {
  const ignored = 'licensing.inactive-users';
  const { store, recorded } = storeThat();
  const run = await session(store, { checks: new Set([ignored]), items: new Map() }).done;

  const upload = recorded.uploads[0];
  assert.ok(upload && upload.score !== null && upload.scoreAsMeasured !== null);
  /* The strongest finding of the synthetic instance is marked as intentional, so
     the stored score is above what the instance measures - and both numbers are
     stored, because a score that rests on a decision has to be readable as one. */
  assert.ok(upload.score > upload.scoreAsMeasured);
  assert.equal(run.fate, 'kept');
});
