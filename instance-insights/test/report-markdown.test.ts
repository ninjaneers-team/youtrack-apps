import { test } from 'node:test';
import assert from 'node:assert/strict';

import { METHOD_NOTE } from '../src/report-shared.ts';

import { CHECKS } from '../src/checks/catalog.ts';
import { runChecks, score } from '../src/engine.ts';
import type { CheckOutcome } from '../src/engine.ts';
import { reportToMarkdown } from '../src/report-markdown.ts';
import { DEFAULT_CONFIG, SCAN_STOPPED_REASON } from '../src/types.ts';
import type { ScanContext } from '../src/types.ts';
import { syntheticInstance } from './mock-client.ts';

/**
 * The exported report is the product - it gets forwarded to people who never see
 * the app - so its content is asserted rather than eyeballed.
 */

const NOW = new Date('2026-08-11T00:00:00.000Z');

function contextOn(client: ScanContext['client']): ScanContext {
  return { client, config: DEFAULT_CONFIG, now: NOW };
}

async function render(ignored: ReadonlySet<string> = new Set()): Promise<string> {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  return reportToMarkdown({ result: score(outcomes, ignored), checks: CHECKS, at: NOW });
}

test('the report carries score, finding count and the recomputation rule', async () => {
  const md = await render();

  assert.match(md, /^# Instance Insights$/m);
  assert.match(md, /\*\*Overall score:\*\* \d/);
  assert.match(md, /\*\*Findings:\*\* \d+/);
  // A duration for an unseen instance would be guessed, and a reader who can judge
  // one item precisely would drop the whole report over it.
  assert.ok(!/person-days/.test(md), 'no duration anywhere in the export');
  /* The wording lives in report-shared and is checked against the constant, not
     against a copy of it: a better sentence there should not fail a test here. */
  assert.ok(md.includes(METHOD_NOTE));
  /* The same wording as the page and the printed document, and free of any locale:
     a date that follows the reader's machine makes one report out of two. */
  assert.match(md, /Collected on 2026-08-11, 00:00 UTC\./);
});

test('every finding brings its number, its cost, its caveat and its work', async () => {
  const md = await render();

  // One section per finding, under the heading of its category, and the mandatory
  // legitimateWhen is never dropped.
  const sections = md.match(/^#### /gm) ?? [];
  assert.equal(sections.length, CHECKS.length);
  for (const label of ['Licences', 'Process hygiene', 'Project portfolio']) {
    assert.ok(md.includes(`### ${label}`), `${label} groups its findings`);
  }
  assert.equal((md.match(/\*May be intentional:\*/g) ?? []).length, CHECKS.length);
  assert.equal((md.match(/\*What this involves:\*/g) ?? []).length, CHECKS.length);
  // A headline always states a concrete number.
  assert.match(md, /licensed users changed nothing in \d+ days/);
});

test('the categories table lists every category that was scored', async () => {
  const md = await render();

  /* Every figure is a slice of the same hundred as the overall score - the licence
     category is worth thirty of it, not a hundred of its own. */
  assert.match(md, /\| Licences \| \d+\.\d \/ 30\.0 \|/);
  assert.match(md, /\| Process hygiene \| \d+\.\d \/ 20\.0 \|/);
});

test('intentional findings move into their own section', async () => {
  const ignoredId = 'licensing.inactive-users';
  const md = await render(new Set([ignoredId]));

  assert.match(md, /^## Marked as intentional$/m);
  const intentionalAt = md.indexOf('## Marked as intentional');
  const inactiveAt = md.indexOf('Inactive licences');
  assert.ok(
    inactiveAt > intentionalAt,
    'the ignored finding belongs below the intentional heading',
  );
  assert.match(md, /no longer\s+affect the score/);
});

test('a check without a measurement is named, and not called skipped', () => {
  // Every check fires on the synthetic instance, so this case is constructed here.
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'fields.empty-field',
      category: 'fields',
      weight: 8,
      status: 'skipped',
      finding: null,
    },
  ];

  const md = reportToMarkdown({ result: score(outcomes), checks: CHECKS, at: NOW });

  assert.match(md, /^## Checks without a measurement$/m);
  // The check ran; it found nothing in this instance it could measure. "Skipped" is
  // the engine's word for that and reads in a report as something gone wrong.
  assert.match(md, /Fields that stay empty - nothing in this instance to measure/);
  assert.ok(!md.includes('- skipped'), 'the engine vocabulary stays out of the report');
  assert.match(md, /stay out of the score\s+entirely/);
  // Nothing ran, so there is no score to state.
  assert.match(md, /\*\*Overall score:\*\* n\/a/);
});

test('the footer attributes the report and invites a conversation', async () => {
  const md = await render();

  // The attribution travels with the report, since the app never phones home.
  assert.match(md, /\[Ninjaneers GmbH\]\(https:\/\/ninjaneers\.de\)/);
  assert.match(md, /walk through this report together/);
});

test('rendering is reproducible for the same inputs', async () => {
  const first = await render();
  const second = await render();
  assert.equal(first, second);
});

test('the export names no accounts, but keeps their count', async () => {
  const md = await render();

  // The synthetic instance's inactive users; the app shows them, the file must not.
  for (const login of ['j.doe', 'm.novak', 'svc-jenkins']) {
    assert.ok(!md.includes(login), `the export must not name the account ${login}`);
  }
  // The number is an aggregate and stays, together with the reason it is only that.
  assert.match(md, /Affected accounts: \d+\./);
  assert.match(md, /left out here, since this file is meant to be shared/);
});

test('objects that are not people are still listed by name', async () => {
  const md = await render();

  /* Board and project names carry no personal data and remain actionable - and the
     heading names the kind of thing, since "object" is a word from the code. */
  assert.match(md, /Affected boards? \(\d+\):/);
  assert.match(md, /Affected projects \(\d+\):/);
  assert.match(md, /- Team WEB/);
  assert.match(md, /- LEGACY/);
});

test('only the checks that declare it hide their items', () => {
  const declaring = CHECKS.filter((c) => c.itemsNamePeople).map((c) => c.id);
  assert.deepEqual(
    declaring,
    ['licensing.inactive-users'],
    'only the licence check drills down into accounts today',
  );
});

test('every finding carries the terms its deduction is made of', async () => {
  const md = await render();

  // A score is only defensible if the reader can recompute it from the file - and
  // the terms are spelled out, because a formula in a forwarded file gets skipped.
  const terms =
    md.match(
      /\*Points:\* worth \d+\.\d of the hundred, \d+ % affected \(ratio \d\.\d{3}\), takes away \d+\.\d/g,
    ) ?? [];
  assert.equal(terms.length, CHECKS.length);

  /* 3 of 5 accounts idle. Licences is the only category with one check, so that
     check carries the whole thirty points of the category: 60 % of them is 18. */
  assert.match(
    md,
    /worth 30\.0 of the hundred, 60 % affected \(ratio 0\.600\), takes away 18\.0/,
  );
});

test('the categories table shows the terms behind each category score', async () => {
  const md = await render();

  // Plain words instead of sigma notation, same two numbers behind the score.
  assert.match(md, /\| Area \| Points kept \| Points lost \|/);
  // Licences holds one check, so its thirty points are that check's: 18 lost.
  assert.match(md, /\| Licences \| 12\.0 \/ 30\.0 \| 18\.0 \|/);
});

test('the file says when the scan behind it was stopped', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'portfolio.dormant-projects',
      category: 'portfolio',
      weight: 7,
      status: 'skipped',
      finding: null,
      reason: SCAN_STOPPED_REASON,
    },
  ];

  const markdown = reportToMarkdown({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    stopped: true,
  });

  assert.match(markdown, /stopped before it had read the whole instance/);
  assert.match(markdown, /- Dormant projects - not reached, the scan was stopped/);
});

