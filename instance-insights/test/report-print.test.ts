import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from '../src/checks/catalog.ts';
import { runChecks, score } from '../src/engine.ts';
import type { CheckOutcome } from '../src/engine.ts';
import { reportToPrintHtml } from '../src/report-print.ts';
import { DEFAULT_CONFIG, SCAN_STOPPED_REASON, SEVERITY_FACTOR } from '../src/types.ts';
import { ITEMS_SHOWN } from '../src/report-shared.ts';
import type { ScanContext } from '../src/types.ts';
import { MockYouTrackClient, syntheticInstance } from './mock-client.ts';

/**
 * The printed document is the version that gets handed across a table, and nobody
 * proofreads it through a print dialog. Its shape is asserted here instead.
 */

const NOW = new Date('2026-08-11T00:00:00.000Z');

function contextOn(client: ScanContext['client']): ScanContext {
  return { client, config: DEFAULT_CONFIG, now: NOW };
}

async function render(ignored: ReadonlySet<string> = new Set()): Promise<string> {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  return reportToPrintHtml({ result: score(outcomes, ignored), checks: CHECKS, at: NOW });
}

test('the document carries its own styles and needs nothing from the page', async () => {
  const html = await render();

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  // A print window resolves no relative path of ours, so nothing may be referenced.
  assert.ok(!html.includes('<link'), 'no external stylesheet');
  assert.ok(!html.includes('<script'), 'no script');
  assert.ok(!/src=|href="\.|href="\//.test(html), 'no external asset');
});

test('the controls of the interactive report do not exist on paper', async () => {
  const html = await render();

  for (const control of ['<button', '<input', '<details', 'Mark as intentional</']) {
    assert.ok(!html.includes(control), `a printed report has no ${control}`);
  }
  // The sentence about marking is prose in a check's legitimateWhen, not a control.
  assert.ok(!html.includes('Start scan'), 'no scan button');
});

test('names that come from the instance cannot become markup', async () => {
  const client = new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'P',
        name: 'Project',
        archived: false,
        issuesCount: 40,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: [],
    users: [],
    boards: [
      {
        id: 'b',
        name: '<script>alert("x")</script> & "quoted"',
        usesSprints: false,
        columnField: 'State',
        projects: ['P'],
        columns: [
          { presentation: 'Open', fieldValues: ['Open'] },
          { presentation: 'Doing', fieldValues: ['Doing'] },
          { presentation: 'Done', fieldValues: ['Done'] },
        ],
      },
    ],
    groups: [],
    countRules: [{ match: /\{Doing\}/, count: 12 }],
  });
  const wip = CHECKS.find((c) => c.id === 'process.boards-without-wip-limits');
  assert.ok(wip);

  const outcomes = await runChecks([wip], contextOn(client));
  const html = reportToPrintHtml({ result: score(outcomes), checks: CHECKS, at: NOW });

  assert.ok(!html.includes('<script>alert'), 'the board name must not be markup');
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)/);
});

test('findings are printed by category, strongest first inside one', async () => {
  const html = await render();
  const result = score(await runChecks(CHECKS, contextOn(syntheticInstance(NOW))));

  const expected = result.categories.flatMap((category) =>
    [...category.findings]
      .sort(
        (a, b) =>
          SEVERITY_FACTOR[b.severity] * b.ratio - SEVERITY_FACTOR[a.severity] * a.ratio,
      )
      .map((f) => CHECKS.find((c) => c.id === f.checkId)?.title ?? f.checkId),
  );

  const printed = [...html.matchAll(/class="finding__title">([^<]+)</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(printed, expected);
});

test('an intentional finding prints a deduction of zero, not its arithmetic', async () => {
  const html = await render(new Set(['licensing.inactive-users']));

  assert.match(html, /Marked as intentional/);
  // 10 * 0.6 would be 6.00 - printing that next to a score it did not lower would
  // make the document contradict itself.
  assert.ok(!html.includes('takes away 6.00 of them'), 'the deduction is not counted');
  assert.match(html, /takes away nothing while marked as intentional/);
});

test('a check without a measurement is named with what was missing', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'process.aging-wip',
      category: 'process',
      weight: 7,
      status: 'skipped',
      finding: null,
      reason: 'No board has a column between the first and the last.',
    },
  ];

  const html = reportToPrintHtml({ result: score(outcomes), checks: CHECKS, at: NOW });

  assert.match(html, /Checks without a measurement/);
  assert.match(html, /No board has a column between the first and the last\./);
  assert.ok(!html.includes('- skipped'), 'the engine vocabulary stays out of the report');
});

