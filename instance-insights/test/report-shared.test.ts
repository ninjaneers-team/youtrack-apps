import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from '../src/checks/catalog.ts';
import { runChecks, score } from '../src/engine.ts';
import {
  dateText,
  decisionEffect,
  issueSearchUrl,
  itemUrl,
  ITEM_NOUN,
  oneDecimal,
  duration,
  movementDetail,
  movementPhrase,
  scanFateNote,
  scoreBarParts,
  scoreComposition,
  timestampText,
} from '../src/report-shared.ts';
import { trendSentence } from '../src/report-shared.ts';
import { trendFrom } from '../src/trend.ts';
import type { CheckChange } from '../src/trend.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import { syntheticInstance } from './mock-client.ts';

/**
 * What every report says about a score has to be arithmetic, not phrasing: the
 * number, the parts it is made of, and how much of it is a decision.
 */

const NOW = new Date('2026-08-11T00:00:00.000Z');

async function outcomes() {
  return runChecks(CHECKS, {
    client: syntheticInstance(NOW),
    config: DEFAULT_CONFIG,
    now: NOW,
  });
}

test('the parts of the score add up to a hundred', async () => {
  const composition = scoreComposition(score(await outcomes()));
  assert.ok(composition);

  const lost = composition.losses.reduce((sum, part) => sum + part.points, 0);
  assert.equal(oneDecimal(composition.kept + composition.decisions + lost), 100);
  // Nothing marked, so no points were handed back.
  assert.equal(composition.decisions, 0);
});

test('a category weighs on the score by its weight, not by its own number', async () => {
  const composition = scoreComposition(score(await outcomes()));
  assert.ok(composition);

  const licensing = composition.losses.find(part => part.category === 'licensing');
  const portfolio = composition.losses.find(part => part.category === 'portfolio');
  assert.ok(licensing && portfolio);

  /* Licences count 3 of the 10 category weights and portfolio 1, so the same share
     of lost points costs licences three times as much of the hundred. This is what
     the bar shows and a table of category scores cannot. */
  assert.ok(
    licensing.points > portfolio.points,
    `licences ${licensing.points} should outweigh portfolio ${portfolio.points}`,
  );
  // Strongest first, so a reader starts where the points went.
  const points = composition.losses.map(part => part.points);
  assert.deepEqual(points, [...points].sort((a, b) => b - a));
});

test('what decisions handed back is its own part, not hidden in what is kept', async () => {
  const all = await outcomes();
  const decided = score(all, new Set(['governance.projects-without-leader']));
  const composition = scoreComposition(decided);
  const effect = decisionEffect(decided);
  assert.ok(composition && effect);

  // The same number the sentence states, and it comes out of the same hundred.
  assert.equal(oneDecimal(composition.decisions), effect.points);
  assert.equal(oneDecimal(composition.kept), oneDecimal(effect.asMeasured));
  const lost = composition.losses.reduce((sum, part) => sum + part.points, 0);
  assert.equal(oneDecimal(composition.kept + composition.decisions + lost), 100);
});

test('an instance nothing could be measured on has no composition', () => {
  assert.equal(scoreComposition(score([])), null);
});

test('a scan is dated the same way wherever it is read', () => {
  const at = new Date('2026-08-11T09:07:03.412Z');

  /* Pinned because three reports share it and because nothing else can catch a
     regression here: `toLocaleString()` produced "11.8.2026" on one machine and
     "8/11/2026" on the next, and a test asserting "what the machine says" would
     have agreed with both. */
  assert.equal(dateText(at), '2026-08-11');
  assert.equal(timestampText(at), '2026-08-11, 09:07 UTC');
});

test('every kind of object a check can list has a name and a way there', () => {
  const origin = 'https://youtrack.example.com';
  for (const [kind, noun] of Object.entries(ITEM_NOUN)) {
    assert.ok(noun.length > 0, `${kind} is called something`);
    const url = itemUrl(origin, kind as keyof typeof ITEM_NOUN, {id: 'x', label: 'X'}, 'any.check');
    /* An account is the one kind a report never links to. Everything else does, and
       a kind added without a case in itemUrl would silently print plain text where
       the page had a link the day before. */
    if (kind === 'account') {
      assert.equal(url, null, 'an account is named, never linked to');
    } else {
      assert.ok(url?.startsWith(origin), `${noun} leads somewhere in the instance`);
    }
  }
});

