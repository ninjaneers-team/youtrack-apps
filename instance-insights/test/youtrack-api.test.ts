import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, YouTrackApiClient } from '../src/youtrack-api.ts';
import type { ApiTransport, RequestOptions } from '../src/youtrack-api.ts';

/**
 * The REST mapping against a recorded transport.
 *
 * The one behaviour worth guarding above all others: YouTrack answers with the
 * first 42 entries of a collection unless asked otherwise. A client that forgets
 * `$top` produces a report about 42 users on an instance of five hundred - numbers
 * that look right and describe a different instance.
 */

/** The pacing is a property of its own, tested below; elsewhere it only slows tests. */
const NO_GAP = 0;

interface RecordedCall {
  path: string;
  options: RequestOptions;
}

/** Serves `total` entries in pages, and records every request it answered. */
function pagedTransport(
  total: number,
  calls: RecordedCall[],
  entry: (index: number) => unknown = index => ({ id: `e-${index}`, name: `Entry ${index}` }),
): ApiTransport {
  return <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    calls.push({ path, options });
    if (path === 'issuesGetter/count') {
      return Promise.resolve({ count: 0 } as T);
    }
    const top = Number(options.query?.$top ?? 42);
    const skip = Number(options.query?.$skip ?? 0);
    const page = Array.from({ length: Math.max(0, Math.min(top, total - skip)) }, (_, i) =>
      entry(skip + i),
    );
    return Promise.resolve(page as T);
  };
}

test('a collection larger than one page is read completely', async () => {
  const calls: RecordedCall[] = [];
  const client = new YouTrackApiClient(pagedTransport(1201, calls), { gapMs: NO_GAP });

  const users = await client.listUsers();

  assert.equal(users.length, 1201, 'every user has to be in the result');
  const userCalls = calls.filter(c => c.path === 'users');
  assert.equal(userCalls.length, 3, 'three pages of 500 cover 1201 entries');
  assert.deepEqual(
    userCalls.map(c => c.options.query?.$skip),
    ['0', '500', '1000'],
    'pages follow each other without a gap',
  );
});

test('every list asks for a page size, so nothing is cut at 42', async () => {
  const calls: RecordedCall[] = [];
  const client = new YouTrackApiClient(pagedTransport(10, calls), { gapMs: NO_GAP });

  await client.listUsers();
  await client.listProjects();
  await client.listCustomFields();
  await client.listAgileBoards();
  await client.listGroups();

  const lists = calls.filter(c => c.path !== 'issuesGetter/count');
  assert.ok(lists.length >= 5);
  for (const call of lists) {
    assert.ok(
      Number(call.options.query?.$top) > 42,
      `${call.path} must ask for more than the default page of 42`,
    );
  }
});

test('a list that never ends stops the scan instead of returning a part', async () => {
  const calls: RecordedCall[] = [];
  // A transport that always answers with a full page: paging can never finish.
  const endless: ApiTransport = <T>(path: string, options: RequestOptions = {}) => {
    calls.push({ path, options });
    const top = Number(options.query?.$top ?? 42);
    return Promise.resolve(
      Array.from({ length: top }, (_, i) => ({ id: `e-${i}` })) as T,
    );
  };
  const client = new YouTrackApiClient(endless, { gapMs: NO_GAP });

  await assert.rejects(
    () => client.listGroups(),
    /rather than report on a part of the instance/,
    'the client refuses to page forever, and says why',
  );
});

test('a list is fetched once per scan, however many checks ask for it', async () => {
  const calls: RecordedCall[] = [];
  const client = new YouTrackApiClient(pagedTransport(3, calls), { gapMs: NO_GAP });

  await Promise.all([client.listGroups(), client.listGroups(), client.listGroups()]);

  assert.equal(
    calls.filter(c => c.path === 'groups').length,
    1,
    'the list is cached for the whole scan',
  );
});