test('the export names no accounts, but keeps their count', async () => {
  const html = await render();

  for (const login of ['j.doe', 'm.novak', 'svc-jenkins']) {
    assert.ok(!html.includes(login), `the printed report must not name ${login}`);
  }
  assert.match(html, /Affected accounts: \d+\./);
});

test('rendering is reproducible for the same inputs', async () => {
  assert.equal(await render(), await render());
});

test('the trend sentence is printed when it is supplied', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const line = 'Down 20.1 points against the scan from yesterday.';

  const withTrend = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    trendLine: line,
  });
  const withoutTrend = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
  });

  assert.ok(withTrend.includes(line));
  assert.ok(!withoutTrend.includes('against the scan'));
});

test('a comparison that found nothing says so instead of vanishing', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const result = score(outcomes);

  const still = reportToPrintHtml({
    result,
    checks: CHECKS,
    at: NOW,
    comparison: {
      compared: true,
      moved: [],
      unchanged: CHECKS.map((c) => ({
        id: c.id,
        before: 0,
        after: 0,
        kind: 'unchanged' as const,
        status: 'clean',
      })),
    },
  });
  const none = reportToPrintHtml({ result, checks: CHECKS, at: NOW });

  // An instance that held still is a result; a missing section is a puzzle.
  assert.match(still, /Since the previous scan/);
  assert.match(
    still,
    new RegExp(`Nothing moved: all ${CHECKS.length} checks came back within a percentage point`),
  );
  // Without an earlier scan to compare against there is nothing to claim.
  assert.ok(!none.includes('Since the previous scan'));
});

test('a stopped scan says so on the page and names what it did not reach', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'process.aging-wip',
      category: 'process',
      weight: 7,
      status: 'skipped',
      finding: null,
      reason: SCAN_STOPPED_REASON,
    },
  ];

  const html = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    stopped: true,
  });

  // The document leaves the app: a score over part of an instance reads exactly
  // like a score over all of it unless the page says otherwise.
  assert.match(html, /stopped before it had read the whole instance/);
  assert.match(html, /not reached, the scan was stopped/);
  assert.ok(
    !html.includes('skipped: The scan was stopped'),
    'a check the scan never got to was not skipped for a reason of its own',
  );
});

test('a long list of affected objects is cut, and says by how much', () => {
  const many = Array.from({length: ITEMS_SHOWN + 12}, (_, i) => ({
    id: `p-${i}`,
    label: `PROJECT${i}`,
  }));
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'portfolio.dormant-projects',
      category: 'portfolio',
      weight: 7,
      status: 'finding',
      finding: {
        checkId: 'portfolio.dormant-projects',
        severity: 'high',
        headline: `${many.length} projects have had no activity.`,
        ratio: 0.5,
        evidence: [{label: 'Dormant projects', value: many.length}],
        items: many,
      },
    },
  ];

  const html = reportToPrintHtml({ result: score(outcomes), checks: CHECKS, at: NOW });

  assert.match(html, /PROJECT0</);
  assert.match(html, /... and 12 more/);
  assert.ok(!html.includes('PROJECT30<'), 'the list stops where it says it stops');
});

test('a report without an instance names things without linking them', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'portfolio.dormant-projects',
      category: 'portfolio',
      weight: 7,
      status: 'finding',
      finding: {
        checkId: 'portfolio.dormant-projects',
        severity: 'high',
        headline: '2 projects have had no activity.',
        ratio: 0.5,
        evidence: [],
        itemKind: 'project',
        items: [{ id: 'p-1', label: 'WEB' }],
      },
    },
  ];

  const bare = reportToPrintHtml({ result: score(outcomes), checks: CHECKS, at: NOW });
  const linked = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    instanceUrl: 'https://youtrack.example.com',
  });

  // The document is the same either way; only the way to the object is added.
  assert.match(bare, /<li>WEB<\/li>/);
  assert.match(linked, /<a href="https:\/\/youtrack\.example\.com\/projects\/WEB">WEB<\/a>/);
});