test('a name carrying half a character still leads somewhere', () => {
  /* JSON can carry a surrogate whose other half is missing, so a name imported
     through the API can hold one - and `encodeURIComponent` throws on it. Thrown
     while a link is built, it would take the whole report down over one name. */
  const half = 'Team \ud83d';
  assert.equal(
    itemUrl('https://yt.example', 'board', { id: 'a-1', label: half, target: half }, 'process.aging-wip'),
    'https://yt.example/agiles/Team%20',
  );
  assert.equal(
    issueSearchUrl('https://yt.example', `project: {${half}}`),
    'https://yt.example/issues?q=project%3A%20%7BTeam%20%7D',
  );
  // A whole character made of two halves is still one character.
  assert.equal(
    issueSearchUrl('https://yt.example', 'Team \ud83d\ude80'),
    'https://yt.example/issues?q=Team%20%F0%9F%9A%80',
  );
});

test('a scan the app did not keep does not say it was kept', () => {
  /* A stopped scan is not written anywhere: not to the trend, and not as the run
     the next visit reads. Both sentences it can be given claim the opposite, which
     is what it said before - next to the warning that the scan was stopped. */
  const kept = scanFateNote('kept', false);
  assert.match(kept, /kept/);

  for (const fate of ['partial', 'stateUnreadable'] as const) {
    const note = scanFateNote(fate, false);
    assert.notEqual(note, kept);
    assert.doesNotMatch(note, /shows it without a new scan/);
  }

  // The two reasons are not interchangeable: one is cured by reloading, the other
  // by scanning the whole instance.
  assert.notEqual(scanFateNote('partial', false), scanFateNote('stateUnreadable', false));
});

test('a run read back from storage says that is what it is', () => {
  assert.notEqual(scanFateNote('kept', true), scanFateNote('kept', false));
});

test('the score bar is one picture, whoever draws it', async () => {
  /* The page and the printed document both draw these parts. What has to hold for
     both: they cover the hundred, the losses come strongest first, and each one
     after the first is drawn a step fainter without fading away. */
  const composition = scoreComposition(score(await outcomes()));
  assert.ok(composition);

  const parts = scoreBarParts(composition);
  assert.equal(oneDecimal(parts.reduce((sum, part) => sum + part.points, 0)), 100);
  assert.equal(parts[0]?.kind, 'kept');
  // Nothing is marked here, so the part that decisions hand back is not drawn.
  assert.deepEqual(parts.filter(part => part.kind === 'decisions'), []);

  const losses = parts.filter(part => part.kind === 'loss');
  assert.ok(losses.length > 1);
  for (const [index, loss] of losses.entries()) {
    const next = losses[index + 1];
    if (next) {
      assert.ok(loss.points >= next.points, 'the largest loss is drawn first');
      assert.ok(loss.opacity >= next.opacity);
    }
    assert.ok(loss.opacity > 0, 'a loss that is drawn at all stays visible');
    assert.ok(loss.label.length > 0, 'every part of the bar can be named in a legend');
  }
});

test('what moved about a check reads the same in every report', () => {
  /* The page, the printed document and the file each frame this differently, and
     all three take the numbers from here. A check that did not run has no share,
     and "0 %" would say it found nothing - the opposite. */
  const change = (
    kind: CheckChange['kind'],
    before: number | null,
    after: number | null,
  ): CheckChange => ({ id: 'a', kind, before, after, status: 'finding' });

  assert.equal(movementDetail(change('new', null, 0.42)), '42 % affected');
  assert.equal(movementDetail(change('resolved', 0.2, null)), 'was 20 %');
  assert.equal(movementDetail(change('better', 0.5, 0.25)), '50 % -> 25 %');
  assert.equal(movementDetail(change('worse', null, 0.1)), 'not measured -> 10 %');
});

test('a score that moved says which way, in points', () => {
  assert.equal(movementPhrase(0), 'unchanged');
  // Rounded the way a report prints a score, or the sentence and the figure differ.
  assert.equal(movementPhrase(0.04), 'unchanged');
  assert.equal(movementPhrase(1), 'up 1 point');
  assert.equal(movementPhrase(-2.35), 'down 2.4 points');
});

test('the trend sentence states the instance, not the decisions', () => {
  const both = [
    { score: 70, scoreAsMeasured: 62, findings: 9, at: '2026-08-11T09:00:00.000Z' },
    { score: 60, scoreAsMeasured: 60, findings: 9, at: '2026-08-04T09:00:00.000Z' },
  ];
  const sentence = trendSentence(trendFrom(both), 0);
  /* Ten of the points came from marking findings, two from the instance. A sentence
     naming the ten would answer "did it get better" wrongly. */
  assert.match(sentence, /up 2 points/);
  assert.match(sentence, /Without the marks/);
  assert.match(sentence, /against the scan/);

  const alone = trendSentence(trendFrom([both[0]!]), 3);
  assert.match(alone, /One scan so far/);
});

test('a scan states what it cost in minutes as well as seconds', () => {
  assert.equal(duration(9.4), '9 s');
  assert.equal(duration(59), '59 s');
  // Rounded up to the minute, so it is not printed as "60 s".
  assert.equal(duration(59.6), '1:00');
  assert.equal(duration(605), '10:05');
});
