/**
 * What a scan costs an instance.
 *
 * The report runs in a browser tab with the viewing user's permissions, so every
 * request it makes is a request that instance has to serve. That cost has to be
 * known before an app is installed anywhere real, and it scales with the instance,
 * not with the app: one activity lookup per licensed account, two issue counts per
 * project, three per board and one per custom field. A board costs the same whatever
 * its number of columns, because its cards are counted for the board at once.
 *
 * Part one counts requests against an in-memory instance of a given size - exact,
 * repeatable, and it touches nothing. Part two measures what one request actually
 * costs against the instance in .env, read-only, so the count can be turned into a
 * duration.
 *
 *   node scripts/load-profile.ts                 # counts only
 *   node scripts/load-profile.ts --measure 200   # plus 200 real requests
 */

import { runScan } from '../src/engine.ts';
import { CHECKS } from '../src/checks/catalog.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import type {
  AgileBoard,
  CountResult,
  CustomField,
  Project,
  StateBundle,
  User,
  UserGroup,
  YouTrackClient,
} from '../src/types.ts';
import { createRestClient } from '../src/client.ts';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;

/** Mirrors the gap the client keeps between two requests. */
const REQUEST_GAP_MS = 50;

export interface Shape {
  users: number;
  projects: number;
  boards: number;
  columnsPerBoard: number;
  fields: number;
}

/** Counts every call the engine makes, and answers plausibly. */
export class CountingClient implements YouTrackClient {
  readonly calls: Record<string, number> = {
    count: 0,
    lastActivity: 0,
    listProjects: 0,
    listCustomFields: 0,
    listUsers: 0,
    listAgileBoards: 0,
    listGroups: 0,
    listStateBundles: 0,
  };

  private readonly shape: Shape;
  private readonly now: Date;
  private projectsCounted = false;

  constructor(shape: Shape, now: Date) {
    this.shape = shape;
    this.now = now;
  }

  private bump(name: keyof CountingClient['calls']): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  async count(): Promise<number> {
    this.bump('count');
    // A number that keeps every check running rather than short-circuiting.
    return 200;
  }

  async countMany(queries: readonly string[]): Promise<CountResult[]> {
    return Promise.all(queries.map(async query => ({ count: await this.count() })));
  }

  async lastActivity(): Promise<number | null> {
    this.bump('lastActivity');
    return null;
  }

  async listProjects(): Promise<Project[]> {
    this.bump('listProjects');
    /* The real client counts the issues of every project while building this list,
       because the project resource carries no total - and it builds the list once per
       scan, so the counts are paid once however many checks ask for it. */
    if (!this.projectsCounted) {
      this.projectsCounted = true;
      for (let i = 0; i < this.shape.projects; i++) this.bump('count');
    }
    return Array.from({ length: this.shape.projects }, (_, i) => ({
      id: `p-${i}`,
      shortName: `P${i}`,
      name: `Project ${i}`,
      archived: false,
      issuesCount: 500,
      leader: i % 10 === 0 ? null : { id: `l-${i}`, login: `lead${i}`, banned: false },
    }));
  }

  async listCustomFields(): Promise<CustomField[]> {
    this.bump('listCustomFields');
    return Array.from({ length: this.shape.fields }, (_, i) => ({
      id: `f-${i}`,
      name: i % 5 === 0 ? 'Priority' : `Field ${i}`,
      fieldType: 'enum[1]',
      instances: Array.from({ length: this.shape.projects }, (__, p) => ({
        id: `i-${i}-${p}`,
        projectShortName: `P${p}`,
        bundleId: `b-${p}`,
      })),
    }));
  }

  async listUsers(): Promise<User[]> {
    this.bump('listUsers');
    return Array.from({ length: this.shape.users }, (_, i) => ({
      id: `u-${i}`,
      login: `user${i}`,
      fullName: `User ${i}`,
      banned: false,
      registered: this.now.getTime() - 400 * DAY_MS,
    }));
  }

  async listAgileBoards(): Promise<AgileBoard[]> {
    this.bump('listAgileBoards');
    return Array.from({ length: this.shape.boards }, (_, i) => ({
      id: `b-${i}`,
      name: `Board ${i}`,
      // Flow boards, so the WIP-limit check has something to measure.
      usesSprints: false,
      columnField: 'State',
      projects: [`P${i % this.shape.projects}`],
      columns: Array.from({ length: this.shape.columnsPerBoard }, (__, c) => ({
        presentation: `Column ${c}`,
        fieldValues: [`Value ${c}`],
      })),
    }));
  }

  async listStateBundles(): Promise<StateBundle[]> {
    this.bump('listStateBundles');
    // One bundle per project, the way YouTrack sets them up, all of them sound.
    return Array.from({ length: this.shape.projects }, (_, p) => ({
      id: `b-${p}`,
      name: `Flow ${p}`,
      values: [
        { name: 'Open', resolved: false },
        { name: 'Done', resolved: true },
      ],
    }));
  }

