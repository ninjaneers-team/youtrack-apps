import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from '../src/checks/catalog.ts';
import { effectiveRatio, runChecks, runScan, score } from '../src/engine.ts';
import { CATEGORY_WEIGHT, DEFAULT_CONFIG, severityFromRatio } from '../src/types.ts';
import type { ScanContext } from '../src/types.ts';
import { MockYouTrackClient, recordingClient, syntheticInstance } from './mock-client.ts';

const NOW = new Date('2026-08-11T00:00:00.000Z');

function contextOn(client: ScanContext['client']): ScanContext {
  return { client, config: DEFAULT_CONFIG, now: NOW };
}

test('every catalog check fires on the synthetic instance', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));

  const notFired = result.outcomes.filter((o) => o.status !== 'finding');
  assert.deepEqual(
    notFired.map((o) => `${o.checkId}:${o.status}`),
    [],
    'all checks are expected to produce a finding on the synthetic instance',
  );
  assert.equal(result.findings.length, CHECKS.length);
});

test('no check states a duration, only what the work involves', () => {
  for (const check of CHECKS) {
    assert.ok(
      check.whatItInvolves.trim().length > 0,
      `${check.id} has to say what the work involves`,
    );
    // A duration for an instance nobody has seen would be guessed, and one item a
    // reader can judge precisely would take the whole report down with it.
    assert.ok(
      !/person-days?|\bdays?\b|\bhours?\b|\bweeks?\b/i.test(check.whatItInvolves),
      `${check.id} must not put a duration in whatItInvolves`,
    );
  }
});

test('the overall score is recomputable by hand from the category scores', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));

  let weighted = 0;
  let weightSum = 0;
  for (const cat of result.categories) {
    assert.notEqual(cat.score, null, `${cat.category} should have a score`);
    // The category score follows from its own terms: 100 - 100 * deduction / weight.
    assert.equal(cat.score, 100 - (100 * cat.deduction) / cat.ranWeight);
    weighted += CATEGORY_WEIGHT[cat.category] * (cat.score as number);
    weightSum += CATEGORY_WEIGHT[cat.category];
  }

  assert.equal(result.overallScore, weighted / weightSum);
  assert.ok(
    (result.overallScore as number) > 0 && (result.overallScore as number) < 100,
    'an instance carrying debt scores strictly between 0 and 100',
  );
});

test('the inactive-users finding is the strongest and reads with a number', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const inactive = result.findings.find(
    (f) => f.checkId === 'licensing.inactive-users',
  );

  // 3 of 5 licensed users idle -> ratio 0.6 -> high.
  assert.equal(inactive?.ratio, 3 / 5);
  assert.equal(inactive?.severity, 'high');
  assert.match(inactive?.headline ?? '', /\d/);
});

test('an idle account carries the date of its last change', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const items = result.findings.find(
    (f) => f.checkId === 'licensing.inactive-users',
  )?.items;

  // "Stopped a year ago" and "never did anything" are different conversations
  // about a licence, so the finding tells them apart.
  const jane = items?.find((i) => i.label === 'j.doe');
  assert.equal(jane?.detail, 'last change 2025-07-07');
  assert.equal(items?.find((i) => i.label === 'm.novak')?.detail, 'no trace at all');
});

test('an account that changed something inside the window keeps its licence', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const logins = (
    result.findings.find((f) => f.checkId === 'licensing.inactive-users')?.items ?? []
  ).map((i) => i.label);

  // u-lead changed something ten days ago. Whether that was an issue, a comment,
  // a vote or a logged work item does not matter - it is a trace.
  assert.ok(!logins.includes('u-lead'), 'a recent change is not an idle licence');
});

test('accounts younger than the window are not counted as inactive licences', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const inactive = result.findings.find(
    (f) => f.checkId === 'licensing.inactive-users',
  );

  // u-fresh registered days ago: no activity in 90 days because it did not exist.
  // The mock has no activity rule for it, so a probe would have thrown instead.
  const logins = (inactive?.items ?? []).map((i) => i.label);
  assert.ok(!logins.includes('u-fresh'), 'a new account is no idle licence');
  assert.deepEqual(logins, ['j.doe', 'm.novak', 'svc-jenkins']);
});

