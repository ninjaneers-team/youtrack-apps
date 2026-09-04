/**
 * Tests for the app's backend handler (src/backend.js).
 *
 * The handler runs in YouTrack's backend sandbox, but nothing it does depends on
 * that: it reads and writes strings on ctx.globalStorage.extensionProperties and
 * answers through ctx.response. A hand-built ctx is therefore enough to pin the
 * rules that matter - that a scan lands on the trend, that marking a finding
 * revises the newest point instead of adding one, that the trend stays bounded, and
 * that nothing but aggregates reaches storage.
 *
 * The sandbox loads the file as CommonJS, while this package is `type: "module"`,
 * so importing it here would fail on `exports`. Evaluating the source with an
 * `exports` object is what the sandbox does, and it keeps the shipped file in the
 * shape the instance expects. Types are declared once, here at the boundary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface FakeContext {
  globalStorage: { extensionProperties: Record<string, string | undefined> };
  request: { json(): unknown };
  response: { json(body: unknown): void; code?: number };
}

interface Endpoint {
  method: string;
  path: string;
  permissions?: string[];
  handle(ctx: FakeContext): void;
}

function loadHandler(): { endpoints: Endpoint[] } {
  const source = readFileSync(new URL('../src/backend.js', import.meta.url), 'utf8');
  const exported: { httpHandler?: { endpoints: Endpoint[] } } = {};
  new Function('exports', source)(exported);
  assert.ok(exported.httpHandler, 'backend.js must export an httpHandler');
  return exported.httpHandler;
}

const httpHandler = loadHandler();

const HISTORY_LIMIT = 24;

function endpoint(method: string, path: string): Endpoint {
  const found = httpHandler.endpoints.find(
    (e) => e.method === method && e.path === path,
  );
  assert.ok(found, `no ${method} ${path} endpoint`);
  return found;
}

interface Call {
  properties: Record<string, string | undefined>;
  body: unknown;
  /** Set by the handler when it refuses a request. */
  code?: number;
}

/** Calls one endpoint against the given storage and returns what it wrote and answered. */
function call(
  method: string,
  path: string,
  properties: Record<string, string | undefined>,
  requestBody: unknown = null,
): Call {
  let responseBody: unknown = null;
  const response = {
    json: (body: unknown): void => {
      responseBody = body;
    },
  };
  endpoint(method, path).handle({
    globalStorage: { extensionProperties: properties },
    request: { json: (): unknown => requestBody },
    response,
  });
  return { properties, body: responseBody, code: (response as { code?: number }).code };
}

function scanBody(at: string, score: number): Record<string, unknown> {
  return { score, minDays: 4.5, maxDays: 11, findings: 4, at };
}

interface StoredScan {
  score: number | null;
  at: string;
}

function storedHistory(properties: Record<string, string | undefined>): StoredScan[] {
  return JSON.parse(properties.scanHistory ?? '[]') as StoredScan[];
}

test('an empty instance reports no scan, no trend and nothing ignored', () => {
  const { body } = call('GET', 'state', {});

  /* The host comes from the request rather than from storage: without headers it is
     null, and then the report builds no links. */
  assert.deepEqual(body, {
    lastScan: null,
    lastRun: null,
    ignoredChecks: [],
    ignoredItems: [],
    history: [],
    scanStarted: null,
    host: null,
  });
});

