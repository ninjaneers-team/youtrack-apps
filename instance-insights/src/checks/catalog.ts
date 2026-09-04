/**
 * The check catalog.
 *
 * Every check depends only on the YouTrackClient interface and the domain types.
 * No fetch, no URL, no REST path here - those live in youtrack-api.ts. The only
 * outward strings are YouTrack *search* queries: the domain language a check
 * speaks to count(). They are collected in QUERIES below and were confirmed
 * against a real instance with scripts/probe-api.ts (youtrack:2026.2.18194).
 *
 * Report-facing text (title, why, legitimateWhen, headline) follows one tone rule:
 * describe findings as grown over time, never as someone's fault. The person
 * reading the report is the administrator of the instance it describes.
 */

import type {
  AgileBoard,
  BoardColumn,
  CheckDefinition,
  CustomField,
  Evidence,
  Finding,
  FindingItem,
  Project,
  ScanContext,
  User,
} from '../types.ts';
import {
  agree,
  CheckSkipped,
  countedProjects,
  plural,
  ratioAboveThreshold,
  requireCounts,
  severityFromRatio,
  share,
} from '../types.ts';

const DAY_MS = 86_400_000;

/**
 * YouTrack search queries. Assembled from ctx.now as absolute ISO dates, never
 * relative syntax like `-90d`. Each one was confirmed against a real instance
 * with scripts/probe-api.ts.
 *
 * Every name that comes from the instance is braced - project short names as much
 * as field and value names. Names are free to contain characters the parser reads
 * as syntax, and a query it cannot parse is a 400 rather than an empty result.
 */
export const QUERIES = {
  unresolved: (): string => '#Unresolved',
  unassignedUnresolved: (): string => '#Unresolved #Unassigned',
  staleUnresolved: (cutoff: string): string => `#Unresolved updated: * .. ${cutoff}`,
  /**
   * Issues that carry a value for this field. A field can only hold a value in the
   * projects it is attached to, so this needs no project scope - which keeps the
   * query the same length whether the instance has two projects or two thousand.
   */
  fieldFilled: (field: string): string => `has: {${field}}`,
  projectActivitySince: (shortName: string, since: string): string =>
    `project: {${shortName}} updated: ${since} .. *`,
  /**
   * Issues a board holds in its columns between the first and the last - one query
   * for the whole board rather than one per column.
   *
   * Three details the parser insists on. Field and value names are braced because
   * either can contain spaces (`{Board Status}: {In Progress}`). A group in
   * parentheses needs an explicit `and` in front of it; without it the instance
   * rejects the query rather than interpreting it. And the values are joined with
   * `or`, not with commas: a comma list following a project clause is rejected too.
   */
  boardWip: (
    projects: readonly string[],
    field: string,
    values: readonly string[],
  ): string =>
    `project: ${projects.map((shortName) => `{${shortName}}`).join(', ')} and (` +
    `${values.map((value) => `{${field}}: {${value}}`).join(' or ')})`,
  boardWipStale: (
    projects: readonly string[],
    field: string,
    values: readonly string[],
    cutoff: string,
  ): string =>
    `${QUERIES.boardWip(projects, field, values)} and updated: * .. ${cutoff}`,
};