test('aging WIP counts the boards it lists', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const aging = result.findings.find((f) => f.checkId === 'process.aging-wip');

  /* Three boards carry work and two of them carry work that stopped. Cards cannot
     be the population: the same issue sits on several boards, so adding them up
     counted it once per board - and asking the instance for the distinct number
     took one query naming every board at once, the only question in this check that
     could not fail without taking the whole check down with it. It did, on an
     instance with thirty-three boards. A board does not overlap with itself. */
  assert.equal(aging?.ratio, 2 / 3);
  assert.match(aging?.headline ?? '', /2 of 3 boards carry cards that have not moved/);
  /* Every board answered, so the report says nothing about boards it could not
     count - a line about none of them reads as a limit that is not there. */
  assert.deepEqual(aging?.evidence, []);
  /* The rows keep the cards of their own board, where they are true and where the
     work is done. */
  assert.deepEqual(
    (aging?.items ?? []).map((i) => `${i.label}: ${i.detail}`),
    ['Team WEB: 8 of 20 cards', 'Kanban APP: 8 of 20 cards'],
  );
  // A share measured on one arbitrary board would be read as the instance.
  assert.ok(!/Team WEB/.test(aging?.headline ?? ''), 'the headline names no board');
});

test('marking a board takes it out of both sides of the share', async () => {
  const outcomes = await runChecks(CHECKS, contextOn(syntheticInstance(NOW)));
  const aging = outcomes.find((o) => o.checkId === 'process.aging-wip')?.finding;
  assert.ok(aging);

  /* What the population being boards buys: one board weighs as much as any other,
     so a board marked as intentional leaves the numerator and the denominator
     together. With cards it had no answer that did not depend on which board was
     marked first, and the control had to be withheld. */
  const marked = new Map([['process.aging-wip', new Set([aging.items?.[0]?.id ?? ''])]]);
  const scored = score(outcomes, new Set(), marked);
  const after = scored.findings.find((f) => f.checkId === 'process.aging-wip');
  assert.equal(effectiveRatio(after ?? aging, marked.get('process.aging-wip')), 1 / 2);
});

