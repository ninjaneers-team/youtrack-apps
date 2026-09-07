/**
 * In-memory YouTrackClient for the check catalog and engine tests.
 *
 * `syntheticInstance(now)` builds one deliberately debt-laden instance in which
 * every check in the catalog has something to fire on - plus a few legitimate cases
 * (service account, WIP-limited board, archived project) so a check can also be
 * shown *not* firing.
 *
 * Two kinds of data:
 * - Structural lists (projects, fields, users, boards, groups) are returned
 *    verbatim. Checks that reason over lists - unused-global-field,
 *    duplicate-field-names, boards-without-wip-limits, projects-without-leader,
 *    empty-groups - are fully driven by these and need no query interpretation.
 * - Issue counts come from `count(query)`, resolved against an ordered rule
 *    table. The rules match on the *semantic tokens* the catalog's QUERIES carry
 *    (`#Unassigned`, `has: {<field>}`, `updated:`, project short names) rather than
 *    on exact strings, so a harmless tweak to a query does not break the fixtures.
 *    The tokens track catalog.ts, whose queries are probe-verified; an unmatched
 *    query throws loudly rather than guessing a number.
 */

import type {
  AgileBoard,
  CountResult,
  CustomField,
  InstanceOperations,
  InstanceSettings,
  Project,
  StateBundle,
  User,
  UserGroup,
  ValueBundle,
  YouTrackClient,
} from '../src/types.ts';

export interface CountRule {
  /** Non-global regex (stateful /g would break repeated .test calls). */
  match: RegExp;
  count: number;
}

export interface MockData {
  projects: Project[];
  customFields: CustomField[];
  users: User[];
  boards: AgileBoard[];
  groups: UserGroup[];
  stateBundles?: StateBundle[];
  valueBundles?: ValueBundle[];
  /**
   * What the instance says about the server it runs on, or null for one that will
   * not say - which is how a hosted instance and a reader without the permission
   * to ask both look from a check's side.
   */
  operations?: InstanceOperations | null;
  settings?: InstanceSettings | null;
  countRules: CountRule[];
  /**
   * Last change per user id, in epoch millis, or null for an account that never
   * changed anything. A missing entry throws, the same way an unmatched count rule
   * does: a check that probes an account the fixture did not plan for is a bug in
   * the test, not a zero.
   */
  activity?: Record<string, number | null>;
}

export class MockYouTrackClient implements YouTrackClient {
  private readonly data: MockData;

  constructor(data: MockData) {
    this.data = data;
  }

  async count(query: string): Promise<number> {
    for (const rule of this.data.countRules) {
      if (rule.match.test(query)) return rule.count;
    }
    throw new Error(
      `MockYouTrackClient: no count rule matches query ${JSON.stringify(query)}`,
    );
  }