test('the activity lookup asks for the newest entry only', async () => {
  const calls: RecordedCall[] = [];
  const client = new YouTrackApiClient(
    pagedTransport(1, calls, () => ({ timestamp: 1_700_000_000_000 })),
    { gapMs: NO_GAP },
  );

  const last = await client.lastActivity('2-1');

  assert.equal(last, 1_700_000_000_000);
  const call = calls.find(c => c.path === 'activities');
  assert.equal(call?.options.query?.$top, '1');
  assert.equal(call?.options.query?.reverse, 'true');
  assert.ok(
    (call?.options.query?.categories ?? '').includes('CommentsCategory'),
    'the endpoint answers 400 without an explicit category list',
  );
});

test('a slow answer is not followed by a pause on top of it', async () => {
  // The gap is a ceiling on requests per second, not a tax on each answer: an
  // instance that takes longer than the gap to answer has already spaced them out.
  const gap = 40;
  const answerMs = 60;
  const slow: ApiTransport = <T>() =>
    new Promise<T>(resolve => setTimeout(() => resolve([] as T), answerMs));
  const client = new YouTrackApiClient(slow, { gapMs: gap });

  const started = Date.now();
  await client.listUsers();
  await client.listGroups();
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 2 * answerMs + gap,
    `two answers of ${answerMs} ms took ${elapsed} ms, so a pause was added on top`,
  );
});

test('no more requests are in flight than allowed, and never closer than the gap',
  async () => {
    const gap = 10;
    const starts: number[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const slow: ApiTransport = <T>() => {
      starts.push(Date.now());
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      return new Promise<T>(resolve =>
        setTimeout(() => {
          running--;
          resolve([{ timestamp: 1 }] as T);
        }, 30),
      );
    };
    const client = new YouTrackApiClient(slow, { gapMs: gap });

    /* Activity lookups, not counts: a count is asked for one at a time on purpose,
       so it would measure that instead of the room-keeping. Enough of them for the
       limit to grow from one to its cap and stay there. */
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => client.lastActivity(`u-${i}`)),
    );

    assert.equal(starts.length, 40, 'one request per lookup');
    assert.ok(mostAtOnce > 1, 'requests overlap once the instance keeps answering');
    assert.ok(mostAtOnce <= 3, `${mostAtOnce} requests were in flight at once`);
    const tolerance = 5;
    for (let i = 1; i < starts.length; i++) {
      const distance = starts[i]! - starts[i - 1]!;
      assert.ok(
        distance >= gap - tolerance,
        `request ${i} started ${distance} ms after the one before it`,
      );
    }
  });

test('counts overlap, because a fresh one is answered twice whatever we do', async () => {
  /* The endpoint computes on the first ask and answers -1 while it works, so a
     count nobody asked for before costs two requests either way. Measured over
     forty projects with queries the instance had never seen: overlapping cost 80
     requests and 4.0 s, one at a time the same 80 requests and 6.6 s - the waiting
     moves into the critical path instead of hiding behind the gap. So they overlap
     on purpose, and this holds that decision. */
  let running = 0;
  let mostAtOnce = 0;
  const asked = new Map<string, number>();
  const computing: ApiTransport = <T>(_path: string, options: RequestOptions = {}) => {
    const query = String((options.body as {query?: string} | undefined)?.query ?? '');
    const times = (asked.get(query) ?? 0) + 1;
    asked.set(query, times);
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    return new Promise<T>(resolve =>
      setTimeout(() => {
        running--;
        // -1 on the first ask, the number on the second: how the endpoint behaves.
        resolve({ count: times === 1 ? -1 : 5 } as T);
      }, 20),
    );
  };
  const client = new YouTrackApiClient(computing, { gapMs: 1 });

  const results = await client.countMany(Array.from({ length: 9 }, (_, i) => `#Unresolved ${i}`));

  assert.ok(mostAtOnce > 1, 'counts are not asked for one at a time');
  assert.deepEqual(results, Array.from({ length: 9 }, () => ({ count: 5 })));
});