test('aging WIP asks whether a card is on the board, not just in its projects', async () => {
  const {client: counting, queries} = recordingClient(syntheticInstance(NOW));
  const agingWip = CHECKS.find((c) => c.id === 'process.aging-wip');
  assert.ok(agingWip);

  await runScan([agingWip], contextOn(counting));

  /* The projects of a board are not the board. Counting by project alone reported
     cards on boards whose columns were empty, and missed cards that were on the
     board - measured against a live instance, it was wrong on every board it
     touched, in both directions. Board membership is a field: `Board <name>`
     carries the sprint a card sits in. */
  for (const query of queries) {
    assert.match(query, /has: \{Board /, 'every count asks about board membership');
    assert.match(query, /project: /, 'and keeps the project scope beside it');
  }
  /* On a board that plans in sprints, a card nobody scheduled sits in a sprint of
     its own that `has:` does not count, so those sprints are named beside it. On a
     board that plans without them, naming the sprint it still reports produced a
     count the instance never delivered, so it is asked with `has:` alone. */
  const namesSprint = (board: string): boolean =>
    queries.some((q) => q.includes(`{Board ${board}}: {First sprint}`));
  assert.equal(namesSprint('Release LEGACY'), true, 'a sprint board names its sprints');
  assert.equal(namesSprint('Team WEB'), false, 'a flow board is asked with has: alone');
  assert.equal(namesSprint('Kanban APP'), false, 'a flow board is asked with has: alone');
});

test('a board asks one question per board, not one per column', async () => {
  const {client: counting, queries: queries} = recordingClient(
    syntheticInstance(NOW),
  );
  const agingWip = CHECKS.find((c) => c.id === 'process.aging-wip');
  assert.ok(agingWip);

  await runScan([agingWip], contextOn(counting));

  /* Three boards, two questions each: what it carries, and how much of that
     stopped. Release LEGACY alone has seven middle columns, which one query per
     column would make fourteen requests on its own. */
  assert.equal(queries.length, 6);
  for (const query of queries) {
    assert.match(query, / and \(/, 'a group in parentheses needs an explicit and');
  }
});

test('aging WIP is skipped when no board has a column in between', async () => {
  const client = new MockYouTrackClient({
    projects: [],
    customFields: [],
    users: [],
    boards: [
      {
        id: 'b',
        name: 'Two columns only',
        usesSprints: false,
        columnField: 'State',
      sprints: ['First sprint'],
        projects: ['P'],
        columns: [
          { presentation: 'Open', fieldValues: ['Open'] },
          { presentation: 'Done', fieldValues: ['Done'] },
        ],
      },
    ],
    groups: [],
    countRules: [],
  });
  const agingWip = CHECKS.find((c) => c.id === 'process.aging-wip');
  assert.ok(agingWip);

  const result = await runScan([agingWip], contextOn(client));
  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.equal(result.overallScore, null, 'a skipped check leaves the score alone');
});

test('the overgrown board is the one past the column limit', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const overgrown = result.findings.find(
    (f) => f.checkId === 'process.overgrown-boards',
  );

  // Release LEGACY has nine columns; the other two have three.
  assert.deepEqual(
    (overgrown?.items ?? []).map((i) => i.label),
    ['Release LEGACY'],
  );
  assert.equal(overgrown?.ratio, 1 / 3);
});

test('a board that spans an archived project says so where it is named', async () => {
  /* The count is right - the archived part is out of the query - but a reader who
     opens the board sees archived projects on it and doubts the number instead of
     the board. So the finding says which part stayed out. */
  const client = new MockYouTrackClient({
    projects: [
      {
        id: 'p1',
        shortName: 'ACT',
        name: 'Active',
        archived: false,
        issuesCount: 40,
        leader: { id: 'l', login: 'lead', banned: false },
      },
      {
        id: 'p2',
        shortName: 'OLD',
        name: 'Retired',
        archived: true,
        issuesCount: 12,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: [],
    users: [],
    boards: [
      {
        id: 'b',
        name: 'Mixed board',
        columnField: 'State',
      sprints: ['First sprint'],
        projects: ['ACT', 'OLD'],
        usesSprints: false,
        columns: [
          { presentation: 'Open', wipLimitMin: null, wipLimitMax: null, fieldValues: ['Open'] },
          { presentation: 'Doing', wipLimitMin: null, wipLimitMax: null, fieldValues: ['Doing'] },
          { presentation: 'Done', wipLimitMin: null, wipLimitMax: null, fieldValues: ['Done'] },
        ],
      },
    ],
    groups: [],
    // The stale query carries `updated:`; the plain one does not. First match wins.
    countRules: [
      { match: /updated:/, count: 3 },
      { match: /Doing/, count: 8 },
    ],
  });
  const wip = CHECKS.find((c) => c.id === 'process.aging-wip');
  assert.ok(wip);

  const result = await runScan([wip], contextOn(client));
  const finding = result.findings[0];
  assert.equal(finding?.items?.length, 1);
  assert.equal(finding?.items?.[0]?.label, 'Mixed board');
  assert.equal(finding?.items?.[0]?.detail, '3 of 8 cards, 1 archived project left out');

  // The query names the active project only, or search would answer with a 400.
  const asked = result.outcomes[0];
  assert.equal(asked?.status, 'finding');
});

test('a board whose only project is archived is not judged by its columns', async () => {
  /* Reported from a real instance: a finding named a board nobody reads any more.
     A board that spans an archived *and* an active project stays - it is still in
     use, and the fixture's Release LEGACY covers that case. */
  const client = new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'OLD',
        name: 'Retired',
        archived: true,
        issuesCount: 40,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: [],
    users: [],
    boards: [
      {
        id: 'b',
        name: 'Board of a retired project',
        columnField: 'State',
      sprints: ['First sprint'],
        projects: ['OLD'],
        usesSprints: false,
        columns: Array.from({ length: 9 }, (_, i) => ({
          presentation: `Step ${i}`,
          wipLimitMin: null,
          wipLimitMax: null,
          fieldValues: [`Step ${i}`],
        })),
      },
    ],
    groups: [],
    countRules: [],
  });
  const columnCheck = CHECKS.find((c) => c.id === 'process.overgrown-boards');
  assert.ok(columnCheck);

  const result = await runScan([columnCheck], contextOn(client));
  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.match(result.outcomes[0]?.reason ?? '', /takes new work/);
});

test('tiny projects are counted against the active ones only', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const tiny = result.findings.find((f) => f.checkId === 'portfolio.tiny-projects');

  // GHOST holds 5 issues; ARCHIVE is archived and out of the picture entirely.
  assert.deepEqual((tiny?.items ?? []).map((i) => i.label), ['GHOST']);
  assert.equal(tiny?.ratio, 1 / 5);
});

