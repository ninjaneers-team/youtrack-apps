import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agoPhrase, scanUnderWay } from '../src/trend.ts';

/**
 * Both widgets can scan, and two scans at once ask the instance everything twice.
 * What holds the second one back is a sentence, not a lock - so these tests are
 * about when that sentence appears, what it says, and when it stops appearing.
 */

const NOW = new Date('2026-08-11T12:00:00.000Z');
/** What the last recorded scan of this instance took, in seconds. */
const LAST_SCAN_TOOK = 13;

test('no mark, nothing under way', () => {
  assert.equal(scanUnderWay(null, undefined, NOW, LAST_SCAN_TOOK), null);
  assert.equal(scanUnderWay(null, '2026-08-01T09:00:00.000Z', NOW, LAST_SCAN_TOOK), null);
});

test('a mark newer than the newest recorded scan is a scan still running', () => {
  const started = '2026-08-11T11:59:50.000Z';
  assert.equal(scanUnderWay(started, undefined, NOW, LAST_SCAN_TOOK), started);
  assert.equal(scanUnderWay(started, '2026-08-01T09:00:00.000Z', NOW, LAST_SCAN_TOOK), started);
});

test('a scan that arrived answers its own mark', () => {
  /* A scan is recorded when it finishes, so its timestamp is later than its start.
     Without this, a finished scan whose mark was never cleared - a browser that
     went away between the two calls - would report itself as still running. */
  assert.equal(
    scanUnderWay('2026-08-11T11:00:00.000Z', '2026-08-11T11:02:30.000Z', NOW, LAST_SCAN_TOOK),
    null,
  );
});

test('a mark outlives its scan, and then stops being one', () => {
  /* A browser closed mid-scan leaves the mark behind, and nothing else takes it off:
     the next scan to finish overwrites it, but until then the report would warn
     about a scan nobody is running. Ten minutes is the floor, which is what holds
     while the last scan of this instance took thirteen seconds. */
  const nineMinutes = '2026-08-11T11:51:00.000Z';
  const elevenMinutes = '2026-08-11T11:49:00.000Z';
  assert.equal(scanUnderWay(nineMinutes, undefined, NOW, LAST_SCAN_TOOK), nineMinutes);
  assert.equal(scanUnderWay(elevenMinutes, undefined, NOW, LAST_SCAN_TOOK), null);
});

test('a slow instance keeps its mark longer, because its scans take longer', () => {
  /* Ten times the last scan, so an instance whose scan takes twenty minutes is not
     told after ten that the scan it is running does not exist. */
  const twentyMinuteScan = 20 * 60;
  const halfAnHourAgo = '2026-08-11T11:30:00.000Z';
  assert.equal(scanUnderWay(halfAnHourAgo, undefined, NOW, twentyMinuteScan), halfAnHourAgo);
  assert.equal(scanUnderWay(halfAnHourAgo, undefined, NOW, LAST_SCAN_TOOK), null);
});

test('before the first scan there is nothing to measure, so the floor decides', () => {
  const nineMinutes = '2026-08-11T11:51:00.000Z';
  const elevenMinutes = '2026-08-11T11:49:00.000Z';
  assert.equal(scanUnderWay(nineMinutes, undefined, NOW, undefined), nineMinutes);
  assert.equal(scanUnderWay(elevenMinutes, undefined, NOW, undefined), null);
});

test('the age is what separates a scan in flight from a mark left behind', () => {
  // Seconds, because a scan that started a moment ago is the case this is for.
  assert.equal(agoPhrase('2026-08-11T11:59:59.500Z', NOW), 'a moment ago');
  assert.equal(agoPhrase('2026-08-11T11:59:48.000Z', NOW), '12 seconds ago');
  assert.equal(agoPhrase('2026-08-11T11:59:00.000Z', NOW), '1 minute ago');
  assert.equal(agoPhrase('2026-08-11T11:36:00.000Z', NOW), '24 minutes ago');
  assert.equal(agoPhrase('2026-08-11T11:00:00.000Z', NOW), '1 hour ago');
  assert.equal(agoPhrase('2026-08-11T04:30:00.000Z', NOW), '7 hours ago');
  // And days, because that is a browser that went away, not a scan.
  assert.equal(agoPhrase('2026-08-08T12:00:00.000Z', NOW), '3 days ago');
});