test('a count the instance had not finished is asked for once more', async () => {
  /* The first ask starts the computation and the instance keeps the result, so the
     answer is usually waiting once the batch is done and nothing else is in flight.
     Without this, one slow project took the project list down with it - and with it
     every check that needs one, nine of twenty-two on a live instance. */
  const asked: string[] = [];
  const slowOne: ApiTransport = <T>(_path: string, options: RequestOptions = {}) => {
    const query = String((options.body as {query?: string} | undefined)?.query ?? '');
    asked.push(query);
    // Never finished while the batch ran; ready afterwards, as the endpoint does.
    const done = query !== 'slow' || asked.filter((q) => q === 'slow').length > 3;
    return Promise.resolve({ count: done ? 4 : -1 } as T);
  };
  const client = new YouTrackApiClient(slowOne, { gapMs: 0, countBudgetMs: 30 });

  const results = await client.countMany(['fine', 'slow', 'also fine']);

  assert.deepEqual(results, [{ count: 4 }, { count: 4 }, { count: 4 }]);
  assert.ok(
    asked.filter((q) => q === 'slow').length > 3,
    'the unfinished count was asked for again after the batch',
  );
});

test('one refused count does not reject the ones queued behind it', async () => {
  // They share a lane, so a failure must not travel along it.
  let asked = 0;
  const picky: ApiTransport = <T>() => {
    asked++;
    if (asked === 1) {
      return Promise.reject(new ApiError(400, 'issuesGetter/count', 'unparseable'));
    }
    return Promise.resolve({ count: 3 } as T);
  };
  const client = new YouTrackApiClient(picky, { gapMs: 0 });

  const results = await client.countMany(['broken', 'fine', 'fine too']);

  const refused = results[0];
  assert.ok(refused && 'failed' in refused, 'the refused one says so');
  /* Named, not merely failed: without the reason this test passed once against a
     transport that threw for an entirely different cause. */
  assert.match(refused.failed, /400/);
  assert.match(refused.failed, /query: broken/);
  assert.deepEqual(results.slice(1), [{ count: 3 }, { count: 3 }]);
});

test('waiting for a turn costs one wake-up per request, not one per gap', async () => {
  /* A check can hand a whole instance to countMany at once, and the pacing used to
     be enforced by every waiting request asking again every millisecond: 322 000
     timers for eight hundred counts, growing with the square of the batch, all of
     it inside a widget iframe. The turn is claimed now, so the cost is linear. */
  const realSetTimeout = globalThis.setTimeout;
  let timers = 0;
  const queries = 200;
  try {
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      timers++;
      return realSetTimeout(fn, ms);
    }) as typeof globalThis.setTimeout;
    const client = new YouTrackApiClient(
      <T>() =>
        new Promise<T>((resolve) => {
          realSetTimeout(() => resolve({ count: 1 } as T), 1);
        }),
      { gapMs: 1 },
    );
    await client.countMany(Array.from({ length: queries }, (_, i) => `#Unresolved ${i}`));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  // Two per request: the turn and the request timeout. The bound is generous.
  assert.ok(
    timers <= queries * 4,
    `${timers} timers for ${queries} requests is more than a handful each`,
  );
});

test('the first rate limit ends the overlapping for the rest of the scan',
  async () => {
    let sent = 0;
    let running = 0;
    let watching = false;
    let mostAtOnce = 0;
    const limited: ApiTransport = <T>() => {
      sent++;
      // The instance answers a while, then asks for a pause once.
      if (sent === 12) {
        return Promise.reject({ status: 429, error: 'Too Many Requests' });
      }
      running++;
      if (watching) {
        mostAtOnce = Math.max(mostAtOnce, running);
      }
      return new Promise<T>(resolve =>
        setTimeout(() => {
          running--;
          resolve({ count: 1 } as T);
        }, 5),
      );
    };
    const client = new YouTrackApiClient(limited, { gapMs: 0, backoffMs: 1 });

    // Long enough for the limit to have grown before the 429 arrives.
    await client.countMany(Array.from({ length: 30 }, (_, i) => `#Unresolved ${i}`));

    /* Requests that were already in flight when the 429 came back still finish, so
       the claim is about what happens afterwards: a second batch, on an instance
       that answers everything, must not overlap again. */
    watching = true;
    await client.countMany(Array.from({ length: 20 }, (_, i) => `#Unresolved b${i}`));

    assert.equal(mostAtOnce, 1, 'after a 429 the scan stays at one request at a time');
  });