test('a scan becomes the newest point of the trend', () => {
  const first = call('POST', 'scan', {}, scanBody('2026-08-01T00:00:00.000Z', 43));
  const second = call(
    'POST',
    'scan',
    first.properties,
    scanBody('2026-08-12T00:00:00.000Z', 73),
  );

  const history = storedHistory(second.properties);
  assert.deepEqual(
    history.map((h) => h.at),
    ['2026-08-12T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    'newest first',
  );
  assert.equal(history[0]?.score, 73);
});

test('re-scoring one scan revises its point rather than adding another', () => {
  // What marking a finding as intentional does: same scan, same timestamp, new score.
  const at = '2026-08-12T00:00:00.000Z';
  const scanned = call('POST', 'scan', {}, scanBody(at, 43));
  const remarked = call('POST', 'scan', scanned.properties, scanBody(at, 73));

  const history = storedHistory(remarked.properties);
  assert.equal(history.length, 1, 'a click on a finding is not a second scan');
  assert.equal(history[0]?.score, 73);
});

test('the trend keeps its most recent entries and drops the oldest', () => {
  let properties: Record<string, string | undefined> = {};
  for (let day = 1; day <= HISTORY_LIMIT + 5; day++) {
    const at = `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;
    properties = call('POST', 'scan', properties, scanBody(at, day)).properties;
  }

  const history = storedHistory(properties);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0]?.score, HISTORY_LIMIT + 5, 'newest kept');
  assert.equal(history[HISTORY_LIMIT - 1]?.score, 6, 'the first five fell off');
});

test('only aggregates reach storage, whatever the report sends', () => {
  const { properties } = call('POST', 'scan', {}, {
    ...scanBody('2026-08-12T00:00:00.000Z', 73),
    // Fields a future report version might carry along, on the scan itself and on
    // a check: the handler copies what it knows and drops the rest.
    summaries: ['Login broken for customer Contoso'],
    checks: [
      {
        id: 'licensing.inactive-users',
        status: 'finding',
        ratio: 0.6,
        headline: '3 of 5 licensed users, among them Contoso',
        items: [{ label: 'j.doe' }],
      },
    ],
  });

  const stored = properties.scanHistory ?? '';
  assert.ok(!stored.includes('Contoso'), 'no issue content in the trend');
  assert.ok(!stored.includes('j.doe'), 'no account names in the trend');
  assert.ok(!(properties.lastScan ?? '').includes('Contoso'), 'nor in the last scan');
  assert.deepEqual(Object.keys(storedHistory(properties)[0] ?? {}), [
    'score',
    'scoreAsMeasured',
    'findings',
    'at',
    'checks',
  ]);
  assert.deepEqual(
    Object.keys(
      (storedHistory(properties)[0] as { checks?: unknown[] }).checks?.[0] ?? {},
    ),
    ['id', 'status', 'ratio'],
  );
});

test('a scan stored before the trend existed becomes its first point', () => {
  // What an instance looks like right after this version is installed.
  const lastScan = JSON.stringify(scanBody('2026-08-01T00:00:00.000Z', 43));
  const { body } = call('GET', 'state', { lastScan });

  const state = body as { history: StoredScan[] };
  assert.deepEqual(
    state.history.map((h) => h.at),
    ['2026-08-01T00:00:00.000Z'],
    'the score already shown must not disappear from the tile',
  );
});

test('malformed storage is treated as no history, not as an error', () => {
  const { body } = call('GET', 'state', {
    scanHistory: '{not json',
    lastScan: 'also not json',
    ignoredChecks: '"a string, not an array"',
  });

  /* The host comes from the request rather than from storage: without headers it is
     null, and then the report builds no links. */
  assert.deepEqual(body, {
    lastScan: null,
    lastRun: null,
    ignoredChecks: [],
    ignoredItems: [],
    history: [],
    scanStarted: null,
    host: null,
  });
});

test('entries without a timestamp cannot sit on a trend and are dropped', () => {
  const { body } = call('GET', 'state', {
    scanHistory: JSON.stringify([{ score: 50 }, { score: 60, at: '2026-08-01T00:00:00.000Z' }]),
  });

  const state = body as { history: StoredScan[] };
  assert.deepEqual(state.history, [{ score: 60, at: '2026-08-01T00:00:00.000Z' }]);
});

test('every endpoint requires the app admin permission', () => {
  // The widgets are administrator-only, and an endpoint that answered everyone
  // would hand the same statement about the instance to any account with a login.
  for (const [method, path] of [
    ['GET', 'state'],
    ['POST', 'scan'],
    ['POST', 'ignore'],
  ] as const) {
    assert.deepEqual(
      endpoint(method, path).permissions,
      ['ADMIN_UPDATE_APP'],
      `${method} ${path} must not answer a non-administrator`,
    );
  }
});

test('marking one object stores the check and that object, and nothing else', () => {
  const { properties, body } = call('POST', 'ignore', {}, {
    checkId: 'portfolio.tiny-projects',
    item: 'SEED07',
    ignored: true,
    // What a future report version might send along; the handler copies two fields.
    label: 'Seed Project 7 - 4 issues',
    summary: 'Login broken for customer Contoso',
  });

  const stored = JSON.parse(properties.ignoredItems ?? '[]') as unknown[];
  assert.deepEqual(stored, [{ check: 'portfolio.tiny-projects', item: 'SEED07' }]);
  assert.ok(!(properties.ignoredItems ?? '').includes('Contoso'));
  assert.deepEqual(body, {
    ignoredChecks: [],
    ignoredItems: [{ check: 'portfolio.tiny-projects', item: 'SEED07' }],
  });
});

test('taking the mark off one object leaves the others alone', () => {
  const properties = {
    ignoredItems: JSON.stringify([
      { check: 'portfolio.tiny-projects', item: 'SEED07' },
      { check: 'portfolio.tiny-projects', item: 'SEED19' },
      { check: 'governance.empty-groups', item: '4-7' },
    ]),
  };

  call('POST', 'ignore', properties, {
    checkId: 'portfolio.tiny-projects',
    item: 'SEED07',
    ignored: false,
  });

  assert.deepEqual(JSON.parse(properties.ignoredItems), [
    { check: 'portfolio.tiny-projects', item: 'SEED19' },
    { check: 'governance.empty-groups', item: '4-7' },
  ]);
});

test('the objects of a check that names people are refused, not stored', async () => {
  const { CHECKS } = await import('../src/checks/catalog.ts');
  const naming = CHECKS.filter((check) => check.itemsNamePeople);
  assert.ok(naming.length > 0, 'at least one check drills down into accounts');

  /* The interface hides the control for these checks, but the interface is not the
     boundary: a login must not become an identifier in shared storage. Driven off
     the catalog, so a new check of this kind is covered the day it is added. */
  for (const check of naming) {
    const { properties, code } = call('POST', 'ignore', {}, {
      checkId: check.id,
      item: 'j.doe',
      ignored: true,
    });
    assert.equal(code, 400, `${check.id} must be refused`);
    assert.equal(properties.ignoredItems, undefined, 'nothing was stored');
  }

  // A check about configuration is accepted, so the refusal is not a blanket one.
  const ok = call('POST', 'ignore', {}, {
    checkId: 'portfolio.dormant-projects',
    item: 'WEB',
    ignored: true,
  });
  assert.equal(ok.code, undefined);
});

test('the number of marked objects is bounded', () => {
  const many = Array.from({ length: 500 }, (_, index) => ({
    check: 'portfolio.tiny-projects',
    item: `P${index}`,
  }));
  const properties = { ignoredItems: JSON.stringify(many) };

  const refused = call('POST', 'ignore', properties, {
    checkId: 'portfolio.tiny-projects',
    item: 'ONE-MORE',
    ignored: true,
  });

  // Storage is shared and holds aggregates; it does not become a list of the instance.
  assert.equal(refused.code, 400);
  assert.equal((JSON.parse(properties.ignoredItems) as unknown[]).length, 500);

  // Taking a mark off still works at the limit, or an instance could get stuck.
  const freed = call('POST', 'ignore', properties, {
    checkId: 'portfolio.tiny-projects',
    item: 'P0',
    ignored: false,
  });
  assert.equal(freed.code, undefined);
  assert.equal((JSON.parse(properties.ignoredItems) as unknown[]).length, 499);
});

test('malformed marks are dropped one by one, not all at once', () => {
  const { body } = call('GET', 'state', {
    ignoredItems: JSON.stringify([
      { check: 'portfolio.tiny-projects', item: 'SEED07' },
      { check: 'portfolio.tiny-projects' },
      null,
      { item: 'SEED19' },
    ]),
  });

  assert.deepEqual((body as { ignoredItems: unknown[] }).ignoredItems, [
    { check: 'portfolio.tiny-projects', item: 'SEED07' },
  ]);
});

/** One check of a scan, in the shape the report posts it. */
function checkBody(id: string, items: unknown[] = []): Record<string, unknown> {
  return {
    id,
    status: 'finding',
    finding: {
      severity: 'medium',
      headline: `${items.length} of 40 projects`,
      ratio: 0.25,
      total: 40,
      itemKind: 'project',
      evidence: [{ label: 'Affected', value: items.length }],
      items,
    },
  };
}

test('a scan keeps its findings, and the trend keeps only its numbers', () => {
  const { properties, body } = call('POST', 'scan', {}, {
    score: 73,
    scoreAsMeasured: 73,
    findings: 1,
    at: '2026-08-01T00:00:00.000Z',
    requests: 412,
    seconds: 50,
    throttled: 2,
    checks: [checkBody('portfolio.tiny-projects', [{ id: 'WEB', label: 'WEB' }])],
  });

  const run = JSON.parse(properties.lastRun ?? 'null');
  assert.equal(run.at, '2026-08-01T00:00:00.000Z');
  assert.equal(run.requests, 412);
  assert.deepEqual(run.checks[0].finding.items, [{ id: 'WEB', label: 'WEB' }]);
  assert.equal(run.checks[0].finding.headline, '1 of 40 projects');
  assert.equal((body as { lastRun: unknown }).lastRun !== null, true);

  /* The trend is twenty-four entries deep and made of numbers; the findings are
     kept once. Both come out of the same body, and neither carries the other. */
  const [newest] = storedHistory(properties) as unknown as Array<{
    checks: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(newest?.checks, [
    { id: 'portfolio.tiny-projects', status: 'finding', ratio: 0.25 },
  ]);
});

test('the weight of an object survives the handler, or a marked object rescores', () => {
  const { properties } = call('POST', 'scan', {}, {
    score: 62,
    findings: 1,
    at: '2026-08-01T00:00:00.000Z',
    checks: [
      {
        id: 'process.aging-wip',
        status: 'finding',
        finding: {
          severity: 'critical',
          headline: '20 of 25 cards in progress have not moved',
          ratio: 0.8,
          affected: 20,
          total: 25,
          itemKind: 'board',
          evidence: [],
          items: [
            { id: '99-1', label: 'Backlog board', detail: '18 of 18 cards', affected: 18, measured: 18 },
          ],
        },
      },
    ],
  });

  const run = JSON.parse(properties.lastRun ?? 'null');
  const { finding } = run.checks[0];
  /* Numbers about the instance's own configuration, and the score of the restored
     run stands on them: a board marked as intentional has to take its cards with
     it, not count as one board of a list. */
  assert.equal(finding.affected, 20);
  assert.deepEqual(finding.items, [
    { id: '99-1', label: 'Backlog board', detail: '18 of 18 cards', affected: 18, measured: 18 },
  ]);
});

test('the accounts of a check that names people stay out of the kept run', async () => {
  const { CHECKS } = await import('../src/checks/catalog.ts');
  const naming = CHECKS.filter((check) => check.itemsNamePeople);
  assert.ok(naming.length > 0, 'at least one check drills down into accounts');

  for (const check of naming) {
    const { properties } = call('POST', 'scan', {}, {
      score: 73,
      findings: 1,
      at: '2026-08-01T00:00:00.000Z',
      checks: [checkBody(check.id, [{ id: '1-5', label: 'j.doe', detail: 'no trace' }])],
    });

    const run = JSON.parse(properties.lastRun ?? 'null');
    const [kept] = run.checks;
    // The count and the sentence about it stay; the logins do not.
    assert.equal(kept.finding.items, undefined, `${check.id} must not keep accounts`);
    assert.equal(kept.finding.headline, '1 of 40 projects');
    assert.ok(!(properties.lastRun ?? '').includes('j.doe'));
  }
});

test('a run too large for storage loses its objects, not its findings', () => {
  /* A property holds four megabytes and a longer write is refused outright, which
     would lose the scan at the moment it succeeded. Over budget the objects go. */
  const many = Array.from({ length: 20000 }, (_, index) => ({
    id: `0-${index}`,
    label: `PROJECT-${index}`,
    detail: 'no activity in the last 365 days, 400 issues, 12 boards',
  }));

  const { properties } = call('POST', 'scan', {}, {
    score: 40,
    findings: 1,
    at: '2026-08-01T00:00:00.000Z',
    checks: [checkBody('portfolio.dormant-projects', many)],
  });

  const run = JSON.parse(properties.lastRun ?? 'null');
  assert.equal(run.itemsOmitted, true);
  assert.equal(run.checks[0].finding.items, undefined);
  assert.equal(run.checks[0].finding.ratio, 0.25);
  assert.ok(JSON.stringify(run).length < 1048576);
});

test('a kept run that cannot be read is no run, and does not replace itself', () => {
  const { body } = call('GET', 'state', {lastRun: '{"checks":'});
  assert.equal((body as { lastRun: unknown }).lastRun, null);

  // A scan without checks cannot overwrite a readable report with an empty one.
  const kept = JSON.stringify({at: '2026-08-01T00:00:00.000Z', requests: 1, checks: [
    {id: 'portfolio.tiny-projects', status: 'finding'},
  ]});
  const properties = {lastRun: kept};
  call('POST', 'scan', properties, {score: 50, findings: 0, at: '2026-08-02T00:00:00.000Z'});
  assert.equal(properties.lastRun, kept);
});

test('a scan says it is under way, and only clears its own mark', () => {
  const first = '2026-08-01T09:00:00.000Z';
  const second = '2026-08-01T09:00:03.000Z';

  const started = call('POST', 'started', {}, {at: first});
  assert.equal(started.properties.scanStarted, first);
  assert.deepEqual(started.body, {scanStarted: first});

  /* Two scans at once is the case this exists for: the second one overwrites the
     mark, and when the first one finishes it must not report the second as over. */
  const overlapping = call('POST', 'started', started.properties, {at: second});
  const firstDone = call('POST', 'started', overlapping.properties, {
    at: first,
    done: true,
  });
  assert.equal(firstDone.properties.scanStarted, second, 'the running scan keeps its mark');

  const secondDone = call('POST', 'started', firstDone.properties, {
    at: second,
    done: true,
  });
  assert.equal(secondDone.properties.scanStarted, null);
  assert.deepEqual(secondDone.body, {scanStarted: null});
});

test('a mark that is not a timestamp is refused, and no scan is reported', () => {
  for (const at of ['a moment ago', '', '2026-08-01', 'x'.repeat(101)]) {
    const bad = call('POST', 'started', {}, {at});
    assert.equal(bad.code, 400, `${at || 'empty'} is not a timestamp`);
    assert.equal(bad.properties.scanStarted, undefined);
  }
  // Nor is one believed on the way out: the value becomes a sentence about age.
  const { body } = call('GET', 'state', {scanStarted: 'right now'});
  assert.equal((body as {scanStarted: unknown}).scanStarted, null);
});

test('a value that cannot be an identifier is refused, not stored', () => {
  /* Only an administrator reaches these endpoints, so this is not about an
     attacker. It is about a mistake: a wrong value copied into storage until the
     property hits its four-megabyte ceiling, after which every write of it fails
     and the app quietly stops keeping anything. The length allowed is long enough
     for an id a check builds out of names in the instance - a project key and a
     field name side by side - and five hundred of them still occupy a thirtieth of
     what one property holds. */
  const tooLong = 'x'.repeat(251);

  const longItem = call('POST', 'ignore', {}, {
    checkId: 'portfolio.tiny-projects',
    item: tooLong,
    ignored: true,
  });
  assert.equal(longItem.code, 400);
  assert.equal(longItem.properties.ignoredItems, undefined);

  const longCheck = call('POST', 'ignore', {}, {checkId: tooLong, ignored: true});
  assert.equal(longCheck.code, 400);
  assert.equal(longCheck.properties.ignoredChecks, undefined);

  // A scan hangs off its timestamp: the trend is ordered by it, and marking a
  // finding revises the point that carries it.
  for (const at of ['yesterday', '', '2026-08-01', tooLong]) {
    const scan = call('POST', 'scan', {}, {score: 50, findings: 0, at});
    assert.equal(scan.code, 400, `${at || 'empty'} is not a timestamp`);
    assert.equal(scan.properties.lastScan, undefined);
  }
});

test('a scan carries the checks of this app, not an unbounded list', () => {
  const many = Array.from({ length: 500 }, (_, index) => checkBody(`made.up-${index}`));
  const { properties } = call('POST', 'scan', {}, {
    score: 50,
    findings: 0,
    at: '2026-08-01T00:00:00.000Z',
    checks: many,
  });

  // The catalog holds fifteen. The bound is room to grow, not a promise.
  const stored = JSON.parse(properties.lastScan ?? '{}') as { checks: unknown[] };
  assert.equal(stored.checks.length, 200);
  const run = JSON.parse(properties.lastRun ?? '{}') as { checks: unknown[] };
  assert.equal(run.checks.length, 200);
});

test('every property the handler writes is declared in the storage schema', () => {
  const source = readFileSync(new URL('../src/backend.js', import.meta.url), 'utf8');
  const declared = JSON.parse(
    readFileSync(new URL('../src/entity-extensions.json', import.meta.url), 'utf8'),
  ) as { entityTypeExtensions: Array<{ properties: Record<string, unknown> }> };
  const known = new Set(
    declared.entityTypeExtensions.flatMap((ext) => Object.keys(ext.properties)),
  );

  const used = new Set(
    [...source.matchAll(/extensionProperties\.(\w+)/g)].map((match) => match[1] ?? ''),
  );

  /* An undeclared property is not an error at runtime: the write is dropped and the
     value is simply never there again. That cost an afternoon once. */
  for (const property of used) {
    assert.ok(
      known.has(property),
      `${property} is written by the handler but not declared in entity-extensions.json`,
    );
  }
  assert.ok(used.size > 0, 'the handler keeps state, so it writes something');
});

test('every word the app itself uses survives the handler', async () => {
  const [{ CHECKS }, { runChecks }, { checksForStorage }, { DEFAULT_CONFIG }, mock] =
    await Promise.all([
      import('../src/checks/catalog.ts'),
      import('../src/engine.ts'),
      import('../src/stored-run.ts'),
      import('../src/types.ts'),
      import('./mock-client.ts'),
    ]);
  const now = new Date('2026-08-11T00:00:00.000Z');
  const outcomes = await runChecks(CHECKS, {
    client: mock.syntheticInstance(now),
    config: DEFAULT_CONFIG,
    now,
  });
  const checks = checksForStorage(outcomes, CHECKS);

  const { properties } = call('POST', 'scan', {}, {
    ...scanBody(now.toISOString(), 58),
    checks,
  });

  /* The handler keeps only the words it knows - a status, a severity, a kind of
     object - and a list it does not know is a list it drops. Driven off a real scan
     so that a severity or a kind added to the catalog cannot quietly stop being
     stored: this test fails the day the two sides drift. */
  const stored = JSON.parse(properties.lastRun ?? '{}') as {
    checks: { id: string; status: string; finding?: { severity: string; itemKind?: string } }[];
  };
  const accountCheck = CHECKS.filter((c) => c.itemsNamePeople).map((c) => c.id);
  assert.deepEqual(
    stored.checks.map((c) => c.id),
    checks.map((c) => c.id),
    'not one check was dropped on the way into storage',
  );
  for (const sent of checks) {
    const kept = stored.checks.find((c) => c.id === sent.id);
    assert.equal(kept?.status, sent.status, `${sent.id} kept its status`);
    assert.equal(
      kept?.finding?.severity,
      sent.finding?.severity,
      `${sent.id} kept its severity`,
    );
    assert.equal(
      kept?.finding?.itemKind,
      sent.finding?.itemKind,
      `${sent.id} kept the kind of object it named`,
    );
  }
  assert.ok(accountCheck.length > 0, 'the accounts check is part of this run');

  /* Said out loud, so the loop above cannot become vacuous: this run names every
     kind of object the reports know. A kind added to one side and not to the other
     fails here rather than turning into a name without a link months later. */
  const { ITEM_NOUN } = await import('../src/report-shared.ts');
  assert.deepEqual(
    [...new Set(checks.map((c) => c.finding?.itemKind).filter(Boolean))].sort(),
    Object.keys(ITEM_NOUN).sort(),
  );

  /* Severity and status are not all covered by one instance, so they are sent on
     their own. The severities come from the constant the score is built on; the
     statuses are the four an outcome can carry. */
  const { SEVERITY_FACTOR } = await import('../src/types.ts');
  const severities = Object.keys(SEVERITY_FACTOR);
  const statuses = ['finding', 'clean', 'skipped', 'failed'];
  const sent = [
    ...severities.map((severity, index) => ({
      id: `severity.${index}`,
      status: 'finding',
      finding: { severity, headline: 'h', ratio: 0.5, evidence: [] },
    })),
    ...statuses.map((status, index) => ({ id: `status.${index}`, status })),
  ];
  const round = call('POST', 'scan', {}, {
    ...scanBody('2026-08-12T00:00:00.000Z', 58),
    checks: sent,
  });
  const back = JSON.parse(round.properties.lastRun ?? '{}') as {
    checks: { id: string; status: string; finding?: { severity: string } }[];
  };
  assert.deepEqual(
    back.checks.map((c) => c.finding?.severity ?? c.status),
    [...severities, ...statuses],
    'every severity and every status the app produces is one the handler keeps',
  );

  const aggregates = JSON.parse(properties.lastScan ?? '{}') as {
    checks: { id: string }[];
  };
  assert.equal(aggregates.checks.length, checks.length, 'and none off the trend');
});

test('a value the app does not use is left out rather than stored', () => {
  const { properties } = call('POST', 'scan', {}, {
    ...scanBody('2026-08-11T00:00:00.000Z', 58),
    checks: [
      { id: 'a.status', status: 'in progress' },
      {
        id: 'b.severity',
        status: 'finding',
        finding: { severity: 'urgent', headline: 'h', ratio: 0.5, evidence: [] },
      },
      {
        id: 'c.kind',
        status: 'finding',
        finding: {
          severity: 'low',
          headline: 'h',
          ratio: 0.5,
          evidence: [],
          itemKind: 'issue',
          items: [{ id: 'X', label: 'X' }],
        },
      },
    ],
  });

  const stored = JSON.parse(properties.lastRun ?? '{}') as {
    checks: { id: string; finding?: { itemKind?: string; items?: unknown[] } }[];
  };
  /* A status that is not a status cannot be placed, and a finding without a
     severity cannot be shown the way findings are shown - so both checks stay out.
     An unknown kind of object only costs the link: the name is still true. */
  assert.deepEqual(stored.checks.map((c) => c.id), ['c.kind']);
  assert.equal(stored.checks[0]?.finding?.itemKind, undefined);
  assert.equal(stored.checks[0]?.finding?.items?.length, 1);

  const aggregates = JSON.parse(properties.lastScan ?? '{}') as {
    checks: { id: string }[];
  };
  assert.deepEqual(
    aggregates.checks.map((c) => c.id),
    ['b.severity', 'c.kind'],
    'the trend keeps what has a status, whatever its finding turned out to be',
  );
});

test('a request that is not an object is refused, not left to throw', () => {
  /* Nothing the app sends looks like this. What matters is the shape of the
     failure: reading a field off a body that is not an object throws, and an
     exception in the sandbox is a 500 with no answer in it - so a caller with a
     bug would learn nothing about what it got wrong. */
  for (const body of [null, undefined, 42, 'text', [], true]) {
    for (const [method, path] of [
      ['POST', 'scan'],
      ['POST', 'started'],
      ['POST', 'ignore'],
    ] as const) {
      const answer = call(method, path, {}, body);
      assert.equal(answer.code, 400, `${path} refused ${String(body)}`);
      assert.match(
        (answer.body as { error: string }).error,
        /must be/,
        `${path} says which field it needs`,
      );
    }
  }
});

test('the list of marked checks cannot grow without an end', () => {
  /* A mark is stored under an identifier, and the identifier is bounded in length -
     but a list of them was not bounded in count. Filled up, the property passes the
     four megabytes YouTrack keeps for one, and from then on every write of it fails:
     the instance could no longer mark anything, or take a mark off. */
  const properties: Record<string, string | undefined> = {};
  let refused = 0;
  for (let i = 0; i < 400; i++) {
    const answer = call('POST', 'ignore', properties, { checkId: `check.${i}`, ignored: true });
    if (answer.code === 400) refused++;
  }
  const marked = JSON.parse(properties.ignoredChecks ?? '[]') as string[];
  assert.ok(marked.length <= 200, `${marked.length} marked checks is bounded`);
  assert.ok(refused > 0, 'the request past the bound is answered, not stored');
});

test('a stored mark of an object that is not an identifier does not survive either', () => {
  /* The marked objects are read and written back exactly like the marked checks,
     so the gate on the way in is worth nothing without the same gate on the way
     out. */
  const properties = {
    ignoredItems: JSON.stringify([
      { check: 'portfolio.tiny-projects', item: 'PRJ' },
      { check: 'portfolio.tiny-projects', item: 'x'.repeat(1000) },
      { check: 42, item: 'PRJ' },
      { check: 'portfolio.tiny-projects' },
      null,
    ]),
  };
  call('POST', 'ignore', properties, {
    checkId: 'portfolio.dormant-projects',
    item: 'OLD',
    ignored: true,
  });

  assert.deepEqual(JSON.parse(properties.ignoredItems ?? '[]'), [
    { check: 'portfolio.tiny-projects', item: 'PRJ' },
    { check: 'portfolio.dormant-projects', item: 'OLD' },
  ]);
});

test('a scan whose numbers are missing lands on the trend as numbers', () => {
  /* JSON has no NaN: it writes one as null, and a trend point at no height draws
     nothing while still counting as a scan. Every number of a scan is therefore
     read as a number or not at all. */
  const properties: Record<string, string | undefined> = {};
  const { body } = call('POST', 'scan', properties, { at: '2026-08-11T09:00:00.000Z' });

  const stored = (body as {
    lastScan: { score: number | null; scoreAsMeasured: number | null; findings: number };
  }).lastScan;
  // A score of null is a scan in which nothing ran, which is a statement. A count
  // of nothing is zero.
  assert.equal(stored.score, null);
  assert.equal(stored.scoreAsMeasured, null);
  assert.equal(stored.findings, 0);
  assert.deepEqual(JSON.parse(properties.lastScan ?? '{}').findings, 0);
});

test('a stored mark that is not an identifier does not survive the next write', () => {
  const properties = {
    ignoredChecks: '[{"a":1},null,123,["x"],"fields.empty-field"]',
  };
  call('POST', 'ignore', properties, { checkId: 'governance.empty-groups', ignored: true });

  assert.deepEqual(
    JSON.parse(properties.ignoredChecks ?? '[]'),
    ['fields.empty-field', 'governance.empty-groups'],
    'what is read is written back, so only identifiers may be read',
  );
});

test('a scan whose timestamp cannot be read is not handed to a widget', () => {
  /* Both widgets turn this into a date, and a value no date can be made of throws
     while the view renders - an empty frame that reloading does not cure. The
     timestamp is therefore checked on the way out as well as on the way in. */
  const answer = call('GET', 'state', {
    lastScan: '{"at":"whenever","score":50,"findings":1}',
    lastRun: '{"at":"whenever","checks":[{"id":"c","status":"clean"}]}',
    scanHistory: '[{"at":"whenever","score":50}]',
  });
  const state = answer.body as { lastScan: unknown; lastRun: unknown; history: unknown[] };
  assert.equal(state.lastScan, null);
  assert.equal(state.lastRun, null);
  assert.deepEqual(state.history, []);
});

test('every object a check names can be marked as intentional', async () => {
  /* The report offers a mark per object, and the handler stores it under the
     object's own id. An id the handler will not take - empty, or longer than it
     believes - costs twice: the object is dropped from the stored run, and the
     mark the report offers is refused. Driven off a real scan, so a check that
     builds an id out of names in the instance cannot drift away from this. */
  const [{ CHECKS }, { runChecks }, { checksForStorage }, { DEFAULT_CONFIG }, mock] =
    await Promise.all([
      import('../src/checks/catalog.ts'),
      import('../src/engine.ts'),
      import('../src/stored-run.ts'),
      import('../src/types.ts'),
      import('./mock-client.ts'),
    ]);
  const now = new Date('2026-08-11T00:00:00.000Z');
  const outcomes = await runChecks(CHECKS, {
    client: mock.syntheticInstance(now),
    config: DEFAULT_CONFIG,
    now,
  });
  const checks = checksForStorage(outcomes, CHECKS);
  const { properties } = call('POST', 'scan', {}, {
    ...scanBody(now.toISOString(), 58),
    checks,
  });
  const stored = JSON.parse(properties.lastRun ?? '{}') as {
    checks: { id: string; finding?: { items?: { id: string }[] } }[];
  };

  let named = 0;
  for (const sent of checks) {
    const kept = stored.checks.find((c) => c.id === sent.id);
    assert.deepEqual(
      kept?.finding?.items?.map((i) => i.id),
      sent.finding?.items?.map((i) => i.id),
      `${sent.id} kept every object it named`,
    );
    for (const item of sent.finding?.items ?? []) {
      named++;
      const answer = call('POST', 'ignore', { ...properties }, {
        checkId: sent.id,
        item: item.id,
        ignored: true,
      });
      assert.equal(answer.code, undefined, `${sent.id} can mark ${item.id}`);
    }
  }
  assert.ok(named > 0, 'this run names objects at all');
});
