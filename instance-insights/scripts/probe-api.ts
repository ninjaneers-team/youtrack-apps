/**
 * Fires every API assumption this app makes against a real instance.
 *
 * Run against a local YouTrack instance (see the README):
 *
 *   node --env-file=.env scripts/probe-api.ts
 *
 * It only reads. Two layers:
 *   1. Resource endpoints and their `fields=` selectors (client.ts).
 *   2. The search-query fragments the checks send to count() - the exact QUERIES
 *      from catalog.ts, so a green probe confirms the strings the checks use, not
 *      a paraphrase.
 *
 * A diagnostic script, not a test - it needs an instance and is not part of
 * `npm run check`.
 */

import { createRestClient } from '../src/client.ts';
import { QUERIES } from '../src/checks/catalog.ts';

type ProbeResult = { name: string; ok: boolean; detail: string };

async function probe(
  name: string,
  fn: () => Promise<string>,
): Promise<ProbeResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const ISO_OLD = '2020-01-01';

async function main(): Promise<void> {
  const client = createRestClient();
  const results: ProbeResult[] = [];

  // Sample data used to build realistic search queries below.
  const projects = await client.listProjects().catch(() => []);
  const fields = await client.listCustomFields().catch(() => []);
  const users = await client.listUsers().catch(() => []);
  const sampleProject = projects.find((p) => !p.archived) ?? projects[0];
  const sampleField = fields.find((f) =>
    f.instances.some((i) => i.projectShortName === sampleProject?.shortName),
  );
  const sampleUser = users[0];

  // --- Layer 1: endpoints + field selectors --------------------------------

  results.push(
    await probe('projects (+ issuesCount via count)', async () =>
      `${projects.length} projects, issuesCount e.g. ${projects[0]?.issuesCount ?? 'n/a'}`,
    ),
  );
  results.push(
    await probe('custom fields + instances', async () => {
      const withInstances = fields.filter((f) => f.instances.length > 0).length;
      return `${fields.length} fields, ${withInstances} with instance data`;
    }),
  );
  results.push(
    await probe('users', async () => `${users.length} users`),
  );
  results.push(
    await probe('users carry a registration date', async () => {
      const dated = users.filter((u) => u.registered > 0).length;
      if (dated === 0) {
        throw new Error('no user carries `registered` - new accounts look idle');
      }
      return `${dated}/${users.length} with a date`;
    }),
  );
  const boards = await client.listAgileBoards().catch(() => []);
  results.push(
    await probe('agile boards + WIP limits', async () => {
      const withWip = boards.filter((b) =>
        b.columns.some((c) => c.wipLimitMin != null || c.wipLimitMax != null),
      ).length;
      return `${boards.length} boards, ${withWip} with WIP limit data`;
    }),
  );
  results.push(
    await probe('board column field, values and projects', async () => {
      const usable = boards.filter(
        (b) => b.columnField !== '' && b.projects.length > 0,
      );
      if (usable.length === 0) {
        throw new Error('no board exposes its column field and projects');
      }
      const sample = usable[0];
      return `${usable.length} usable, e.g. ${sample?.name}: ${sample?.columnField} over ` +
        `${sample?.projects.join(', ')}`;
    }),
  );
  results.push(
    await probe('groups + usersCount', async () => {
      const groups = await client.listGroups();
      return `${groups.length} groups, usersCount e.g. ${groups[0]?.usersCount ?? 'n/a'}`;
    }),
  );

  // --- Layer 2: the search queries the checks actually send ----------------
  // A bad query makes YouTrack answer 4xx, so a returned count confirms the syntax.

  results.push(
    await probe('query #Unresolved (high risk: count endpoint)', async () =>
      `=> ${await client.count(QUERIES.unresolved())}`,
    ),
  );
  results.push(
    await probe('query #Unassigned', async () =>
      `=> ${await client.count(QUERIES.unassignedUnresolved())}`,
    ),
  );
  results.push(
    await probe('query updated-range (stale)', async () =>
      `=> ${await client.count(QUERIES.staleUnresolved(ISO_OLD))}`,
    ),
  );
  results.push(
    sampleField
      ? // No project scope: a field only holds values where it is attached, so the
        // query stays the same length on an instance of any size.
        await probe(`query has: {${sampleField.name}} (field filled)`, async () =>
          `=> ${await client.count(QUERIES.fieldFilled(sampleField.name))}`,
        )
      : { name: 'query has: {field} (field filled)', ok: false, detail: 'no sample field' },
  );
  results.push(
    sampleProject
      ? /* The one query that is sorted rather than counted. A 4xx would mean the
           search language does not take this order, and the dormant check would be
           reading the first row of a list nobody sorted. */
        await probe('query project newest first (dormant)', async () => {
          const [result] = await client.newestUpdates([
            QUERIES.projectNewestFirst(sampleProject.shortName),
          ]);
          if (result === undefined || 'failed' in result) {
            throw new Error(result === undefined ? 'no answer' : result.failed);
          }
          return `=> ${result.updated === null ? 'no issues' : new Date(result.updated).toISOString()}`;
        })
      : { name: 'query project newest first (dormant)', ok: false, detail: 'no sample project' },
  );
  results.push(
    sampleUser
      ? // The activity endpoint is the licence check's evidence. It fails loudly:
        // no categories is a 400, an unknown author a 404, so a null answer here
        // really means the account never changed anything.
        await probe('activity of a user (inactive-users)', async () => {
          const last = await client.lastActivity(sampleUser.id);
          return `=> ${last === null ? 'no activity at all' : new Date(last).toISOString()}`;
        })
      : { name: 'activity of a user', ok: false, detail: 'no sample user' },
  );

  /* Aging WIP asks for a board's own column values in one query: braces around
     both names, an explicit `and` before the group, `or` between the values. Every
     one of those is a rejected query when it is left out. */
  const sampleBoard = boards.find(
    (b) => b.columnField !== '' && b.projects.length > 0 && b.columns.length > 2,
  );
  const sampleValues = (sampleBoard?.columns ?? [])
    .slice(1, -1)
    .flatMap((c) => c.fieldValues);
  results.push(
    sampleBoard
      ? await probe('query the cards a board holds', async () =>
          `=> ${await client.count(
            QUERIES.cardsOnBoard(
              sampleBoard.name,
              sampleBoard.usesSprints,
              sampleBoard.sprints,
              sampleBoard.projects,
            ),
          )}`,
        )
      : { name: 'query the cards a board holds', ok: false, detail: 'no board' },
  );

  // State bundles carry the resolved flag per value; the check needs nothing else.
  results.push(
    await probe('state bundles with resolved flags', async () => {
      const bundles = await client.listStateBundles();
      const withResolved = bundles.filter((b) => b.values.some((v) => v.resolved));
      return `${bundles.length} bundles, ${withResolved.length} with a resolved value`;
    }),
  );

  // The bundle a project uses comes with the field instances, so the check costs
  // no request of its own.
  results.push(
    await probe('field instances name their bundle', async () => {
      const fields = await client.listCustomFields();
      const withBundle = fields.flatMap((f) =>
        f.instances.filter((i) => i.bundleId !== null),
      );
      return `${withBundle.length} of ${fields.flatMap((f) => f.instances).length} instances carry a bundle id`;
    }),
  );

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks confirmed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