test('a request that does not answer stops holding the scan', async () => {
  const never: ApiTransport = <T>() => new Promise<T>(() => undefined);
  const client = new YouTrackApiClient(never, { gapMs: NO_GAP, timeoutMs: 30 });

  await assert.rejects(
    () => client.listUsers(),
    /did not answer within 30 ms/,
    'the scan says which request it gave up on',
  );
});

test('a rate-limited request is repeated after a pause', async () => {
  let attempts = 0;
  const limited: ApiTransport = <T>() => {
    attempts++;
    if (attempts === 1) {
      const err = Object.assign(new Error('too many requests'), { status: 429 });
      return Promise.reject(err);
    }
    return Promise.resolve([] as T);
  };
  const client = new YouTrackApiClient(limited, { gapMs: NO_GAP, backoffMs: 5 });

  assert.deepEqual(await client.listGroups(), []);
  assert.equal(attempts, 2, 'the second attempt is the one that answered');
});

test('an instance that keeps rate-limiting is reported, not retried forever', async () => {
  let attempts = 0;
  // 503 is what the proxy in front of an on-premise instance answers under load.
  const overloaded: ApiTransport = <T>(): Promise<T> => {
    attempts++;
    return Promise.reject(new Error('YouTrack 503 on groups: Service Unavailable'));
  };
  const client = new YouTrackApiClient(overloaded, { gapMs: NO_GAP, backoffMs: 1 });

  await assert.rejects(
    () => client.listGroups(),
    /answered 503 .* on all 4 attempts: it limits how many requests it accepts/s,
    'the message names the cause instead of blaming the check',
  );
  assert.equal(attempts, 4, 'one attempt plus three retries');
});