test('empty-field is skipped, not failed, when no project has enough issues', async () => {
  const client = new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'TINY',
        name: 'Tiny',
        archived: false,
        issuesCount: 10,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: [
      {
        id: 'f',
        name: 'Severity',
        fieldType: 'enum[1]',
        instances: [{ id: 'i', projectShortName: 'TINY', bundleId: null }],
      },
    ],
    users: [],
    boards: [],
    groups: [],
    countRules: [],
  });
  const emptyField = CHECKS.find((c) => c.id === 'fields.empty-field');
  assert.ok(emptyField);

  const result = await runScan([emptyField], contextOn(client));
  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.equal(result.overallScore, null);
});

test('a finding names the check that made it, and its band follows its ratio', async () => {
  /* Both were written out per check, fifteen times over. A finding under the wrong
     id would be marked as intentional in the wrong place and titled with another
     check's title, and neither the type nor a test would have said so. */
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));

  for (const outcome of result.outcomes) {
    const finding = outcome.finding;
    if (finding === null) {
      continue;
    }
    assert.equal(finding.checkId, outcome.checkId);
    assert.equal(finding.severity, severityFromRatio(finding.ratio));
    assert.ok(finding.ratio >= 0 && finding.ratio <= 1, `${outcome.checkId} ratio`);
    assert.ok(Array.isArray(finding.evidence), `${outcome.checkId} evidence`);
  }
});

test('every check carries the mandatory report metadata', () => {
  const seen = new Set<string>();
  for (const check of CHECKS) {
    assert.ok(!seen.has(check.id), `duplicate check id ${check.id}`);
    seen.add(check.id);

    assert.ok(check.legitimateWhen.trim().length > 0, `${check.id} needs legitimateWhen`);
    assert.ok(check.why.trim().length > 0, `${check.id} needs why`);
    assert.ok(
      check.whatItInvolves.trim().length > 0,
      `${check.id} needs whatItInvolves`,
    );
    assert.ok(check.weight > 0);
  }
});

test('the empty-field check costs one request per field, not one per pair', async () => {
  /*
   * The cost of this check used to grow with projects times fields: 80 fields in 200
   * projects meant 16 000 requests. It asks per field now - how many issues carry a
   * value at all - and the reference comes from project totals the scan already
   * holds, so nothing is sampled and nothing scales with the project count.
   */
  const {client: counting, queries: counts} = recordingClient(syntheticInstance(NOW));
  const emptyField = CHECKS.find((c) => c.id === 'fields.empty-field');
  assert.ok(emptyField);

  await runScan([emptyField], contextOn(counting));

  const fields = await counting.listCustomFields();
  const projects = await counting.listProjects();
  assert.ok(counts.length <= fields.length, 'at most one count per field');
  assert.ok(
    counts.length < projects.length * fields.length,
    'and far fewer than one per field/project pair',
  );
  for (const query of counts) {
    assert.ok(
      !query.includes('project:'),
      `the query must not name projects, or it grows with the instance: ${query}`,
    );
  }
});

test('a field that is filled almost everywhere is not reported as empty', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const finding = result.findings.find((f) => f.checkId === 'fields.empty-field');

  // Severity is the one attached to a project with issues and left empty.
  assert.deepEqual((finding?.items ?? []).map((i) => i.label), ['Severity']);
  assert.match(finding?.items?.[0]?.detail ?? '', /% empty across 1 project$/);
});

/**
 * A field whose name YouTrack cannot parse inside a search query - a name that
 * collides with a query keyword, or carries a brace. The mock throws for a query it
 * has no rule for, which is exactly what the API does with 400.
 */