test('links lead to configuration and searches, never to a person', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const md = reportToMarkdown({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    instanceUrl: 'https://youtrack.example.com',
  });

  const links = [...md.matchAll(/\]\((https:\/\/youtrack\.example\.com[^)]*)\)/g)].map(
    (m) => m[1] ?? '',
  );
  assert.ok(links.length > 0, 'a report over an instance links into it');
  for (const link of links) {
    assert.match(
      link,
      /\/(projects|agiles|issues|admin\/customFieldsConfiguration|admin\/groups)(\/|\?)/,
      `${link} leads somewhere other than a project, a board, a field, a group or a search`,
    );
    assert.doesNotMatch(link, /\/users?\/|\/hub\/|\/admin\/users/, `${link} leads to a person`);
  }
  // The accounts behind the licence finding stay out of the file, links included.
  for (const login of ['j.doe', 'm.novak', 'svc-jenkins']) {
    assert.ok(!md.includes(login), `the export must not name the account ${login}`);
  }
});

test('a score that stands on decisions says so, and names the measured one', async () => {
  const plain = await render();
  // Nothing marked: no sentence, because there is no difference to explain.
  assert.ok(!/marked as intentional, so/.test(plain));

  const withDecision = await render(new Set(['portfolio.dormant-projects']));

  /* The file is forwarded to people who were not there when the decision was taken,
     so the number and its reason travel together. */
  assert.match(
    withDecision,
    /1 finding is marked as intentional, so [\d.]+ of those [\d.]+ points rest on that decision/,
  );
  /* Both numbers in the sentence. As a figure of its own - "as measured 67.8" - the
     second score meant nothing to anyone who did not already know the concept. */
  assert.match(withDecision, /Measured, this scan is [\d.]+ out of 100\./);
  assert.match(withDecision, /Nothing in the instance was measured again for it\./);
});

test('the file accounts for all hundred points, decisions included', async () => {
  const plain = await render();
  /* The table is the account: every area with what it was worth and what it lost,
     in points of the same hundred as the score above it. */
  assert.match(plain, /\| Area \| Points kept \| Points lost \|/);
  assert.match(plain, /\| Governance \| [\d.]+ \/ [\d.]+ \| [\d.]+ \|/);
  assert.ok(!/marked as intentional/.test(plain), 'nothing marked, nothing to say');

  const decided = await render(new Set(['governance.projects-without-leader']));
  // A file travels further than the app, so a score resting on a decision says so.
  assert.match(decided, /marked as intentional, so [\d.]+ of those [\d.]+ points rest/);
  assert.match(decided, /Measured, this scan is [\d.]+ out of 100/);
});

test('a marked object stays in the list and says it no longer counts', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const dormant = outcomes.find((o) => o.checkId === 'portfolio.dormant-projects');
  const first = dormant?.finding?.items?.[0];
  assert.ok(first, 'the synthetic instance has a dormant project to mark');

  const marked = new Map([['portfolio.dormant-projects', new Set([first.id])]]);
  const md = reportToMarkdown({
    result: score(outcomes, new Set(), marked),
    checks: CHECKS,
    at: NOW,
    markedItems: marked,
  });

  // Still named, because it is still true of the instance, and marked as excluded.
  assert.ok(md.includes(`${first.label} - marked as intentional`));
  /* The arithmetic follows: the share counted is the measured one minus the marked
     object, or a reader adding up the file would not reach the score in it. */
  assert.match(md, /marked as intentional so \d+ % counted/);
  assert.match(md, /1 object is marked as intentional, so /);
});