  async listGroups(): Promise<UserGroup[]> {
    this.bump('listGroups');
    return Array.from({ length: 20 }, (_, i) => ({
      id: `g-${i}`,
      name: `Group ${i}`,
      usersCount: i % 4 === 0 ? 0 : 5,
    }));
  }
}

async function profile(shape: Shape): Promise<void> {
  const now = new Date('2026-09-01T00:00:00.000Z');
  const client = new CountingClient(shape, now);
  const started = Date.now();
  await runScan(CHECKS, { client, config: DEFAULT_CONFIG, now });
  const total = Object.values(client.calls).reduce((a, b) => a + b, 0);

  console.log(
    `\n${shape.users} users - ${shape.projects} projects - ` +
      `${shape.boards} boards * ${shape.columnsPerBoard} columns - ${shape.fields} fields`,
  );
  for (const [name, calls] of Object.entries(client.calls)) {
    if (calls > 0) {
      console.log(`  ${name.padEnd(16)} ${String(calls).padStart(6)}`);
    }
  }
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(total).padStart(6)} requests`);
  console.log(`  engine overhead  ${String(Date.now() - started).padStart(6)} ms`);
  /* Requests are serialised with a gap, so the floor of a scan's duration follows
     from the count alone - before any latency is added. */
  console.log(
    `  paced floor      ${String(Math.round((total * REQUEST_GAP_MS) / 1000)).padStart(6)} s` +
      ` (${REQUEST_GAP_MS} ms between requests)`,
  );
}

/** What one request costs against a real instance. Read-only. */
async function measure(samples: number): Promise<void> {
  const base = process.env.YT_BASE_URL;
  const token = process.env.YT_TOKEN;
  if (!base || !token) {
    console.log('\nno YT_BASE_URL / YT_TOKEN - skipping the measurement');
    return;
  }
  const client = createRestClient({ baseUrl: base, token });
  const users = await client.listUsers();
  const user = users[0];
  if (!user) {
    console.log('\nthe instance has no users to measure against');
    return;
  }

  const durations: number[] = [];
  const started = Date.now();
  for (let i = 0; i < samples; i++) {
    const at = Date.now();
    await client.lastActivity(user.id);
    durations.push(Date.now() - at);
  }
  durations.sort((a, b) => a - b);
  const at = (share: number): number =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * share))] ?? 0;

  console.log(`\n${samples} activity requests against ${base}`);
  console.log(`  median      ${at(0.5)} ms`);
  console.log(`  p95         ${at(0.95)} ms`);
  console.log(`  slowest     ${at(1)} ms`);
  console.log(`  wall clock  ${Date.now() - started} ms`);
}

/** The same count, attributed to the check that caused it. */
async function perCheck(shape: Shape): Promise<void> {
  const now = new Date('2026-09-01T00:00:00.000Z');
  console.log(
    `\nper check at ${shape.users} users - ${shape.projects} projects - ` +
      `${shape.boards} boards - ${shape.fields} fields`,
  );
  const rows: Array<[string, number]> = [];
  for (const check of CHECKS) {
    const client = new CountingClient(shape, now);
    await runScan([check], { client, config: DEFAULT_CONFIG, now });
    rows.push([check.id, Object.values(client.calls).reduce((a, b) => a + b, 0)]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [id, total] of rows) {
    console.log(`  ${id.padEnd(38)} ${String(total).padStart(6)}`);
  }
  console.log(
    `  ${'sum'.padEnd(38)} ${String(rows.reduce((a, r) => a + r[1], 0)).padStart(6)}` +
      '  (above the scan total: each check pays for the shared project list alone)',
  );
}

/** The instance sizes the README states a request count for. */
export const SHAPES: Shape[] = [
  { users: 25, projects: 10, boards: 5, columnsPerBoard: 5, fields: 20 },
  { users: 100, projects: 50, boards: 20, columnsPerBoard: 6, fields: 40 },
  { users: 500, projects: 200, boards: 60, columnsPerBoard: 7, fields: 80 },
  { users: 2000, projects: 800, boards: 200, columnsPerBoard: 8, fields: 150 },
];

/**
 * Printing the report is what the script does; counting is what a test needs.
 *
 * Imported, this module only offers the counter and the sizes - or every test run
 * would print a load profile and scan four synthetic instances to do it.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const shape of SHAPES) {
    await profile(shape);
  }

  await perCheck({ users: 500, projects: 200, boards: 60, columnsPerBoard: 7, fields: 80 });
  await perCheck(SHAPES[SHAPES.length - 1]!);

  const flag = process.argv.indexOf('--measure');
  if (flag !== -1) {
    await measure(Number(process.argv[flag + 1] ?? 100));
  }
}