function instanceWithUnparseableFieldName(names: string[]): MockYouTrackClient {
  return new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'WEB',
        name: 'Web',
        archived: false,
        issuesCount: 100,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: names.map((name, index) => ({
      id: `f-${index}`,
      name,
      fieldType: 'enum[1]',
      instances: [{ id: `i-${index}`, projectShortName: 'WEB', bundleId: null }],
    })),
    users: [],
    boards: [],
    groups: [],
    countRules: [{ match: /has: \{Severity\}/, count: 4 }],
  });
}

test('a field name no search can reach is counted, not called empty', async () => {
  const emptyField = CHECKS.find((c) => c.id === 'fields.empty-field');
  assert.ok(emptyField);

  const result = await runScan(
    [emptyField],
    contextOn(instanceWithUnparseableFieldName(['Severity', 'project'])),
  );
  const finding = result.findings[0];

  assert.deepEqual((finding?.items ?? []).map((i) => i.label), ['Severity']);
  // One of two fields measured, and that one is empty: the ratio is 1, not 0.5.
  assert.equal(finding?.ratio, 1);
  assert.equal(
    finding?.evidence.find((e) => e.label === 'Fields no search could reach')?.value,
    1,
  );
});

test('when no field name can be reached the check is skipped, not scored', async () => {
  const emptyField = CHECKS.find((c) => c.id === 'fields.empty-field');
  assert.ok(emptyField);

  const result = await runScan(
    [emptyField],
    contextOn(instanceWithUnparseableFieldName(['project'])),
  );

  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.match(result.outcomes[0]?.reason ?? '', /No search query could reach/);
  assert.equal(result.overallScore, null);
});

test('no check claims a cost in money', () => {
  /*
   * YouTrack runs on free plans too, where a seat is not billed at all - it is one
   * of a limited number. A sentence about money would simply be false on such an
   * instance, and a report is only as trustworthy as its least accurate sentence.
   */
  // Currency signs as escapes, so this file stays plain ASCII like the rest.
  const money = /costs? money|cheaper|per user per month|[\u20AC$\u00A3]\s?\d/i;
  for (const check of CHECKS) {
    for (const [field, text] of Object.entries({
      why: check.why,
      legitimateWhen: check.legitimateWhen,
      whatItInvolves: check.whatItInvolves,
    })) {
      assert.ok(
        !money.test(text),
        `${check.id}.${field} claims a cost in money: ${text}`,
      );
    }
  }
});

test('a state field is judged per project, because the bundle is per project', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const finding = result.findings.find(
    (f) => f.checkId === 'fields.state-without-resolved',
  );

  // LEGACY and NOLEAD share a bundle in which nothing is resolved; WEB, APP and
  // GHOST use one that has a Done value. The archived project is out of the picture.
  assert.deepEqual(
    (finding?.items ?? []).map((i) => i.label),
    ['LEGACY - State', 'NOLEAD - State'],
  );
  assert.equal(finding?.ratio, 2 / 5);
  assert.match(finding?.headline ?? '', /no value that counts as resolved/);
});

test('state fields are read from one bundle list, not one request per project', async () => {
  const {client: counting, queries, calls} = recordingClient(syntheticInstance(NOW));
  const check = CHECKS.find((c) => c.id === 'fields.state-without-resolved');
  assert.ok(check);

  await runScan([check], contextOn(counting));

  assert.equal(
    calls.filter((name) => name === 'listStateBundles').length,
    1,
    'the bundles come in one list',
  );
  assert.equal(queries.length, 0, 'and the check needs no issue count at all');
});

test('a board carrying an archived project is named with that project', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const finding = result.findings.find(
    (f) => f.checkId === 'process.boards-on-archived-projects',
  );

  assert.equal(finding?.ratio, 1 / 3);
  assert.deepEqual((finding?.items ?? []).map((i) => i.label), ['Release LEGACY']);
  assert.equal(finding?.items?.[0]?.detail, 'ARCHIVE');
});

test('boards are not judged against archived projects when there are none', async () => {
  const client = new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'WEB',
        name: 'Web',
        archived: false,
        issuesCount: 10,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: [],
    users: [],
    boards: [
      {
        id: 'b',
        name: 'Board',
        usesSprints: false,
        columnField: 'State',
      sprints: ['First sprint'],
        projects: ['WEB'],
        columns: [],
      },
    ],
    groups: [],
    countRules: [],
  });
  const check = CHECKS.find((c) => c.id === 'process.boards-on-archived-projects');
  assert.ok(check);

  const result = await runScan([check], contextOn(client));

  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.match(result.outcomes[0]?.reason ?? '', /no archived projects/);
});

