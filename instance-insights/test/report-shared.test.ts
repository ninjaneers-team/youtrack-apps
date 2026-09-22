import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from '../src/checks/catalog.ts';
import { runChecks, score } from '../src/engine.ts';
import {
  ITEM_NOUN,
  itemKindPage,
  itemNoun,
  categoryPoints,
  dateText,
  decisionEffect,
  decisionSentence,
  scoreText,
  duration,
  instanceOrigin,
  issueSearchUrl,
  itemUrl,
  movementDetail,
  movementPhrase,
  oneDecimal,
  reportPageUrl,
  scanFateNote,
  shareText,
  timestampText,
} from '../src/report-shared.ts';
import { trendSentence } from '../src/report-shared.ts';
import { trendFrom } from '../src/trend.ts';
import type { CheckChange } from '../src/trend.ts';
import type { ItemKind } from '../src/types.ts';
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

/** What every scored category took out of the hundred, largest first. */
function lossesOf(result: ReturnType<typeof score>): Array<{category: string; points: number}> {
  return result.categories
    .filter(c => c.score !== null)
    .map(c => ({ category: c.category, points: categoryPoints(result, c.category)?.lost ?? 0 }))
    .filter(loss => loss.points > 0)
    .sort((a, b) => b.points - a.points);
}

test('the score and what every area lost add up to a hundred', async () => {
  /* The arithmetic the table rests on: the score plus what each area lost is the
     whole hundred. Break it and every "points lost" column lies by the difference,
     with nothing on the page to reveal it. */
  const result = score(await outcomes());
  assert.ok(result.overallScore !== null);

  const lost = lossesOf(result).reduce((sum, loss) => sum + loss.points, 0);
  assert.equal(oneDecimal(result.overallScore + lost), 100);
  // Nothing marked, so the score and the measurement are the same number.
  assert.equal(result.overallScore, result.overallAsMeasured);
});

test('an area weighs on the score by its weight, not by its own number', async () => {
  const result = score(await outcomes());
  const losses = lossesOf(result);

  const licensing = losses.find(loss => loss.category === 'licensing');
  const portfolio = losses.find(loss => loss.category === 'portfolio');
  assert.ok(licensing && portfolio);

  /* Licences count 3 of the 10 category weights and portfolio 1, so the same share
     of lost points costs licences three times as much of the hundred. This is what
     the "points lost" column states and a category's own score cannot. */
  assert.ok(
    licensing.points > portfolio.points,
    `licences ${licensing.points} should outweigh portfolio ${portfolio.points}`,
  );
});

test('what decisions handed back comes out of the same hundred', async () => {
  const all = await outcomes();
  const decided = score(all, new Set(['governance.projects-without-leader']));
  const effect = decisionEffect(decided);
  assert.ok(decided.overallScore !== null && effect);

  // The sentence and the score agree, and the hundred still adds up with it in.
  assert.equal(oneDecimal(decided.overallScore - (decided.overallAsMeasured ?? 0)), effect.points);
  const lost = lossesOf(decided).reduce((sum, loss) => sum + loss.points, 0);
  assert.equal(oneDecimal(decided.overallScore + lost), 100);
});

test('the sentence about decisions carries the scores at one decimal', async () => {
  const all = await outcomes();
  const decided = score(all, new Set(['governance.projects-without-leader']));
  const effect = decisionEffect(decided);
  assert.ok(effect);

  /* Every score in a report is shown to one decimal, this sentence included. It
     printed the bare numbers, so a report whose ring read 57.0 explained itself
     with "2 of those 57 points" - which reads as a second, different figure. */
  const sentence = decisionSentence(effect);
  for (const figure of [effect.points, effect.reported, effect.asMeasured]) {
    assert.ok(
      sentence.includes(scoreText(figure)),
      `${scoreText(figure)} missing from: ${sentence}`,
    );
  }
  assert.ok(
    sentence.includes(`${scoreText(effect.points)} of those ${scoreText(effect.reported)}`),
    sentence,
  );
});