/** Absolute YYYY-MM-DD `days` before ctx.now. Derived from now, no clock read. */
function isoDate(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function pct(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/**
 * A board reduced to the projects a query may name, and what that cost.
 *
 * Search does not accept an archived project as a scope, and an archived project
 * takes no new work either way - so every board check asks only about the active
 * part of a board. `left` is what stayed out: a finding that names a board spanning
 * both has to say so, or the reader opens the board, sees archived projects, and
 * doubts the number rather than the board.
 */
interface BoardReach {
  board: AgileBoard;
  projects: string[];
  left: number;
}

function reachOf(
  boards: readonly AgileBoard[],
  active: ReadonlySet<string>,
): BoardReach[] {
  return boards.map((board) => {
    const projects = board.projects.filter((shortName) => active.has(shortName));
    return { board, projects, left: board.projects.length - projects.length };
  });
}

/** Names the part of a board that stayed out, and only when there is one. */
function reachNote(left: number): string {
  return left === 0 ? '' : `, ${plural(left, 'archived project')} left out`;
}

/**
 * Every object a finding is about, as report rows.
 *
 * All of them, not the first few: how many a report shows is the report's decision,
 * and a list cut here would make the count beside it describe the list instead of
 * the instance.
 */
function toItems<T>(source: readonly T[], map: (item: T) => FindingItem): FindingItem[] {
  return source.map(map);
}

/**
 * What a check reports. The rest of a finding is the same for all of them.
 *
 * A check measures; it does not decide which check it is, nor which band its
 * measurement falls in.
 */
type Measured = Omit<Finding, 'checkId' | 'severity' | 'evidence'> & {
  evidence?: Evidence[];
};

type CheckSpec = Omit<CheckDefinition, 'run'> & {
  run(ctx: ScanContext): Promise<Measured | null>;
};

/**
 * A check as the catalog writes it, with what every finding carries filled in.
 *
 * The id, because a finding that named a different check than the one that made it
 * would be marked as intentional in the wrong place and carry the wrong title -
 * and until now nothing but care kept the two copies of it equal. The severity
 * band, because it is a reading of the ratio and never a decision of a check's
 * own. And no evidence where a check has none to add, rather than an empty list
 * per check.
 */
function checkOf(spec: CheckSpec): CheckDefinition {
  return {
    ...spec,
    run: async (ctx: ScanContext): Promise<Finding | null> => {
      const measured = await spec.run(ctx);
      if (measured === null) {
        return null;
      }
      return {
        ...measured,
        checkId: spec.id,
        severity: severityFromRatio(measured.ratio),
        evidence: measured.evidence ?? [],
      };
    },
  };
}

// --- Licensing ---------------------------------------------------------------

const inactiveUsers: CheckDefinition = checkOf({
  id: 'licensing.inactive-users',
  category: 'licensing',
  title: 'Inactive licences',
  weight: 10,
  // True on any plan: a paid subscription bills the seat, a plan with a user limit
  // gives it to nobody else. Claiming a cost in money would be wrong on a free
  // instance, and one wrong sentence is enough to put the rest in doubt.
  why:
    'An account that leaves no trace of work for months still holds a seat: on a ' +
    'paid plan it is in the invoice, on a plan with a user limit it is a seat the ' +
    'next colleague cannot get. Accounts like this accumulate in instances that ' +
    'have grown over several years.',
  legitimateWhen:
    'Seasonal staff, people who purely read reports and boards, and integrations ' +
    'that only read through the API: reading leaves no trace anywhere in the API, ' +
    'and no sign-in time is available to check instead. Before a seat is withdrawn, ' +
    "the account's Account Security page shows when its password and each of its " +
    'tokens were last used - that is where an API-only account proves it is alive.',
  whatItInvolves:
    'The change itself takes minutes. The work is the agreement: for ' +
    'each account, who used it last, whether an integration depends on ' +
    'it, and who signs off on withdrawing the seat.',
  itemsNamePeople: true,
  run: async (ctx): Promise<Measured | null> => {
    const users = await ctx.client.listUsers();
    const licensed = users.filter((u) => !u.banned);
    if (licensed.length === 0) {
      throw new CheckSkipped('The instance has no licensed users.');
    }

    const inactive = await inactiveByActivity(ctx, licensed);
    if (inactive.length === 0) return null;

    const ratio = share(inactive.length, licensed.length);
    return {
      itemKind: 'account',
      // Says what was measured: a change, not a sign-in. No API exposes a sign-in
      // time, and a headline that implied one would be a false positive waiting to
      // happen.
      headline: `${inactive.length} of ${plural(licensed.length, 'licensed user')} changed nothing in ${ctx.config.inactiveUserDays} days - no issue, comment, field, attachment, vote or logged work.`,
      ratio,
      // The date of the last trace travels with each account: it is the difference
      // between "gone for years" and "quiet since the summer", and that difference
      // decides what happens to the licence.
      items: toItems(inactive, (entry) => ({
        id: entry.user.id,
        label: entry.user.login,
        detail:
          entry.last === null
            ? 'no trace at all'
            : `last change ${new Date(entry.last).toISOString().slice(0, DATE_LENGTH)}`,
      })),
    };
  },
});

/** Length of an ISO date, without the time part. */
const DATE_LENGTH = 10;

/** An account with no recent change, and the last one it did make. */
interface IdleAccount {
  user: User;
  last: number | null;
}

/**
 * Idle accounts, from the activity of every licensed account.
 *
 * There is no last-login time to read: YouTrack REST does not carry one and Hub,
 * which does, is out of reach for the widget. What the API does carry is every
 * change a person made, with a timestamp - creating an issue, commenting, editing a
 * field, attaching a file, tagging, voting, logging work. Reading is invisible, so
 * that limit stays and is named in the finding.
 *
 * Ownership of saved searches or dashboards is deliberately not counted as activity.
 * It never expires, so an account that once built a dashboard would look in use
 * forever, which would hide exactly the licences this check is meant to surface.
 *
 * Accounts younger than the window are left out. They have no activity inside it
 * because they did not exist, which says nothing about the licence.
 */
async function inactiveByActivity(
  ctx: ScanContext,
  licensed: readonly User[],
): Promise<IdleAccount[]> {
  const cutoff = ctx.now.getTime() - ctx.config.inactiveUserDays * DAY_MS;
  const inactive: IdleAccount[] = [];
  for (const user of licensed) {
    if (user.registered > cutoff) continue;
    const last = await ctx.client.lastActivity(user.id);
    if (last === null || last < cutoff) inactive.push({ user, last });
  }
  return inactive;
}

// --- Fields & configuration --------------------------------------------------

const unusedGlobalField: CheckDefinition = checkOf({
  id: 'fields.unused-global-field',
  category: 'fields',
  title: 'Fields used in no project',
  weight: 6,
  why:
    'Fields defined globally but used in no project still appear in pickers and ' +
    'configuration dialogs, which makes the setup harder to survey.',
  legitimateWhen: 'Kept deliberately as a template for upcoming projects.',
  whatItInvolves:
    'A field with no instances can be removed in one place, once ' +
    'someone confirms it is not a template for an upcoming project. No ' +
    'data moves.',
  run: async (ctx): Promise<Measured | null> => {
    const fields = await ctx.client.listCustomFields();
    if (fields.length === 0) throw new CheckSkipped('The instance has no custom fields.');

    const unused = fields.filter((f) => f.instances.length === 0);
    if (unused.length === 0) return null;

    const ratio = share(unused.length, fields.length);
    return {
      itemKind: 'field',
      headline: `${unused.length} of ${plural(fields.length, 'custom field')} ${agree(unused.length, 'is', 'are')} defined globally and used in no project.`,
      ratio,
      total: fields.length,
      items: toItems(unused, (f) => ({ id: f.id, label: f.name })),
    };
  },
});

const emptyField: CheckDefinition = checkOf({
  id: 'fields.empty-field',
  category: 'fields',
  title: 'Fields that stay empty',
  weight: 8,
  why:
    'A field that is almost always empty costs attention on every issue without ' +
    'carrying information. Such fields accumulate over time.',
  legitimateWhen: 'An optional escalation or exception field that rarely applies.',
  whatItInvolves:
    'Two decisions before any change: whether the field is meant to be ' +
    'filled, and if so who fills it and when. Removing it is one ' +
    'setting per project; making it used is a habit, and habits need ' +
    'the team that owns the project.',
  run: async (ctx): Promise<Measured | null> => {
    const projects = countedProjects(await ctx.client.listProjects());
    const issuesByProject = new Map(projects.map((p) => [p.shortName, p.issuesCount]));
    const fields = await ctx.client.listCustomFields();

    /* How many issues could carry each field: the issues of the projects it is
       attached to. Those totals are already known from the project list, so the
       reference costs no request - only the filled count does. */
    const candidates = fields
      .map((field) => ({
        field,
        projects: field.instances
          .map((i) => i.projectShortName)
          .filter((shortName) => issuesByProject.has(shortName)),
      }))
      .map(({ field, projects: shortNames }) => ({
        field,
        shortNames,
        issues: shortNames.reduce(
          (total, shortName) => total + (issuesByProject.get(shortName) ?? 0),
          0,
        ),
      }))
      .filter(({ issues }) => issues >= ctx.config.minIssuesForFieldCheck);

    if (candidates.length === 0) {
      throw new CheckSkipped(
        'No field is attached to projects with enough issues for a meaningful analysis.',
      );
    }

    /* A field name has to go into a search query, and YouTrack answers 400 for a
       name it cannot parse there - one that collides with a query keyword, or
       carries a brace. Such a field counts as unreachable rather than as filled or
       empty: it stays out of both sides of the ratio, and the number of them is
       part of the evidence, so the report never presents an unmeasured field as
       measured. */
    const empties: Array<{ id: string; name: string; share: number; projects: number }> = [];
    let measured = 0;
    let unreachable = 0;
    const filledCounts = await ctx.client.countMany(
      candidates.map(({ field }) => QUERIES.fieldFilled(field.name)),
    );
    for (const [index, { field, shortNames, issues }] of candidates.entries()) {
      const result = filledCounts[index];
      if (!result || 'failed' in result) {
        unreachable++;
        continue;
      }
      measured++;
      // Filled and total are two counts, so the share of them is bounded there.
      const empty = 1 - share(result.count, issues);
      if (empty > ctx.config.emptyFieldThreshold) {
        empties.push({
          // The field's own id, not its name: a name is what the reader reads, and
          // an id is what a mark is kept under after a rename.
          id: field.id,
          name: field.name,
          share: empty,
          projects: shortNames.length,
        });
      }
    }
    if (measured === 0) {
      throw new CheckSkipped(
        `No search query could reach any of the ${candidates.length} fields.`,
      );
    }
    if (empties.length === 0) return null;

    const ratio = share(empties.length, measured);
    return {
      itemKind: 'field',
      headline: `${empties.length} of ${plural(measured, 'field')} ${agree(empties.length, 'is', 'are')} empty in more than ${pct(ctx.config.emptyFieldThreshold)} of the issues that could carry them.`,
      ratio,
      total: measured,
      evidence: [
        // Only what the headline cannot hold - and only when there is any.
        ...(unreachable > 0
          ? [{ label: 'Fields no search could reach', value: unreachable }]
          : []),
      ],
      items: toItems(empties, ({ id, name, share: emptyShare, projects: count }) => ({
        id,
        label: name,
        detail: `${pct(emptyShare)} empty across ${plural(count, 'project')}`,
      })),
    };
  },
});

/**
 * Names that mean the same thing, as a map rather than an object literal.
 *
 * The key comes from a field name in the instance, and a plain object answers for
 * keys nobody put in it: a field named "constructor" would be looked up against
 * everything an object inherits, and the answer would not be a name.
 */
const SYNONYMS = new Map<string, string>([
  ['prio', 'priority'],
  ['prioritat', 'priority'], // "Priorität" after diacritic stripping
  ['prioritaet', 'priority'],
  ['schweregrad', 'severity'],
  ['bearbeiter', 'assignee'],
  ['zustandiger', 'assignee'],
]);

function normalizeFieldName(name: string): string {
  const stripped = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    /* Letters and digits of every script, not only the Latin ones: keeping just
       a-z leaves nothing at all of a name in Cyrillic or Japanese, and names that
       normalise to nothing all look alike - an instance that works in Russian
       would be told that every one of its fields repeats every other. */
    .replace(/[^\p{L}\p{N}]/gu, '');
  return SYNONYMS.get(stripped) ?? stripped;
}

const duplicateFieldNames: CheckDefinition = checkOf({
  id: 'fields.duplicate-field-names',
  category: 'fields',
  title: 'Inconsistent field names',
  weight: 10,
  why:
    'Fields with the same meaning under different names (Priority / Priorität / ' +
    'Prio, for example) prevent reporting across projects: an analysis spanning ' +
    'all projects cannot merge them.',
  legitimateWhen: 'Deliberately separate meanings in separate domains.',
  whatItInvolves:
    'This touches data in several projects at once. Values have to be ' +
    'mapped and migrated, and boards, reports and workflows that name ' +
    'the old fields have to follow in the same step - done out of ' +
    'order, running reports break.',
  run: async (ctx): Promise<Measured | null> => {
    const fields = await ctx.client.listCustomFields();
    if (fields.length === 0) throw new CheckSkipped('The instance has no custom fields.');

    const groups = new Map<string, CustomField[]>();
    for (const field of fields) {
      const key = normalizeFieldName(field.name);
      /* A name of nothing but punctuation - "---", "#" - has no form left to
         compare, and it is also what a group would be named by later: the id an
         administrator marks it under. Such a field is left out rather than filed
         under the empty name together with every other one of its kind. */
      if (key === '') continue;
      const bucket = groups.get(key);
      if (bucket) bucket.push(field);
      else groups.set(key, [field]);
    }

    // A group is a real duplicate only if it carries more than one distinct name.
    const duplicates = [...groups.values()].filter(
      (g) => new Set(g.map((f) => f.name.toLowerCase())).size > 1,
    );
    if (duplicates.length === 0) return null;

    const redundant = duplicates.reduce((sum, g) => sum + (g.length - 1), 0);
    const ratio = share(redundant, fields.length);
    return {
      itemKind: 'field-group',
      headline: `${redundant} of ${plural(fields.length, 'custom field')} ${agree(redundant, 'repeats', 'repeat')} the meaning of another field under a different name, in ${plural(duplicates.length, 'group')}.`,
      ratio,
      /* Fields, not groups: the share is what a group of names costs among all
         fields, so marking one group intentional subtracts its redundant fields.
         The population stays whole - those fields still exist and still count. */
      affected: redundant,
      total: fields.length,
      items: toItems(duplicates, (g) => ({
        id: normalizeFieldName(g[0]!.name),
        label: g.map((f) => f.name).join(' / '),
        /* What this group contributes to the count, so the column says what marking
           it would take out - the names themselves are already the label. */
        detail: `${g.length - 1} of ${plural(g.length, 'field')}`,
        affected: g.length - 1,
        measured: 0,
      })),
    };
  },
});

// --- Process hygiene ---------------------------------------------------------

const unassignedUnresolved: CheckDefinition = checkOf({
  id: 'process.unassigned-unresolved',
  category: 'process',
  title: 'Unassigned open issues',
  weight: 6,
  why:
    'A high share of open issues without an assignee suggests work is stalling ' +
    'because nobody feels responsible for it.',
  legitimateWhen:
    'A pull model, where the team picks work from a shared pool on its own.',
  whatItInvolves:
    'Nothing to configure. The question is who takes ownership of the ' +
    'open items, and whether the team wants a pull model in the first ' +
    'place - that is a conversation with the team, not a setting.',
  run: async (ctx): Promise<Measured | null> => {
    const total = await ctx.client.count(QUERIES.unresolved());
    if (total === 0) throw new CheckSkipped('The instance has no open issues.');

    const unassigned = await ctx.client.count(QUERIES.unassignedUnresolved());
    const unassignedShare = share(unassigned, total);
    if (unassignedShare <= ctx.config.unassignedThreshold) return null;

    const ratio = ratioAboveThreshold(unassignedShare, ctx.config.unassignedThreshold);
    return {
      // A number without a handle is nothing to work from: with the query, the
      // report leads into the list of issues it counted.
      query: QUERIES.unassignedUnresolved(),
      headline: `${unassigned} of ${plural(total, 'open issue')} ${agree(unassigned, 'has', 'have')} no assignee.`,
      ratio,
    };
  },
});

const staleUnresolved: CheckDefinition = checkOf({
  id: 'process.stale-unresolved',
  category: 'process',
  title: 'Stalled issues',
  weight: 8,
  why:
    'Open issues untouched for months distort every capacity and progress report ' +
    'and obscure the view of the work that is actually active.',
  legitimateWhen: 'A deliberate idea backlog that is not groomed continuously.',
  whatItInvolves:
    'Every issue needs a decision: close, hand over, or keep with a ' +
    'reason. That decision belongs to whoever owns the work, so this ' +
    'scales with the number of issues and with how many teams they are ' +
    'spread across.',
  run: async (ctx): Promise<Measured | null> => {
    const total = await ctx.client.count(QUERIES.unresolved());
    if (total === 0) throw new CheckSkipped('The instance has no open issues.');

    const cutoff = isoDate(ctx.now, ctx.config.staleIssueDays);
    const stale = await ctx.client.count(QUERIES.staleUnresolved(cutoff));
    if (stale === 0) return null;

    const ratio = share(stale, total);
    return {
      query: QUERIES.staleUnresolved(cutoff),
      headline: `${stale} of ${plural(total, 'open issue')} ${agree(stale, 'has', 'have')} not been updated for more than ${ctx.config.staleIssueDays} days.`,
      ratio,
    };
  },
});

/**
 * Columns that hold work in progress: everything between the first and the last.
 *
 * A board's own field values decide what "in progress" means here, without the
 * check guessing at state names. The first column is where work waits and the last
 * is where it ends, so neither is work in flight. Boards with three columns or
 * fewer than three leave nothing in between, which is why the checks skip them.
 */
function wipColumns(board: AgileBoard): BoardColumn[] {
  return board.columns.slice(1, -1).filter((c) => c.fieldValues.length > 0);
}

const boardsWithoutWipLimits: CheckDefinition = checkOf({
  id: 'process.boards-without-wip-limits',
  category: 'process',
  title: 'Boards with no limit on work in progress',
  weight: 5,
  why:
    'A column without a limit takes any amount of work, so a board that carries ' +
    'cards in flight without one cannot say when it is full. Usually that is not a ' +
    'decision but a setting nobody made.',
  legitimateWhen:
    'A team that limits work in another way - by agreement, or by the size of the ' +
    'team - and reads the board as a status view rather than as a pull system.',
  whatItInvolves:
    'One setting per column, and a number the team has to agree on. A ' +
    'limit imposed from outside gets worked around, so the setting is ' +
    'the smaller half.',
  run: async (ctx): Promise<Measured | null> => {
    /* Only boards that plan without sprints, and only those with work in flight.
       A sprint board limits work through its sprint, and an empty board has nothing
       to limit - judging either by this rule reports a setting they do not need. */
    const active = new Set(
      countedProjects(await ctx.client.listProjects()).map((p) => p.shortName),
    );
    const flowBoards = reachOf(
      (await ctx.client.listAgileBoards()).filter(
        (b) => !b.usesSprints && b.columnField !== '',
      ),
      active,
    ).filter((r) => r.projects.length > 0 && wipColumns(r.board).length > 0);
    if (flowBoards.length === 0) {
      throw new CheckSkipped(
        'No board plans without sprints, where a column limit is the instrument.',
      );
    }

    const cardCounts = requireCounts(
      await ctx.client.countMany(
        flowBoards.map((reach) =>
          QUERIES.boardWip(
            reach.projects,
            reach.board.columnField,
            wipColumns(reach.board).flatMap((c) => c.fieldValues),
          ),
        ),
      ),
    );

    const carrying: Array<{ reach: BoardReach; cards: number }> = [];
    const without: Array<{ reach: BoardReach; cards: number }> = [];
    for (const [index, reach] of flowBoards.entries()) {
      const cards = cardCounts[index] ?? 0;
      if (cards === 0) continue;
      carrying.push({ reach, cards });
      const limited = reach.board.columns.some(
        (c) => c.wipLimitMin != null || c.wipLimitMax != null,
      );
      if (!limited) without.push({ reach, cards });
    }

    if (carrying.length === 0) {
      throw new CheckSkipped('No board without sprints carries work in flight.');
    }
    if (without.length === 0) return null;

    const ratio = share(without.length, carrying.length);
    return {
      itemKind: 'board',
      headline: `${without.length} of ${plural(carrying.length, 'board')} ${agree(without.length, 'carries', 'carry')} work in flight with no limit on any column.`,
      ratio,
      total: carrying.length,
      evidence: [
        {
          label: 'Cards in flight without a limit',
          value: without.reduce((sum, b) => sum + b.cards, 0),
        },
      ],
      items: toItems(without, ({ reach, cards }) => ({
        id: reach.board.id,
        label: reach.board.name,
        detail: `${plural(cards, 'card')} in flight${reachNote(reach.left)}`,
      })),
    };
  },
});

const agingWip: CheckDefinition = checkOf({
  id: 'process.aging-wip',
  category: 'process',
  title: 'Work in progress that stopped moving',
  weight: 7,
  why:
    'An issue that has been in progress for weeks without an update is usually ' +
    'blocked rather than being worked on. It occupies a slot in the flow, and every ' +
    'forecast built on the board counts it as active work.',
  legitimateWhen:
    'Long-running maintenance tasks, or a column used as a holding area for work ' +
    'that waits on someone outside the team.',
  whatItInvolves:
    'Each card needs a decision by the person holding it: continue, ' +
    'hand over, or take it out of progress. Where a column is a waiting ' +
    'room for work that depends on someone else, the fix is the process ' +
    'around it, not the board.',
  run: async (ctx): Promise<Measured | null> => {
    /* A board may reach into archived projects, and search does not accept one as a
       scope, so they are dropped from its reach before it is asked about. Their
       cards are not work in flight either way. */
    const active = new Set(
      countedProjects(await ctx.client.listProjects()).map((p) => p.shortName),
    );
    const boards = reachOf(await ctx.client.listAgileBoards(), active).filter(
      (r) =>
        r.board.columnField !== '' &&
        r.projects.length > 0 &&
        wipColumns(r.board).length > 0,
    );
    if (boards.length === 0) {
      throw new CheckSkipped('No board has columns between its first and its last.');
    }

    const cutoff = isoDate(ctx.now, ctx.config.agingWipDays);
    let inProgress = 0;
    let aging = 0;
    let measured = 0;
    const stalled: Array<{ reach: BoardReach; stale: number; total: number }> = [];

    /* Every board, not the first one that qualifies: a share measured on one
       arbitrary board out of two hundred describes that board and would be read as
       the instance. Two counts per board, whatever its number of columns, and both
       batches go out as batches. */
    const valuesOf = boards.map((reach) =>
      wipColumns(reach.board).flatMap((c) => c.fieldValues),
    );
    const totals = requireCounts(
      await ctx.client.countMany(
        boards.map((reach, i) =>
          QUERIES.boardWip(reach.projects, reach.board.columnField, valuesOf[i] ?? []),
        ),
      ),
    );
    const carrying = boards
      .map((reach, index) => ({ reach, total: totals[index] ?? 0, values: valuesOf[index] ?? [] }))
      .filter(({ total }) => total > 0);
    const stales = requireCounts(
      await ctx.client.countMany(
        carrying.map(({ reach, values }) =>
          QUERIES.boardWipStale(
            reach.projects,
            reach.board.columnField,
            values,
            cutoff,
          ),
        ),
      ),
    );
    for (const [index, { reach, total }] of carrying.entries()) {
      const stale = stales[index] ?? 0;
      measured++;
      inProgress += total;
      aging += stale;
      if (stale > 0) stalled.push({ reach, stale, total });
    }

    if (inProgress === 0) {
      throw new CheckSkipped('No board carries work in progress right now.');
    }
    if (aging === 0) return null;

    const ratio = share(aging, inProgress);
    return {
      itemKind: 'board',
      /* "Cards", not "issues": work in flight is counted per board, so an issue
         that sits on two boards is two cards that stopped moving. */
      headline: `${aging} of ${plural(inProgress, 'card')} in progress ${agree(aging, 'has', 'have')} not moved for more than ${ctx.config.agingWipDays} days.`,
      ratio,
      /* Cards, not boards: a board taken out as intentional takes its own cards out
         of both sides of the share, which is what the numbers on the items are for.
         A backlog board that keeps its cards for months is the case this serves. */
      affected: aging,
      total: inProgress,
      evidence: [
        { label: 'Boards with work in progress', value: measured },
      ],
      items: toItems(stalled, ({ reach, stale, total }) => ({
        id: reach.board.id,
        label: reach.board.name,
        detail: `${stale} of ${plural(total, 'card')}${reachNote(reach.left)}`,
        affected: stale,
        measured: total,
      })),
    };
  },
});

const overgrownBoards: CheckDefinition = checkOf({
  id: 'process.overgrown-boards',
  category: 'process',
  title: 'Boards with too many columns',
  weight: 4,
  why:
    'Past roughly seven columns a board stops being readable at a glance, which is ' +
    'the one thing a board is for. Columns tend to accumulate as the process is ' +
    'refined, and no one removes the ones that no longer carry work.',
  legitimateWhen:
    'A deliberately fine-grained process, for instance a release pipeline with ' +
    'several review stages.',
  whatItInvolves:
    'Merging columns changes what the field values mean for everyone ' +
    'using the board, and cards move as a result. Agreement with the ' +
    'team comes before the change.',
  run: async (ctx): Promise<Measured | null> => {
    /* Boards that live only on archived projects are out, here as in every other
       board check: nobody reads them at a glance or at all, so their columns are
       not a finding - and a report that names one invites the reader to doubt the
       rest of it. A board that spans an archived and an active project stays; it is
       still in use. */
    const active = new Set(
      countedProjects(await ctx.client.listProjects()).map((p) => p.shortName),
    );
    const boards = (await ctx.client.listAgileBoards()).filter((b) =>
      b.projects.some((shortName) => active.has(shortName)),
    );
    if (boards.length === 0) {
      throw new CheckSkipped('No board reaches a project that takes new work.');
    }

    const overgrown = boards.filter(
      (b) => b.columns.length > ctx.config.maxBoardColumns,
    );
    if (overgrown.length === 0) return null;

    const ratio = share(overgrown.length, boards.length);
    return {
      itemKind: 'board',
      headline: `${overgrown.length} of ${plural(boards.length, 'board')} ${agree(overgrown.length, 'has', 'have')} more than ${ctx.config.maxBoardColumns} columns.`,
      ratio,
      total: boards.length,
      items: toItems(overgrown, (b) => ({
        id: b.id,
        label: b.name,
        detail: `${b.columns.length} columns`,
      })),
    };
  },
});

// --- Governance --------------------------------------------------------------

const projectsWithoutLeader: CheckDefinition = checkOf({
  id: 'governance.projects-without-leader',
  category: 'governance',
  title: 'Projects without an owner',
  weight: 8,
  why:
    'A project without an active owner has nobody to decide on its configuration ' +
    'and access. Often a long-deactivated account is still listed as its leader.',
  legitimateWhen: 'A step on the way to archiving the project.',
  whatItInvolves:
    'Naming a leader is one setting. Finding someone who accepts the ' +
    'role is the actual work, and it is a conversation with whoever ' +
    'owns the domain.',
  run: async (ctx): Promise<Measured | null> => {
    const projects = (await ctx.client.listProjects()).filter((p) => !p.archived);
    if (projects.length === 0) throw new CheckSkipped('The instance has no active projects.');

    const orphaned = projects.filter((p) => !p.leader || p.leader.banned);
    if (orphaned.length === 0) return null;

    const ratio = share(orphaned.length, projects.length);
    return {
      itemKind: 'project',
      headline: `${orphaned.length} of ${plural(projects.length, 'active project')} ${agree(orphaned.length, 'has', 'have')} no active owner.`,
      ratio,
      total: projects.length,
      items: toItems(orphaned, (p) => ({
        id: p.id,
        label: p.shortName,
        detail: p.leader ? 'owner is deactivated' : 'no owner set',
      })),
    };
  },
});

const emptyGroups: CheckDefinition = checkOf({
  id: 'governance.empty-groups',
  category: 'governance',
  title: 'Empty user groups',
  weight: 4,
  why:
    'Groups without members dilute the permission model: when granting access it ' +
    'is no longer apparent which group actually takes effect.',
  legitimateWhen: 'Placeholders for a planned role structure.',
  whatItInvolves:
    'Removing a group is quick, but first it has to be clear that no ' +
    'permission scheme and no notification rule still refers to it.',
  run: async (ctx): Promise<Measured | null> => {
    const groups = await ctx.client.listGroups();
    if (groups.length === 0) throw new CheckSkipped('The instance has no user groups.');

    const empty = groups.filter((g) => g.usersCount === 0);
    if (empty.length === 0) return null;

    const ratio = share(empty.length, groups.length);
    return {
      itemKind: 'group',
      headline: `${empty.length} of ${plural(groups.length, 'user group')} ${agree(empty.length, 'has', 'have')} no members.`,
      ratio,
      total: groups.length,
      items: toItems(empty, (g) => ({ id: g.id, label: g.name })),
    };
  },
});

// --- Project portfolio -------------------------------------------------------

const dormantProjects: CheckDefinition = checkOf({
  id: 'portfolio.dormant-projects',
  category: 'portfolio',
  title: 'Dormant projects',
  weight: 7,
  why:
    'Projects with no activity that are still not archived keep appearing in ' +
    'pickers and reports, making the portfolio look larger than it is.',
  legitimateWhen: 'Retention for compliance reasons, or a reference project.',
  whatItInvolves:
    'Archiving keeps the data readable and takes one setting. What ' +
    'takes time is asking whether anyone still needs the project, and ' +
    'agreeing what happens to the issues in it.',
  run: async (ctx): Promise<Measured | null> => {
    const projects = countedProjects(await ctx.client.listProjects());
    if (projects.length === 0) throw new CheckSkipped('The instance has no active projects.');

    const since = isoDate(ctx.now, ctx.config.dormantProjectDays);
    /* A project without issues cannot have issue activity, and the total is already
       known: asking about it would be a round trip for a known answer. */
    const withIssues = projects.filter((p) => p.issuesCount > 0);
    const activity = requireCounts(
      await ctx.client.countMany(
        withIssues.map((p) => QUERIES.projectActivitySince(p.shortName, since)),
      ),
    );
    const dormant: Project[] = projects.filter((p) => p.issuesCount === 0);
    for (const [index, project] of withIssues.entries()) {
      if (activity[index] === 0) dormant.push(project);
    }
    if (dormant.length === 0) return null;

    const ratio = share(dormant.length, projects.length);
    return {
      itemKind: 'project',
      headline: `${dormant.length} of ${plural(projects.length, 'project')} that ${agree(projects.length, 'is', 'are')} not archived ${agree(dormant.length, 'has', 'have')} had no activity for more than ${ctx.config.dormantProjectDays} days.`,
      ratio,
      total: projects.length,
      items: toItems(dormant, (p) => ({ id: p.id, label: p.shortName })),
    };
  },
});

const tinyProjects: CheckDefinition = checkOf({
  id: 'portfolio.tiny-projects',
  category: 'portfolio',
  title: 'Projects that never got going',
  weight: 5,
  why:
    'Projects with a handful of issues are usually an experiment that was set up ' +
    'and then left. Each one still carries its own fields, permissions and board, ' +
    'and it appears in every picker an administrator has to maintain.',
  legitimateWhen:
    'A project that was just created, or one used for a small recurring task such ' +
    'as an on-call rotation.',
  whatItInvolves:
    'Merging a handful of issues into another project is quick; ' +
    'deciding where they belong, and who keeps the recurring task ' +
    'afterwards, is not. Each project also carries its own fields, ' +
    'permissions and board, which is what the clean-up is actually ' +
    'about.',
  run: async (ctx): Promise<Measured | null> => {
    const projects = countedProjects(await ctx.client.listProjects());
    if (projects.length === 0) throw new CheckSkipped('The instance has no active projects.');

    const tiny = projects.filter((p) => p.issuesCount < ctx.config.minProjectIssues);
    if (tiny.length === 0) return null;

    const ratio = share(tiny.length, projects.length);
    return {
      itemKind: 'project',
      headline: `${tiny.length} of ${plural(projects.length, 'active project')} ${agree(tiny.length, 'holds', 'hold')} fewer than ${plural(ctx.config.minProjectIssues, 'issue')}.`,
      ratio,
      total: projects.length,
      items: toItems(tiny, (p) => ({
        id: p.id,
        label: p.shortName,
        detail: `${p.issuesCount} issues`,
      })),
    };
  },
});

/** The full catalog, in report order. */
const stateWithoutResolved: CheckDefinition = checkOf({
  id: 'fields.state-without-resolved',
  category: 'fields',
  title: 'States that never count as resolved',
  weight: 10,
  why:
    'A state field in which no value counts as resolved leaves the project without ' +
    'a way to say that work is finished. The Unresolved filter then matches every ' +
    'issue, boards never empty their last column, and every report built on either ' +
    'counts completed work as open.',
  legitimateWhen:
    'A field that tracks something other than progress - a phase, a category or a ' +
    'stage that genuinely has no finished state.',
  whatItInvolves:
    'Marking the finished values as resolved is one setting per value. ' +
    'The decision before it is which values mean finished, and the work ' +
    'after it is the reporting that was built around the gap.',
  run: async (ctx): Promise<Measured | null> => {
    const active = new Set(
      (await ctx.client.listProjects()).filter((p) => !p.archived).map((p) => p.shortName),
    );
    const fields = (await ctx.client.listCustomFields()).filter((f) =>
      f.fieldType.startsWith('state'),
    );
    const bundles = new Map(
      (await ctx.client.listStateBundles()).map((bundle) => [bundle.id, bundle]),
    );

    /* Per project, not per field definition: a project gets its own value bundle,
       so the same State field can carry a resolved value in one project and none in
       the next. The pair of project and field is what an administrator changes. */
    const affected: Array<{ id: string; project: string; field: string; values: number }> = [];
    let measured = 0;
    for (const field of fields) {
      for (const instance of field.instances) {
        if (!active.has(instance.projectShortName)) continue;
        const bundle = instance.bundleId ? bundles.get(instance.bundleId) : undefined;
        if (!bundle || bundle.values.length === 0) continue;
        measured++;
        if (!bundle.values.some((value) => value.resolved)) {
          affected.push({
            /* The field as this project carries it, which is the object an
               administrator changes - and an id of YouTrack's making, rather than
               two names glued together, which no length can be promised of. */
            id: instance.id,
            project: instance.projectShortName,
            field: field.name,
            values: bundle.values.length,
          });
        }
      }
    }

    if (measured === 0) {
      throw new CheckSkipped('No active project has a state field with values.');
    }
    if (affected.length === 0) return null;

    const ratio = share(affected.length, measured);
    return {
      itemKind: 'project',
      headline: `${affected.length} of ${plural(measured, 'state field')} ${agree(affected.length, 'has', 'have')} no value that counts as resolved.`,
      ratio,
      total: measured,
      items: toItems(affected, ({ id, project, field, values }) => ({
        id,
        label: `${project} - ${field}`,
        // The way leads to the project; the label also names the field.
        target: project,
        detail: `${values} values, none of them resolved`,
      })),
    };
  },
});

const boardsOnArchivedProjects: CheckDefinition = checkOf({
  id: 'process.boards-on-archived-projects',
  category: 'process',
  title: 'Boards built on archived projects',
  weight: 3,
  why:
    'An archived project keeps its issues but takes no new work. A board that still ' +
    'includes one shows cards nobody can move on, and counts them as current work ' +
    'in its columns and charts.',
  legitimateWhen:
    'A board kept for a retrospective or an audit, where the archived project is ' +
    'the point of it.',
  whatItInvolves:
    'Taking the project off the board is one setting. The question ' +
    'before it is whether the board is still needed at all, which is ' +
    'the team\'s call rather than the administrator\'s.',
  run: async (ctx): Promise<Measured | null> => {
    const boards = await ctx.client.listAgileBoards();
    if (boards.length === 0) throw new CheckSkipped('The instance has no agile boards.');
    const archived = new Set(
      (await ctx.client.listProjects()).filter((p) => p.archived).map((p) => p.shortName),
    );
    if (archived.size === 0) {
      throw new CheckSkipped('The instance has no archived projects.');
    }

    const affected = boards
      .map((board) => ({
        board,
        projects: board.projects.filter((shortName) => archived.has(shortName)),
      }))
      .filter(({ projects }) => projects.length > 0);
    if (affected.length === 0) return null;

    const ratio = share(affected.length, boards.length);
    return {
      itemKind: 'board',
      headline: `${affected.length} of ${plural(boards.length, 'board')} still ${agree(affected.length, 'includes', 'include')} archived projects.`,
      ratio,
      total: boards.length,
      items: toItems(affected, ({ board, projects }) => ({
        id: board.id,
        label: board.name,
        detail: projects.join(', '),
      })),
    };
  },
});

export const CHECKS: readonly CheckDefinition[] = [
  inactiveUsers,
  unusedGlobalField,
  emptyField,
  duplicateFieldNames,
  stateWithoutResolved,
  unassignedUnresolved,
  staleUnresolved,
  boardsWithoutWipLimits,
  agingWip,
  overgrownBoards,
  boardsOnArchivedProjects,
  projectsWithoutLeader,
  emptyGroups,
  dormantProjects,
  tinyProjects,
];