test('every name that comes from the instance is braced in a query', async () => {
  const {client: counting, queries: queries} = recordingClient(
    syntheticInstance(NOW),
  );

  await runScan(CHECKS, contextOn(counting));

  /* A project short name is as free to contain query syntax as a field name is,
     and an unparseable query is a 400 - which would take down every check that
     shares the list it happened in. */
  for (const query of queries.filter((q) => q.includes('project:'))) {
    assert.equal(
      /project:\s*[^{\s]/.exec(query),
      null,
      `a project name went into a query unbraced: ${query}`,
    );
  }
});


test('a board reaching into an archived project is asked only about the rest', async () => {
  const {client: counting, queries: queries} = recordingClient(
    syntheticInstance(NOW),
  );
  const agingWip = CHECKS.find((c) => c.id === 'process.aging-wip');
  assert.ok(agingWip);

  await runScan([agingWip], contextOn(counting));

  // Release LEGACY covers LEGACY and the archived ARCHIVE. Naming the archived one
  // would make the query a 400, so the board is asked about LEGACY alone.
  assert.ok(
    queries.some((q) => q.includes('{LEGACY}')),
    'the board is still measured',
  );
  for (const query of queries) {
    assert.ok(!query.includes('ARCHIVE'), `an archived project reached a query: ${query}`);
  }
});

test('a sprint board is not judged by column limits', async () => {
  const result = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const wip = result.findings.find(
    (f) => f.checkId === 'process.boards-without-wip-limits',
  );

  /* Release LEGACY plans in sprints, so it limits work through the sprint it
     commits to; Kanban APP has a limit on a column. Team WEB carries cards in
     flight with no limit anywhere, and is the only board this check is about. */
  assert.deepEqual((wip?.items ?? []).map((i) => i.label), ['Team WEB']);
  assert.equal(wip?.ratio, 1 / 2);
  assert.match(wip?.headline ?? '', /work in flight with no limit/);
  assert.equal(
    wip?.evidence.find((e) => e.label === 'Cards in flight without a limit')?.value,
    20,
  );
});

test('a board with nothing in flight needs no limit on it', async () => {
  const client = new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'WEB',
        name: 'Web',
        archived: false,
        issuesCount: 50,
        leader: { id: 'l', login: 'lead', banned: false },
      },
    ],
    customFields: [],
    users: [],
    boards: [
      {
        id: 'b',
        name: 'Empty flow',
        usesSprints: false,
        columnField: 'State',
      sprints: ['First sprint'],
        projects: ['WEB'],
        columns: [
          { presentation: 'Open', fieldValues: ['Open'], wipLimitMin: null, wipLimitMax: null },
          { presentation: 'Doing', fieldValues: ['Doing'], wipLimitMin: null, wipLimitMax: null },
          { presentation: 'Done', fieldValues: ['Done'], wipLimitMin: null, wipLimitMax: null },
        ],
      },
    ],
    groups: [],
    countRules: [{ match: /\{Doing\}/, count: 0 }],
  });
  const wip = CHECKS.find((c) => c.id === 'process.boards-without-wip-limits');
  assert.ok(wip);

  const result = await runScan([wip], contextOn(client));

  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.match(result.outcomes[0]?.reason ?? '', /carries work in flight/);
});