test('an instance nothing could be measured on has no score', () => {
  assert.equal(score([]).overallScore, null);
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

test('the number a row counts leads to the issues, not to its own kind', () => {
  const origin = 'https://youtrack.example.com';
  const field = {id: 'f', label: 'Type', detail: '1 of 12494 issues in 24 projects'};

  /* Two links with two meanings: the kind has one page for all of it, and the row's
     own number has the search behind it. Before, the row led to the page - a list
     of every field, which answers nothing about an issue. */
  assert.equal(itemUrl(origin, 'field', field, 'fields.required-but-empty'), null);
  assert.ok(itemKindPage(origin, 'field')?.startsWith(origin));
  assert.equal(
    issueSearchUrl(origin, 'project: {A} and has: -{Type}'),
    `${origin}/issues?q=project%3A%20%7BA%7D%20and%20has%3A%20-%7BType%7D`,
  );
});

test('a plural is written out, not made by appending an s', () => {
  /* One of these nouns does not take its plural at the end. Under the rule that
     appends an s, a report with two of them read "2 group of fieldss". */
  assert.equal(itemNoun('field-group', 1), 'group of fields');
  assert.equal(itemNoun('field-group', 2), 'groups of fields');
  assert.equal(itemNoun('value-list', 2), 'sets of values');
  // A check that lists nothing countable falls back on the code's own word.
  assert.equal(itemNoun(undefined, 2), 'objects');
});

test('every kind of object a check can list has a name and a way there', () => {
  const origin = 'https://youtrack.example.com';
  /* Three kinds have no address of their own: YouTrack keeps the selected field out
     of the URL, so a field, a group of fields and a list of values are all
     administered on one page - and the card links to that page once instead of
     giving every row a link to it. An account has neither, because a report never
     leads to a person. Everything else is addressed per row, and a kind added
     without a case anywhere would silently print plain text where the page had a
     link the day before. */
  const onOnePage = ['field', 'field-group', 'value-list'];
  for (const [kind, noun] of Object.entries(ITEM_NOUN)) {
    assert.ok(noun.one.length > 0, `${kind} is called something`);
    assert.ok(noun.many.length > 0, `${kind} is called something in the plural`);
    const row = itemUrl(origin, kind as ItemKind, {id: 'x', label: 'X'}, 'any.check');
    const page = itemKindPage(origin, kind as ItemKind);
    if (kind === 'account') {
      assert.equal(row, null, 'an account is named, never linked to');
      assert.equal(page, null, 'and there is no page of accounts to offer either');
      continue;
    }
    if (onOnePage.includes(kind)) {
      assert.equal(row, null, `a single ${noun.one} has no address of its own`);
      assert.ok(page?.startsWith(origin), `${noun.many} are on one page`);
      continue;
    }
    assert.ok(row?.startsWith(origin), `${noun.one} leads somewhere in the instance`);
    assert.equal(page, null, `${noun.one} needs no page of its kind`);
  }
});

test('a name carrying half a character still leads somewhere', () => {
  /* JSON can carry a surrogate whose other half is missing, so a name imported
     through the API can hold one - and `encodeURIComponent` throws on it. Thrown
     while a link is built, it would take the whole report down over one name. */
  const half = 'Team \ud83d';
  assert.equal(
    itemUrl(
      'https://yt.example',
      'board',
      { id: 'a-1', label: half, target: half },
      'process.overgrown-boards',
    ),
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

test('a widget links into the instance only when two facts agree', () => {
  const host = 'youtrack.example.com';
  /* The base says where this page came from, the handler says which host the
     instance answered under. Both, because a development entry serves the same
     widget from a local server, and a link built there leads nowhere. */
  assert.equal(
    instanceOrigin(host, `https://${host}/app/instance-insights/report`),
    `https://${host}`,
  );
  assert.equal(instanceOrigin(host, 'http://localhost:5173/dev/'), null, 'another host');
  assert.equal(instanceOrigin(null, `https://${host}/app/x`), null, 'the handler said nothing');
  assert.equal(instanceOrigin(host, 'not a url'), null, 'a base nobody can parse');
  assert.equal(
    instanceOrigin(host, `file://${host}/somewhere`),
    null,
    'a scheme a link cannot use',
  );
});

test('the report page is where the instance serves it', () => {
  /* Measured in the address bar of a running instance after following the item in
     the administration menu, not derived from a rule. A page under that menu is
     served below /admin; the address without it answers too, but the menu uses
     this one, and the tile has to send its reader where the menu does. */
  assert.equal(
    reportPageUrl('https://youtrack.example.com'),
    'https://youtrack.example.com/admin/app/instance-insights/report',
  );
  assert.equal(reportPageUrl(null), null, 'no instance, no link');
});

test('a share too small to round to a percent still reads as a share', () => {
  /* Measured on a live instance: a required field was missing on a handful of
     issues among tens of thousands, and the line read "0 % affected" one row above
     another reading "nothing found". Two different statements in the same words. */
  assert.equal(shareText(0.001), 'under 1 %');
  assert.equal(shareText(0.004), 'under 1 %');
  assert.equal(shareText(0), '0 %', 'a measured nothing is nothing, not "under 1 %"');
  assert.equal(shareText(0.006), '1 %');
  assert.equal(shareText(0.6), '60 %');
  assert.equal(shareText(null), 'not measured', 'no measurement is not a share of zero');
});