  async countMany(queries: readonly string[]): Promise<CountResult[]> {
    return Promise.all(
      queries.map(async query => {
        try {
          return { count: await this.count(query) };
        } catch (err) {
          return { failed: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  async lastActivity(userId: string): Promise<number | null> {
    const activity = this.data.activity ?? {};
    if (!(userId in activity)) {
      throw new Error(`MockYouTrackClient: no activity entry for user ${userId}`);
    }
    return activity[userId] ?? null;
  }

  async listProjects(): Promise<Project[]> {
    return [...this.data.projects];
  }

  async listCustomFields(): Promise<CustomField[]> {
    return [...this.data.customFields];
  }

  async listUsers(): Promise<User[]> {
    return [...this.data.users];
  }

  async listAgileBoards(): Promise<AgileBoard[]> {
    return [...this.data.boards];
  }

  async listGroups(): Promise<UserGroup[]> {
    return [...this.data.groups];
  }

  async listStateBundles(): Promise<StateBundle[]> {
    return [...(this.data.stateBundles ?? [])];
  }

  async listValueBundles(): Promise<ValueBundle[]> {
    return [...(this.data.valueBundles ?? [])];
  }

  async readOperations(): Promise<InstanceOperations | null> {
    return this.data.operations ?? null;
  }

  async readSettings(): Promise<InstanceSettings | null> {
    return this.data.settings ?? null;
  }
}

const DAY_MS = 86_400_000;

/**
 * The synthetic instance. `now` anchors every timestamp so tests stay calendar-
 * independent: set ctx.now to the same value and the age thresholds line up.
 */
export function syntheticInstance(now: Date): MockYouTrackClient {
  return new MockYouTrackClient(syntheticData(now));
}

export function syntheticData(now: Date): MockData {
  const daysAgo = (n: number): number => now.getTime() - n * DAY_MS;

  return {
    // --- Projects ----------------------------------------------------------
    // WEB/APP: active and well kept, enough issues for the empty-field check.
    // LEGACY:  not archived, no activity in 180 days -> dormant fires.
    // NOLEAD:  no leader -> projects-without-leader fires.
    // GHOST:   leader is banned -> projects-without-leader fires.
    // ARCHIVE: archived -> excluded from the dormant check.
    projects: [
      project('0-0', 'WEB', 'Web Platform', false, 120, activeLeader('u-lead')),
      project('0-1', 'APP', 'Mobile App', false, 80, activeLeader('u-lead')),
      project('0-2', 'LEGACY', 'Legacy Suite', false, 30, activeLeader('u-lead')),
      project('0-3', 'NOLEAD', 'Ownerless', false, 12, null),
      project('0-4', 'GHOST', 'Abandoned', false, 5, bannedLeader('u-gone')),
      // Archived, so the real client never counts it: search rejects it as a scope.
      project('0-5', 'ARCHIVE', 'Old Migration', true, null, activeLeader('u-lead')),
    ],

    // --- Custom fields -----------------------------------------------------
    // Sprint: defined globally, instantiated nowhere -> unused-global-field.
    // Priority / Priorität / Prio: same meaning, three names -> duplicate-field-names.
    // Severity: attached to WEB only, filled in almost none of its issues
    //   -> empty-field fires.
    // State: every project gets its own value bundle, which is how YouTrack works
    //   and why the resolved flag can be right in one project and missing in the
    //   next -> state-without-resolved fires on the two using 'flow-no-done'.
    customFields: [
      field('1-0', 'Sprint', 'version[1]', []),
      // Required in WEB, and 20 of its 120 issues have no value anyway
      // -> required-but-empty fires.
      field('1-1', 'Priority', 'enum[1]', [instance('WEB', null, true)]),
      field('1-2', 'Priorität', 'enum[1]', [instance('APP')]),
      field('1-3', 'Prio', 'enum[1]', [instance('LEGACY')]),
      field('1-4', 'Severity', 'enum[1]', [instance('WEB')]),
      field('1-5', 'State', 'state[1]', [
        instance('WEB', 'flow-done'),
        // Required in APP and filled everywhere: a required field belongs in the
        // denominator too, or the share describes the fields with gaps rather than
        // the fields that carry a rule.
        instance('APP', 'flow-done', true),
        instance('LEGACY', 'flow-no-done'),
        instance('NOLEAD', 'flow-no-done'),
        instance('GHOST', 'flow-done'),
      ]),
    ],

    // --- State bundles -----------------------------------------------------
    stateBundles: [
      {
        id: 'flow-done',
        name: 'Standard flow',
        values: [
          { name: 'Open', resolved: false },
          { name: 'In Progress', resolved: false },
          { name: 'Done', resolved: true },
        ],
      },
      {
        id: 'flow-no-done',
        // Nothing in here counts as resolved, so #Unresolved matches every issue
        // in the projects that use it.
        name: 'Team flow',
        values: [
          { name: 'Open', resolved: false },
          { name: 'In Progress', resolved: false },
          { name: 'Delivered', resolved: false },
        ],
      },
    ],

    // --- Value lists -------------------------------------------------------
    // WEB and APP hold their own copy of the same three values, which is what
    // YouTrack does to a new project unless somebody picks an existing list
    // -> cloned-value-lists fires. 'Unfinished' holds nothing and stays out: an
    // empty list is a different matter, and comparing empty to empty would group
    // every one of them. The two wordy ones are a group whose values are far too
    // long to be an identifier, which is what the bound on those is for.
    valueBundles: [
      { id: '5-0', name: 'WEB: Types', values: ['Bug', 'Feature', 'Task'] },
      { id: '5-1', name: 'APP: Types', values: ['Task', 'Bug', 'Feature'] },
      { id: '5-2', name: 'Severities', values: ['Blocker', 'Minor'] },
      { id: '5-4', name: 'Wordy', values: Array.from({ length: 40 }, (_, i) => `value number ${i}`) },
      { id: '5-5', name: 'Wordy copy', values: Array.from({ length: 40 }, (_, i) => `value number ${i}`) },
      { id: '5-3', name: 'Unfinished', values: [] },
    ],

    // --- The server behind the instance ------------------------------------
    // Answers with a path of its own, so the instance is run by whoever reads the
    // report: the setup checks apply. Its database outgrew its memory, its email
    // is switched off, nobody is named for messages about the instance, and the
    // address in its links is the one the server sees itself under.
    operations: {
      selfHosted: true,
      databaseBytes: 8 * 1024 * 1024 * 1024,
      databaseText: '8.0 GB',
      memoryBytes: 4 * 1024 * 1024 * 1024,
      memoryText: '4.0 GB',
    },
    settings: {
      baseUrl: 'http://localhost:8080',
      administratorEmail: null,
      mailEnabled: false,
    },

    // --- Users -------------------------------------------------------------
    // The date is the registration date; idleness comes from the activity map
    // below, because no API exposes a last login.
    // j.doe, m.novak: idle past 90 days -> inactive-users.
    // svc-jenkins: idle but a service account -> the legitimateWhen case.
    // u-lead: active. u-gone: banned (not a licensed seat).
    // u-fresh: registered days ago, so its lack of history proves nothing. It has
    // no activity entry on purpose - if the check probed it, the mock would throw.
    users: [
      user('2-0', 'u-lead', 'Team Lead', false, daysAgo(400)),
      user('2-1', 'j.doe', 'Jane Doe', false, daysAgo(500)),
      user('2-2', 'm.novak', 'Marek Novak', false, daysAgo(600)),
      user('2-3', 'svc-jenkins', 'CI Service', false, daysAgo(700)),
      user('2-4', 'u-gone', 'Former Admin', true, daysAgo(800)),
      user('2-5', 'u-fresh', 'New Hire', false, daysAgo(5)),
    ],

    // --- Agile boards ------------------------------------------------------
    // Team WEB: no column carries a WIP limit -> boards-without-wip-limits, and it
    //   is the first board with a middle column, so aging-wip measures this one.
    // Kanban APP: one column has a max -> legitimate, does not fire.
    // Release LEGACY: nine columns -> overgrown-boards.
    boards: [
      board('3-0', 'Team WEB', ['WEB'], [
        column('Open'),
        column('In Progress'),
        column('Done', { resolved: true }),
      ]),
      board('3-1', 'Kanban APP', ['APP'], [
        column('Backlog'),
        column('In Progress', { wipLimitMax: 3 }),
        column('Done', { resolved: true }),
      ]),
      /* Plans in sprints, so a column limit is not its instrument: out of
         boards-without-wip-limits, still in the column-count and archive checks.
         Also still carries the archived project -> boards-on-archived-projects. */
      /* Its owner lost access, and nobody took the board over
         -> boards-owned-by-blocked-accounts fires on one board of three. */
      board('3-2', 'Release LEGACY', ['LEGACY', 'ARCHIVE'], [
        column('Idea'),
        column('Specified'),
        column('Ready'),
        column('Implementing'),
        column('Code Review'),
        column('QA'),
        column('Staging'),
        column('Release Notes'),
        column('Released', { resolved: true }),
      ], true, { login: 'u-gone', banned: true }),
    ],

    // --- Groups ------------------------------------------------------------
    // Auditors: no members -> empty-groups. Developers: populated.
    groups: [
      group('4-0', 'Developers', 8),
      group('4-1', 'Auditors', 0),
      group('4-2', 'Reserved PMO', 0),
    ],

    // --- Activity ----------------------------------------------------------
    // m.novak never changed anything at all, which reads differently from j.doe,
    // who stopped a year ago; the finding states both.
    activity: {
      '2-0': daysAgo(10),
      '2-1': daysAgo(400),
      '2-2': null,
      '2-3': daysAgo(200),
    },

    // --- Issue counts ------------------------------------------------------
    // Order matters: the most specific token wins. See the file header on why
    // these match tokens rather than exact query strings.
    countRules: [
      /* Three boards that carry work, and one of them is fine: Team WEB and Kanban
         APP each hold eight stale cards of twenty, Release LEGACY holds five and
         none of them stopped. So the share is two boards of three - a board that
         carries work without a problem belongs in the denominator, or the number
         would describe the boards with findings rather than the boards there are. */
      {
        match: /Board Release LEGACY.*updated:/i,
        count: 0,
        // serves: process.aging-wip (the board that carries work and is fine)
      },
      {
        match: /Board Release LEGACY/i,
        count: 5,
        // serves: process.aging-wip (its cards, none of them stale)
      },
      {
        match: /Board (Team WEB|Kanban APP).*updated:/i,
        count: 8,
        // serves: process.aging-wip (one board's stale cards)
      },
      {
        match: /Board (Team WEB|Kanban APP)/i,
        count: 20,
        // serves: process.aging-wip and boards-without-wip-limits (one board's cards)
      },
      {
        // unassigned & unresolved: 60 of 200 = 0.30 > 0.20 threshold.
        match: /Unassigned/i,
        count: 60,
        // serves: process.unassigned-unresolved (numerator)
      },
      {
        /* A field its project demands a value for, filled in 100 of the 120 issues
           of that project: 20 issues contradict a rule the project itself made. */
        match: /project:.*and has:\s*\{\s*Priority\s*\}/i,
        count: 100,
        // serves: fields.required-but-empty (the field with gaps)
      },
      {
        // The other required field is filled in every issue of its project.
        match: /project:.*and has:\s*\{\s*State\s*\}/i,
        count: 80,
        // serves: fields.required-but-empty (the required field without gaps)
      },
      {
        // 90 issues arrived in the window and 60 left it, so a third of the
        // arrivals stayed.
        match: /^created:/i,
        count: 90,
        // serves: process.intake-vs-throughput (what arrived)
      },
      {
        match: /^resolved date:/i,
        count: 60,
        // serves: process.intake-vs-throughput (what was finished)
      },
      {
        // The blocked account still holds open work. Ahead of the plain
        // Unresolved rule, which would otherwise answer with the instance total.
        match: /Assignee:\s*\{\s*u-gone\s*\}/i,
        count: 12,
        // serves: governance.open-work-of-blocked-accounts
      },
      {
        // Severity is attached to WEB alone, which holds 120 issues, and carries a
        // value in 4 of them: 96.7 % empty, over the 95 % threshold -> fires.
        match: /has:\s*\{\s*Severity\s*\}/i,
        count: 4,
        // serves: fields.empty-field (the field left empty)
      },
      {
        // Every other field is filled almost everywhere and stays under the
        // threshold. The number is above any project total in this instance, and
        // the check clamps to the total, so the empty share is 0.
        match: /has:\s*\{/i,
        count: 100_000,
        // serves: fields.empty-field (the fields in use)
      },
      {
        // unresolved & not updated for 180 days. Needs both tokens so a dormant
        // probe (which also carries `updated:` but no `Unresolved`) misses it.
        match: /(?=.*Unresolved)(?=.*updated:)/i,
        count: 40,
        // serves: process.stale-unresolved (stale issues)
      },
      {
        // dormant check probes activity per non-archived project; only LEGACY is 0.
        match: /(project|in):\s*\{?LEGACY\b/i,
        count: 0,
        // serves: portfolio.dormant-projects (LEGACY has no activity)
      },
      {
        match: /(project|in):\s*\{?(WEB|APP|NOLEAD|GHOST)\b/i,
        count: 25,
        // serves: portfolio.dormant-projects (other projects are active)
      },
      {
        // total unresolved (denominator for the ratio-based process checks).
        match: /Unresolved/i,
        count: 200,
        // serves: unresolved denominator
      },
    ],
  };
}

// --- tiny builders, kept local so the instance above reads as data -----------

function project(
  id: string,
  shortName: string,
  name: string,
  archived: boolean,
  issuesCount: number | null,
  leader: Project['leader'],
): Project {
  return { id, shortName, name, archived, issuesCount, leader };
}

function activeLeader(login: string): Project['leader'] {
  return { id: `l-${login}`, login, banned: false };
}

function bannedLeader(login: string): Project['leader'] {
  return { id: `l-${login}`, login, banned: true };
}

function field(
  id: string,
  name: string,
  fieldType: string,
  instances: CustomField['instances'],
): CustomField {
  return { id, name, fieldType, instances };
}

function instance(
  projectShortName: string,
  bundleId: string | null = null,
  required = false,
): CustomField['instances'][number] {
  return { id: `i-${projectShortName}`, projectShortName, bundleId, required };
}

function user(
  id: string,
  login: string,
  fullName: string,
  banned: boolean,
  registered: number,
): User {
  return { id, login, fullName, banned, registered };
}

function board(
  id: string,
  name: string,
  projects: string[],
  columns: AgileBoard['columns'],
  usesSprints = false,
  owner: AgileBoard['owner'] = { login: 'u-lead', banned: false },
): AgileBoard {
  // Every board in a real instance builds its columns from a field; State is the
  // default one YouTrack sets up.
  return {
    id,
    name,
    columnField: 'State',
    owner,
    projects,
    sprints: ['First sprint'],
    columns,
    usesSprints,
  };
}

/**
 * A column presents one field value, which is the common case on a real board.
 *
 * `ordinal` is where it sits left to right and defaults to its place in the list.
 * It is stated explicitly where a fixture lists the columns in another order than
 * the board shows them - which is what a real instance answers, and what a check
 * that reads position out of the list order gets wrong.
 */
function column(
  presentation: string,
  options?: {
    wipLimitMin?: number;
    wipLimitMax?: number;
    resolved?: boolean;
  },
): AgileBoard['columns'][number] {
  return {
    presentation,
    resolved: options?.resolved ?? false,
    wipLimitMin: options?.wipLimitMin ?? null,
    wipLimitMax: options?.wipLimitMax ?? null,
    fieldValues: [presentation],
  };
}

function group(id: string, name: string, usersCount: number): UserGroup {
  return { id, name, usersCount };
}

/**
 * A client that records the queries it was asked, and answers like the one it wraps.
 *
 * Five tests needed this and each spelled out every method of the interface, which
 * meant every new method broke five tests before it broke a check.
 */
export function recordingClient(inner: YouTrackClient): {
  client: YouTrackClient;
  queries: string[];
  calls: string[];
} {
  const queries: string[] = [];
  const calls: string[] = [];
  const note = <T>(name: string, value: Promise<T>): Promise<T> => {
    calls.push(name);
    return value;
  };
  return {
    queries,
    calls,
    client: {
      count: async query => {
        queries.push(query);
        return inner.count(query);
      },
      countMany: async batch => {
        queries.push(...batch);
        return inner.countMany(batch);
      },
      lastActivity: id => note('lastActivity', inner.lastActivity(id)),
      listProjects: () => note('listProjects', inner.listProjects()),
      listCustomFields: () => note('listCustomFields', inner.listCustomFields()),
      listUsers: () => note('listUsers', inner.listUsers()),
      listAgileBoards: () => note('listAgileBoards', inner.listAgileBoards()),
      listGroups: () => note('listGroups', inner.listGroups()),
      listStateBundles: () => note('listStateBundles', inner.listStateBundles()),
      listValueBundles: () => note('listValueBundles', inner.listValueBundles()),
      readOperations: () => note('readOperations', inner.readOperations()),
      readSettings: () => note('readSettings', inner.readSettings()),
    },
  };
}