test('a check that lists what it counts says how many it counted against', async () => {
  const { outcomes } = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));

  /* `total` is what lets a report recompute the share when single objects are marked
     as intentional. Two shapes are correct, and a check has to be one of them: one
     item means one affected thing, or every item carries its own weight and the
     finding says what the whole numerator was. */
  for (const outcome of outcomes) {
    const finding = outcome.finding;
    if (!finding?.total) {
      continue;
    }
    const items = finding.items ?? [];
    assert.ok(items.length > 0, `${outcome.checkId} sets total but lists nothing`);
    const numerator = Math.round(finding.ratio * finding.total);
    if (finding.affected === undefined) {
      assert.equal(
        numerator,
        items.length,
        `${outcome.checkId}: ratio ${finding.ratio} of ${finding.total} does not match ` +
          `its ${items.length} items, so marking one would move the score wrongly`,
      );
      continue;
    }
    assert.equal(
      numerator,
      finding.affected,
      `${outcome.checkId}: ratio ${finding.ratio} of ${finding.total} is not ` +
        `${finding.affected} affected`,
    );
    let affected = 0;
    let measured = 0;
    for (const item of items) {
      assert.equal(
        typeof item.affected,
        'number',
        `${outcome.checkId}: ${item.id} carries no weight, so marking it would ` +
          'count it as one of a list',
      );
      assert.equal(typeof item.measured, 'number', `${outcome.checkId}: ${item.id}`);
      affected += item.affected ?? 0;
      measured += item.measured ?? 0;
    }
    // Marking every object it names may take the share to zero, never below it.
    assert.ok(
      affected <= finding.affected,
      `${outcome.checkId}: its objects add up to more than it measured`,
    );
    assert.ok(
      measured <= finding.total,
      `${outcome.checkId}: its objects cover more than the population measured`,
    );
  }
});

test('the checks whose objects cannot be marked one by one say why', async () => {
  const { outcomes } = await runScan(CHECKS, contextOn(syntheticInstance(NOW)));
  const withoutTotal = outcomes
    .filter((o) => o.finding && o.finding.total === undefined)
    .map((o) => o.checkId)
    .sort();

  /* Two reasons remain, each a property of the check: the objects are accounts and
     are never stored, or the check counts issues without listing them. A check
     whose objects weigh differently from one another is not one of them - it
     carries the weights on the items instead. Pinned so a new check is a
     decision. */
  assert.deepEqual(withoutTotal, [
    'licensing.inactive-users',
    'process.stale-unresolved',
    'process.unassigned-unresolved',
  ]);
});

/** One custom field per name, all in the same project, so only the names differ. */
function fieldsNamed(names: readonly string[]): MockYouTrackClient {
  return new MockYouTrackClient({
    projects: [
      {
        id: 'p',
        shortName: 'PRJ',
        name: 'Project',
        archived: false,
        issuesCount: 500,
        leader: { id: 'u', login: 'lead', banned: false },
      },
    ],
    customFields: names.map((name, index) => ({
      id: `f-${index}`,
      name,
      fieldType: 'enum[1]',
      instances: [{ id: `i-${index}`, projectShortName: 'PRJ', bundleId: `b-${index}` }],
    })),
    users: [],
    boards: [],
    groups: [],
    countRules: [{ match: /.*/, count: 100 }],
  });
}

async function duplicateNames(names: readonly string[]) {
  const check = CHECKS.find((c) => c.id === 'fields.duplicate-field-names');
  assert.ok(check);
  return check.run(contextOn(fieldsNamed(names)));
}

test('a field name is compared with the letters it is written in', async () => {
  /* Keeping only a-z leaves nothing at all of a name in Cyrillic or Japanese, and
     names that normalise to nothing all look alike: an instance that works in
     Russian would be told that every one of its fields repeats every other. */
  assert.equal(
    await duplicateNames(['Приоритет', 'Статус']),
    null,
    'three unrelated Cyrillic names are three names',
  );

  const repeated = await duplicateNames(['Приоритет', 'приоритет ', 'Статус']);
  assert.ok(repeated, 'the same Cyrillic name twice is still a repetition');
  assert.deepEqual(
    (repeated.items ?? []).map((i) => i.label),
    ['Приоритет / приоритет '],
  );
});

test('a name with nothing to compare is left out rather than filed under nothing', async () => {
  assert.equal(
    await duplicateNames(['---', '###', 'Priority']),
    null,
    'punctuation is not a name two fields can share',
  );
});

test('a field named after something every object carries is still just a name', async () => {
  // The names are looked up in a table of synonyms, and a plain object answers for
  // keys nobody put in it: "toString" would come back as a function, and the group
  // would be named after it.
  const finding = await duplicateNames(['toString', 'To string', 'Priority']);
  assert.ok(finding);
  assert.deepEqual(
    (finding.items ?? []).map((i) => i.id),
    ['tostring'],
  );
});