test('a counted finding carries the search behind its number', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'process.stale-unresolved',
      category: 'process',
      weight: 8,
      status: 'finding',
      finding: {
        checkId: 'process.stale-unresolved',
        severity: 'high',
        headline: '989 open issues have not been updated.',
        ratio: 0.7,
        evidence: [],
        query: '#Unresolved updated: * .. 2026-03-06',
      },
    },
  ];

  const html = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    instanceUrl: 'https://youtrack.example.com',
  });

  /* A number nobody can check is worth less than the same number with the search
     that produced it. */
  /* Named, because a bare `#Unresolved updated: * .. 2026-03-07` was read as
     neither a filter nor a link by colleagues who do not write query syntax. */
  assert.match(
    html,
    /The search behind this number: <a href="https:\/\/youtrack\.example\.com\/issues\?q=%23Unresolved/,
  );
  assert.match(html, /<code>#Unresolved updated: \* \.\. 2026-03-06<\/code>/);
});

test('a field leads to the page that lists fields, a group to itself', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'fields.duplicate-field-names',
      category: 'fields',
      weight: 6,
      status: 'finding',
      finding: {
        checkId: 'fields.duplicate-field-names',
        severity: 'medium',
        headline: '1 group of fields carries the same meaning under different names.',
        ratio: 0.2,
        evidence: [],
        itemKind: 'field',
        items: [{ id: 'Prio', label: 'Prio' }],
      },
    },
    {
      checkId: 'governance.empty-groups',
      category: 'governance',
      weight: 4,
      status: 'finding',
      finding: {
        checkId: 'governance.empty-groups',
        severity: 'low',
        headline: '2 of 9 user groups have no members.',
        ratio: 0.22,
        evidence: [],
        itemKind: 'group',
        items: [{ id: '4-7', label: 'Release managers' }],
      },
    },
  ];

  const html = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    instanceUrl: 'https://youtrack.example.com',
  });

  /* A single field has no address of its own in the interface, so it leads to the
     list it is in; a group does have one, under the id the API reports. */
  assert.match(
    html,
    /href="https:\/\/youtrack\.example\.com\/admin\/customFieldsConfiguration\?tab=fields-list-vew"/,
  );
  assert.match(html, /href="https:\/\/youtrack\.example\.com\/admin\/groups\/4-7"/);
});

test('a state that never resolves leads to the fields of its project', () => {
  const outcomes: CheckOutcome[] = [
    {
      checkId: 'fields.state-without-resolved',
      category: 'fields',
      weight: 10,
      status: 'finding',
      finding: {
        checkId: 'fields.state-without-resolved',
        severity: 'critical',
        headline: '2 of 40 state fields have no value that counts as resolved.',
        ratio: 0.05,
        evidence: [],
        itemKind: 'project',
        items: [{ id: 'WEB-Stage', label: 'WEB - Stage', target: 'WEB' }],
      },
    },
  ];

  const html = reportToPrintHtml({
    result: score(outcomes),
    checks: CHECKS,
    at: NOW,
    instanceUrl: 'https://youtrack.example.com',
  });

  // The flag is set on the field inside the project, not on the project.
  assert.match(
    html,
    /href="https:\/\/youtrack\.example\.com\/projects\/WEB\/settings\?tab=fields"/,
  );
});

test('the printed score shows what it would be without the decisions', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const decided = score(outcomes, new Set(['portfolio.dormant-projects']));

  const html = reportToPrintHtml({ result: decided, checks: CHECKS, at: NOW });

  /* In the sentence, not as a figure beside the score: a bare second number does
     not say what it is, and this one needs saying. */
  assert.ok(!/summary__measured/.test(html), 'no unexplained second figure');
  assert.match(
    html,
    /class="decisions">1 finding is marked as intentional, so [\d.]+ of those/,
  );
  assert.match(html, /Measured, this scan is [\d.]+ out of 100\./);
});

test('the printed score carries the ring it sits in', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const result = score(outcomes, new Set(['governance.projects-without-leader']));
  const html = reportToPrintHtml({ result, checks: CHECKS, at: NOW });
  assert.ok(result.overallScore !== null);

  /* The arc is a dash of the score's share of the circumference. A dial drawn from
     the wrong share is a picture that contradicts the figure printed inside it, and
     on paper there is nothing to hover to find that out. */
  const dash = html.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
  assert.ok(dash, 'the arc is drawn');
  const drawn = Number(dash[1]);
  const whole = Number(dash[2]);
  assert.equal(Math.round((drawn / whole) * 100), Math.round(result.overallScore));

  // In words inside the ring, because no arc can say what it is out of.
  assert.match(html, /class="score-ring__max">out of 100</);
  /* A score that stands on a decision says so: the reader of a forwarded document
     was not there when it was taken. */
  assert.match(html, /marked as intentional, so [\d.]+ of those [\d.]+ points rest/);
});