test('a rejected query is not retried, however often it is sent', async () => {
  let attempts = 0;
  const rejected: ApiTransport = <T>(): Promise<T> => {
    attempts++;
    return Promise.reject(
      new Error("YouTrack 400 on issuesGetter/count: Can't parse search query"),
    );
  };
  const client = new YouTrackApiClient(rejected, { gapMs: NO_GAP, backoffMs: 1 });

  await assert.rejects(() => client.count('has: {project}'), /Can't parse search query/);
  assert.equal(attempts, 1, 'a query the instance refuses is refused again');
});

test('a request the scan gave up on is ended, not left running', async () => {
  let toldToStop = false;
  const hanging: ApiTransport = <T>(_path: string, options: RequestOptions = {}): Promise<T> => {
    options.signal?.addEventListener('abort', () => {
      toldToStop = true;
    });
    // Never answers, which is the case the timeout exists for.
    return new Promise<T>(() => undefined);
  };
  const client = new YouTrackApiClient(hanging, { gapMs: NO_GAP, timeoutMs: 20 });

  await assert.rejects(() => client.listGroups(), /did not answer within 20 ms/);
  /* Giving up on an answer and ending the request are two different things: the
     second is what releases the socket a Node script would otherwise hold until the
     instance answers something nobody is going to read. */
  assert.ok(toldToStop, 'the transport was told the answer is no longer wanted');
});

test('a stopped scan sends no further request', async () => {
  const calls: RecordedCall[] = [];
  const controller = new AbortController();
  const client = new YouTrackApiClient(pagedTransport(3, calls), {
    gapMs: NO_GAP,
    signal: controller.signal,
  });

  await client.listGroups();
  controller.abort();

  await assert.rejects(() => client.listUsers(), { name: 'ScanCancelled' });
  assert.deepEqual(
    calls.map((c) => c.path),
    ['groups'],
    'nothing was sent after the scan was stopped',
  );
});

test('a stopped scan is stopped, not a batch of queries the instance refused', async () => {
  const controller = new AbortController();
  const client = new YouTrackApiClient(() => Promise.resolve({ count: 1 } as never), {
    gapMs: NO_GAP,
    signal: controller.signal,
  });
  controller.abort();

  /* Both ways in, because the report shows what came back either way: a count named
     as a failed query reaches the page as a check that hit an error, and a scan an
     administrator stopped then reads as an instance that refused to answer. */
  await assert.rejects(() => client.count('#Unresolved'), { name: 'ScanCancelled' });
  await assert.rejects(
    () => client.countMany(['project: {A}', 'project: {B}']),
    { name: 'ScanCancelled' },
  );
});

test('a stopped batch stops waiting for the turns it had claimed', async () => {
  const controller = new AbortController();
  /* The pacing is what makes this worth a test: every query claims a start time, so
     a batch of sixty is three seconds of waiting even against a transport that
     answers at once. A stop that only takes effect at the last claim would leave
     the page on "scanning" for minutes on an instance of a few thousand projects. */
  const client = new YouTrackApiClient(() => Promise.resolve({ count: 1 } as never), {
    signal: controller.signal,
  });
  const queries = Array.from({ length: 60 }, (_, i) => `project: {P${i}}`);
  const claimed = queries.length * 50;

  const startedAt = Date.now();
  const batch = assert.rejects(() => client.countMany(queries), { name: 'ScanCancelled' });
  controller.abort();
  await batch;

  const waited = Date.now() - startedAt;
  assert.ok(
    waited < claimed / 2,
    `the batch let go after ${waited} ms instead of sitting out ${claimed} ms of claims`,
  );
});

test('every request is reported, so a scan can show how far it has come', async () => {
  const calls: RecordedCall[] = [];
  const sent: number[] = [];
  const client = new YouTrackApiClient(pagedTransport(1201, calls), {
    gapMs: NO_GAP,
    onRequest: (count) => sent.push(count),
  });

  await client.listUsers();

  // Three pages of 500, counted in the order they were sent.
  assert.deepEqual(sent, [1, 2, 3]);
});

/**
 * The transport that runs in production - the app Host API - does not reject with
 * an Error. What arrives is a plain object, and a report that turns that into
 * "[object Object]" ends the investigation before it starts.
 */
test('a rejection that is not an Error still names the request and the reason', async () => {
  const rejecting: ApiTransport = <T>(): Promise<T> =>
    Promise.reject({
      status: 403,
      error: 'Forbidden',
      error_description: 'Requires permission Read Project',
    });
  const client = new YouTrackApiClient(rejecting, { gapMs: NO_GAP, backoffMs: 1 });

  await assert.rejects(() => client.listProjects(), (err: Error) => {
    assert.match(err.message, /admin\/projects/, 'the path is part of the message');
    assert.match(err.message, /403/);
    assert.match(err.message, /Requires permission Read Project/);
    assert.ok(!err.message.includes('[object Object]'));
    return true;
  });
});

test('a rejection with no field worth reading is passed on as it arrived', async () => {
  const rejecting: ApiTransport = <T>(): Promise<T> => Promise.reject({ weird: true });
  const client = new YouTrackApiClient(rejecting, { gapMs: NO_GAP });

  await assert.rejects(() => client.listGroups(), /\{"weird":true\}/);
});

test('a rate limit is recognised on an object rejection too', async () => {
  let attempts = 0;
  const rejecting: ApiTransport = <T>(): Promise<T> => {
    attempts++;
    return Promise.reject({ status: 429, error: 'Too Many Requests' });
  };
  const client = new YouTrackApiClient(rejecting, { gapMs: NO_GAP, backoffMs: 1 });

  await assert.rejects(() => client.listGroups(), /limits how many requests it accepts/);
  assert.equal(attempts, 4, 'one attempt plus three retries');
});

test('a rejected count says which query was rejected', async () => {
  // The endpoint is the same for every check, so its name identifies nothing; the
  // query is what a 400 is about.
  const rejecting: ApiTransport = <T>(): Promise<T> => Promise.reject({ status: 400 });
  const client = new YouTrackApiClient(rejecting, { gapMs: NO_GAP });

  await assert.rejects(
    () => client.count('project: {WEB} updated: 2026-01-01 .. *'),
    /query: project: \{WEB\} updated: 2026-01-01 \.\. \*/,
  );
});


test('an archived project is never used as a search scope', async () => {
  const calls: RecordedCall[] = [];
  const withArchived: ApiTransport = <T>(path: string, options: RequestOptions = {}) => {
    calls.push({ path, options });
    if (path === 'issuesGetter/count') {
      return Promise.resolve({ count: 7 } as T);
    }
    return Promise.resolve([
      { id: '0-0', shortName: 'WEB', name: 'Web', archived: false },
      { id: '0-1', shortName: 'OLD', name: 'Old', archived: true },
    ] as T);
  };
  const client = new YouTrackApiClient(withArchived, { gapMs: NO_GAP });

  const projects = await client.listProjects();

  /* Search rejects an archived project as a scope - 400, not an empty result - and
     one rejected query would take the whole list and every check built on it. */
  const counted = calls
    .filter(c => c.path === 'issuesGetter/count')
    .map(c => JSON.stringify(c.options.body));
  assert.equal(counted.length, 1, 'only the active project is counted');
  assert.match(counted[0] ?? '', /WEB/);
  assert.equal(projects.find(p => p.shortName === 'WEB')?.issuesCount, 7);
  // Null, not zero: an uncounted project has no total, and zero would be a claim.
  assert.equal(projects.find(p => p.shortName === 'OLD')?.issuesCount, null);
});

test('a count that is still being computed is asked for again, soon', async () => {
  /*
   * The endpoint answers -1 while it works. Waiting half a second before asking
   * again costs that half second on every asynchronous count, and a scan makes
   * hundreds of them; the first attempt has to follow quickly.
   */
  let attempts = 0;
  const computing: ApiTransport = <T>(): Promise<T> => {
    attempts++;
    return Promise.resolve({ count: attempts < 3 ? -1 : 42 } as T);
  };
  const client = new YouTrackApiClient(computing, { gapMs: NO_GAP });

  const started = Date.now();
  const count = await client.count('#Unresolved');
  const elapsed = Date.now() - started;

  assert.equal(count, 42);
  assert.equal(attempts, 3);
  // 100 ms, then 160: a fixed half-second pause would have taken a full second.
  assert.ok(elapsed < 500, `two waits took ${elapsed} ms`);
});

test('a count the instance never delivers gives up saying so', async () => {
  const never: ApiTransport = <T>(): Promise<T> => Promise.resolve({ count: -1 } as T);
  const client = new YouTrackApiClient(never, { gapMs: NO_GAP, countBudgetMs: 300 });

  await assert.rejects(
    () => client.count('#Unresolved'),
    /still computing this count/,
  );
});

test('a batch of counts comes back in the order it was asked', async () => {
  const answers = new Map([
    ['#Unresolved a', 1],
    ['#Unresolved b', 2],
    ['#Unresolved c', 3],
  ]);
  const answering: ApiTransport = <T>(_path: string, options: RequestOptions = {}) => {
    const query = (options.body as { query: string }).query;
    // Answers out of order, which is what concurrency does.
    return new Promise<T>(resolve =>
      setTimeout(
        () => resolve({ count: answers.get(query) } as T),
        query.endsWith('a') ? 30 : 1,
      ),
    );
  };
  const client = new YouTrackApiClient(answering, { gapMs: NO_GAP });

  const results = await client.countMany([...answers.keys()]);

  assert.deepEqual(results, [{ count: 1 }, { count: 2 }, { count: 3 }]);
});

test('one refused query in a batch does not lose the other answers', async () => {
  const refusing: ApiTransport = <T>(_path: string, options: RequestOptions = {}) => {
    const query = (options.body as { query: string }).query;
    return query.includes('broken')
      ? Promise.reject({ status: 400, error: 'invalid_query' })
      : Promise.resolve({ count: 7 } as T);
  };
  const client = new YouTrackApiClient(refusing, { gapMs: NO_GAP });

  const results = await client.countMany(['has: {Fine}', 'has: {broken}', 'has: {Also}']);

  // The empty-field check reports how many fields no query could reach, so a
  // refusal has to arrive as a result rather than as the end of the batch.
  assert.deepEqual(results[0], { count: 7 });
  assert.ok(results[1] && 'failed' in results[1]);
  assert.match((results[1] as { failed: string }).failed, /invalid_query/);
  assert.deepEqual(results[2], { count: 7 });
});

test('a scan reports every pause the instance asked for', async () => {
  const throttles: number[] = [];
  let sent = 0;
  const limited: ApiTransport = <T>(): Promise<T> => {
    sent++;
    // Two refusals, both waited out successfully.
    return sent === 3 || sent === 7
      ? Promise.reject({ status: 503, error: 'Service Unavailable' })
      : Promise.resolve({ count: 1 } as T);
  };
  const client = new YouTrackApiClient(limited, {
    gapMs: NO_GAP,
    backoffMs: 1,
    onThrottle: times => throttles.push(times),
  });

  await client.countMany(Array.from({ length: 8 }, (_, i) => `#Unresolved ${i}`));

  /* A limit that is waited out never reaches a check, so without this the report
     could not tell "the instance throttled us" from "the instance was busy". */
  assert.deepEqual(throttles, [1, 2]);
});

test('an answer that is not a list of entries is a stated reason, not an invented instance', async () => {
  /* The transport hands over whatever came back, and what comes back is not always
     the instance answering - a gateway in front of it can put a message where a
     collection belongs. A string is the dangerous one: spread into a list it
     becomes one entry per character, and the report would name projects that do
     not exist. */
  for (const answer of ['no access', { items: [] }, 42, null, [1, 2], ['PRJ']]) {
    const client = new YouTrackApiClient(
      () => Promise.resolve(answer as never),
      { gapMs: NO_GAP },
    );
    await assert.rejects(
      () => client.listGroups(),
      (err: Error) => {
        assert.match(err.message, /^groups answered/, err.message);
        return true;
      },
      `an answer of ${JSON.stringify(answer)} is refused`,
    );
  }
});

test('a count that is not a whole number is not taken for one', async () => {
  /* Passed on, it would end up in a headline as the number of open issues, and a
     count of "42" divides into a share that is not a number at all. */
  for (const answer of [{ count: '42' }, { count: 1.5 }, { count: true }, { count: -2 }, {}, null]) {
    const client = new YouTrackApiClient(
      () => Promise.resolve(answer as never),
      { gapMs: NO_GAP, countBudgetMs: 50 },
    );
    await assert.rejects(
      () => client.count('project: {PRJ}'),
      (err: Error) => {
        assert.match(err.message, /is not a count/, err.message);
        return true;
      },
      `a count of ${JSON.stringify(answer)} is refused`,
    );
  }
});

test('a trace without a time is an error, not an account that never worked', async () => {
  const client = new YouTrackApiClient(
    () => Promise.resolve([{}] as never),
    { gapMs: NO_GAP },
  );

  /* Read as "never", a trace whose time cannot be read would put an account that
     works every day on the list of the dormant ones - and that list is what a
     licence is taken away on. */
  await assert.rejects(() => client.lastActivity('u-1'), /without a time/);
  const silent = new YouTrackApiClient(() => Promise.resolve([] as never), { gapMs: NO_GAP });
  assert.equal(await silent.lastActivity('u-1'), null, 'no trace at all is still null');
});

test('an entry without an id is not an entry the scan can use', async () => {
  /* Every collection is asked for the id, and everything downstream is keyed by
     it: the count of a project, the object a finding names, what a mark is stored
     under. Carried on, a missing one becomes the string "undefined" in a report. */
  const client = new YouTrackApiClient(
    () => Promise.resolve([{ name: 'Group without an id' }] as never),
    { gapMs: NO_GAP },
  );

  await assert.rejects(() => client.listGroups(), /answered an entry without an id/);
});

test('a hole in a list is not read as an entry', async () => {
  // `[,]` and `[null]` both arrive from JSON, and both used to be mapped as if
  // they were objects - which throws deep inside the mapping instead of here.
  for (const answer of [[undefined], [null], [{ id: 'g' }, undefined]]) {
    const client = new YouTrackApiClient(
      () => Promise.resolve(answer as never),
      { gapMs: NO_GAP },
    );
    await assert.rejects(() => client.listGroups(), /instead of an entry/);
  }
});
