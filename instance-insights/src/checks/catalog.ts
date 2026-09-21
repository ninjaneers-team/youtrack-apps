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
  CheckDefinition,
  CustomField,
  Evidence,
  Finding,
  FindingItem,
  InstanceOperations,
  InstanceSettings,
  Project,
  ScanContext,
  User,
  ValueBundle,
} from '../types.ts';
import {
  agree,
  CheckSkipped,
  countedProjects,
  plural,
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
   * Issues that carry a value for the field, in the given projects only.
   *
   * `has:` alone answers for every project the field is attached to, and a field
   * is not required in all of them. The comma-separated list is how the search
   * language says "any of these", confirmed against an instance.
   */
  fieldFilledIn: (field: string, projects: readonly string[]): string =>
    `project: ${projects.map((shortName) => `{${shortName}}`).join(', ')} and has: {${field}}`,
  /**
   * Issues in the given projects that carry no value for the field.
   *
   * The negation sits on the field name, not in front of `has:`: `-has: {Field}` is
   * a 400, and `{Field}: {No Field}` is one too for a user field. Confirmed against
   * an instance with a real gap - a project of 23 issues where 4 carried the field
   * answered 19.
   */
  fieldEmptyIn: (field: string, projects: readonly string[]): string =>
    `project: ${projects.map((shortName) => `{${shortName}}`).join(', ')} and has: -{${field}}`,
  /** Issues that entered the instance in a window, by their creation date. */
  createdBetween: (from: string, to: string): string => `created: ${from} .. ${to}`,
  /**
   * Issues that left it in the same window, by the date they were resolved.
   *
   * The attribute is called `resolved date`. `resolved` on its own is not a
   * shorter form of it but a parse error, which would take the check down rather
   * than answer zero.
   */
  resolvedBetween: (from: string, to: string): string =>
    `resolved date: ${from} .. ${to}`,
  /** Open issues one account is responsible for. */
  openWorkOf: (login: string): string => `#Unresolved and Assignee: {${login}}`,
  /**
   * The cards a board holds, whichever sprint they sit in.
   *
   * A board is a search field: `Board <name>` carries the sprint an issue sits in,
   * so `has:` asks whether the issue is on the board at all. On a board that plans
   * in sprints that is not the whole answer - a card nobody scheduled sits in a
   * sprint of its own that `has:` does not count, so those sprints are named beside
   * it. Measured against a live instance: `has:` alone found no card at all on two
   * such boards out of four.
   *
   * A board that plans without sprints is asked with `has:` alone, and that is not
   * a shortcut. Such a board still reports a sprint, and naming it produced a count
   * the instance never delivered - polled for twenty seconds and beyond, always
   * -1 - while `has:` answered the same board correctly in under a fifth of a
   * second, in every run.
   */
  onBoard: (board: string, usesSprints: boolean, sprints: readonly string[]): string =>
    usesSprints
      ? `(has: {Board ${board}}` +
        sprints.map((sprint) => ` or {Board ${board}}: {${sprint}}`).join('') +
        ')'
      : `has: {Board ${board}}`,
  /**
   * Cards a board holds, in the projects a query may name.
   *
   * The project scope stays even though the board clause already narrows the
   * search - without it, the same board query answered in 140 ms on one run and
   * was still being computed twenty seconds later on the next. It also keeps
   * archived projects out, which search will not take as a scope anyway.
   *
   * What this does not ask is which of those cards are work in flight. Nothing in
   * an instance says which of a board's columns is a queue and which is work: a
   * state bundle marks only what counts as resolved, and a real vocabulary holds
   * On Hold beside In Review with nothing to tell them apart. A check that needs
   * that distinction cannot have it.
   */
  cardsOnBoard: (
    board: string,
    usesSprints: boolean,
    sprints: readonly string[],
    projects: readonly string[],
  ): string =>
    `${QUERIES.onBoard(board, usesSprints, sprints)} and ` +
    `project: ${projects.map((shortName) => `{${shortName}}`).join(', ')}`,
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
    'Withdrawing a seat is one setting. The work is the agreement: for ' +
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

    /* Two ways a field can go unanswered. A name has to go into a search query,
       and YouTrack answers 400 for one it cannot parse there - a name that collides
       with a query keyword, or carries a brace. And a count can still be being
       computed when the scan stops waiting for it. Either way the field stays out
       of both sides of the ratio, and the number of them is part of the evidence,
       so the report never presents an unmeasured field as measured. */
    const empties: Array<{
      id: string;
      name: string;
      share: number;
      projects: readonly string[];
    }> = [];
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
          projects: shortNames,
        });
      }
    }
    if (measured === 0) {
      throw new CheckSkipped(
        `The instance answered for none of the ${candidates.length} fields.`,
      );
    }
    if (empties.length === 0) return null;

    const ratio = share(empties.length, measured);
    return {
      itemKind: 'field',
      /* Names the population, because it is not every field: only the ones a
         project actually uses can be measured at all, and a second card in the same
         report counts all of them. Two cards saying "of 29 fields" and "of 46
         custom fields" leave the reader to guess which is which. */
      headline: `${empties.length} of ${plural(measured, 'field a project uses', 'fields a project uses')} ${agree(empties.length, 'is', 'are')} empty in more than ${pct(ctx.config.emptyFieldThreshold)} of the issues that could carry ${agree(empties.length, 'it', 'them')}.`,
      ratio,
      total: measured,
      evidence: [
        // Only what the headline cannot hold - and only when there is any.
        ...(unreachable > 0
          ? [{ label: 'Fields the instance did not answer for', value: unreachable }]
          : []),
      ],
      items: toItems(empties, ({ id, name, share: emptyShare, projects: where }) => ({
        id,
        label: name,
        detail: `${pct(emptyShare)} empty across ${plural(where.length, 'project')}`,
        // The row names a field and counts issues, so the number leads to them.
        query: QUERIES.fieldEmptyIn(name, where),
      })),
    };
  },
});

/**
 * The values of a list, in a form two lists can be compared by.
 *
 * Sorted, because the order values are listed in is a display decision and two
 * lists holding the same values in a different order are the same list. Encoded
 * rather than joined by a separator, so a value that contains the separator cannot
 * make two different lists look equal.
 */
function valueKey(bundle: ValueBundle): string {
  return JSON.stringify([...bundle.values].sort());
}

/**
 * How long an identifier a check builds may be.
 *
 * The handler refuses a longer one, which would leave the object unmarkable; a
 * shortened name still marks. `test/catalog.test.ts` holds every check against this,
 * so the two sides cannot drift apart.
 */
export const MAX_ITEM_ID = 250;

/**
 * Which fields offer a list, by the list's own id.
 *
 * A list of values means nothing to a reader on its own - "Bug, Task, Feature" is
 * not something anybody can act on until they know it is the Type field. The field
 * list already carries the connection, and it is read by other checks anyway, so
 * naming the field costs no request.
 */
function fieldsByBundle(fields: readonly CustomField[]): Map<string, Set<string>> {
  const byBundle = new Map<string, Set<string>>();
  for (const field of fields) {
    for (const instance of field.instances) {
      if (instance.bundleId === null) {
        continue;
      }
      const named = byBundle.get(instance.bundleId) ?? new Set<string>();
      named.add(field.name);
      byBundle.set(instance.bundleId, named);
    }
  }
  return byBundle;
}

/**
 * How many of a list's values a row names before it counts the rest.
 *
 * A list is recognised by its first few values; a state vocabulary of forty ran to
 * six hundred characters in a row of a table, and neither a page nor a printed
 * document has room for that.
 */
const VALUES_NAMED = 6;

/** The values of a list as a row names them: enough to recognise it, then a count. */
function valuesShown(values: readonly string[]): string {
  if (values.length <= VALUES_NAMED) {
    return values.join(', ');
  }
  const rest = values.length - VALUES_NAMED;
  return `${values.slice(0, VALUES_NAMED).join(', ')} and ${rest} more`;
}

/**
 * The identity of a group of lists holding the same values.
 *
 * The values themselves, not one of the lists: which copies exist changes as
 * projects come and go, and a decision is about the set of values they share. The
 * count goes in front so two groups cannot become one by being cut to the same
 * length - which only a list of some fifty values reaches at all.
 */
function valueGroupId(values: readonly string[]): string {
  return `${values.length}:${[...values].sort().join('|')}`.slice(0, MAX_ITEM_ID);
}

const clonedValueLists: CheckDefinition = checkOf({
  id: 'fields.cloned-value-lists',
  category: 'fields',
  title: 'Value lists kept as copies',
  weight: 7,
  why:
    'A new project gets a list of values of its own unless someone picks an ' +
    'existing one, so copies of the same list accumulate without anyone deciding ' +
    'to make them. Renaming a value then has to happen once per copy, and a report ' +
    'that groups by the field treats each copy as its own set of values, which is ' +
    'what makes an analysis across projects come out wrong rather than merely ' +
    'incomplete.',
  legitimateWhen:
    'Projects that are meant to grow apart, where one of them will take values the ' +
    'others should not have.',
  whatItInvolves:
    'Pointing several projects at one list is a setting per project, and the values ' +
    'have to match before it can be done. The agreement in front of it is the work: ' +
    'the teams sharing a list share every later change to it.',
  run: async (ctx): Promise<Measured | null> => {
    const bundles = await ctx.client.listValueBundles();
    const named = fieldsByBundle(await ctx.client.listCustomFields());
    /* An empty list is a different matter - a field nobody finished setting up -
       and comparing empty to empty would group all of them into one large finding
       about nothing. */
    const filled = bundles.filter((bundle) => bundle.values.length > 0);
    if (filled.length === 0) {
      throw new CheckSkipped('No list of field values in this instance holds a value.');
    }

    const groups = new Map<string, ValueBundle[]>();
    for (const bundle of filled) {
      const key = valueKey(bundle);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [bundle]);
      } else {
        group.push(bundle);
      }
    }
    const copied = [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        id: valueGroupId(group[0]?.values ?? []),
        values: group[0]?.values ?? [],
        copies: group.length,
        /* Every field the copies of this list belong to. Usually one - each project
           holds a copy of the same field's list - but a set of values is free to be
           offered by two fields, and then the row has to name both or it names the
           wrong one. */
        fields: [
          ...new Set(group.flatMap((bundle) => [...(named.get(bundle.id) ?? [])])),
        ].sort(),
      }));
    if (copied.length === 0) return null;

    /* One copy of a list is the list; the rest are the copies. Counting whole
       groups would say two lists that exist twice are the same finding as two that
       exist forty times over. */
    const redundant = copied.reduce((sum, group) => sum + group.copies - 1, 0);
    const ratio = share(redundant, filled.length);
    return {
      itemKind: 'value-list',
      headline: `${redundant} of ${plural(filled.length, 'value list')} ${agree(redundant, 'is', 'are')} a copy of another list holding the same values.`,
      ratio,
      affected: redundant,
      total: filled.length,
      items: toItems(copied, (group) => ({
        // The values are the identity of the group: the names of the lists differ
        // from copy to copy, and a decision about one of them is a decision about
        // the set of values they all hold.
        id: group.id,
        label:
          group.fields.length === 0
            ? valuesShown(group.values)
            : `${group.fields.join(', ')}: ${valuesShown(group.values)}`,
        detail: `${plural(group.copies, 'list')} with these values`,
        affected: group.copies - 1,
        measured: group.copies,
      })),
    };
  },
});

const requiredButEmpty: CheckDefinition = checkOf({
  id: 'fields.required-but-empty',
  category: 'fields',
  title: 'Required fields without a value',
  weight: 9,
  why:
    'A project can declare that a field must hold a value. Issues that have none ' +
    'anyway got there before the rule was made, through an import, or through the ' +
    'API, which does not enforce it. Every report that groups by the field carries ' +
    'them as a category nobody asked for, and that is what makes numbers out of ' +
    'YouTrack disagree with each other.',
  legitimateWhen:
    'A requirement introduced recently and deliberately not applied backwards, ' +
    'where the older issues are closed and nobody will report on them again.',
  whatItInvolves:
    'Filling the gaps is a bulk edit per field, and the question in front of it is ' +
    'what the value should be for issues nobody remembers. Where that cannot be ' +
    'answered, the honest change is to the requirement rather than to the issues.',
  run: async (ctx): Promise<Measured | null> => {
    const projects = countedProjects(await ctx.client.listProjects());
    const issuesByProject = new Map(projects.map((p) => [p.shortName, p.issuesCount]));
    const fields = await ctx.client.listCustomFields();

    /* Only the projects that require the field, and only those a query can name:
       the reference is their issue total, which the project list already carries.
       So a field costs one count no matter how many projects require it. */
    const candidates = fields
      .map((field) => {
        const where = field.instances
          .filter((i) => i.required && issuesByProject.has(i.projectShortName))
          .map((i) => i.projectShortName);
        return {
          field,
          where,
          issues: where.reduce(
            (total, shortName) => total + (issuesByProject.get(shortName) ?? 0),
            0,
          ),
        };
      })
      .filter(({ where, issues }) => where.length > 0 && issues > 0);
    if (candidates.length === 0) {
      throw new CheckSkipped('No project in this instance requires a value for a field.');
    }

    const filledCounts = await ctx.client.countMany(
      candidates.map(({ field, where }) => QUERIES.fieldFilledIn(field.name, where)),
    );
    const gaps: Array<{
      id: string;
      name: string;
      gap: number;
      issues: number;
      where: readonly string[];
    }> = [];
    let requiredValues = 0;
    let unreachable = 0;
    for (const [index, { field, where, issues }] of candidates.entries()) {
      const result = filledCounts[index];
      if (!result || 'failed' in result) {
        unreachable++;
        continue;
      }
      requiredValues += issues;
      // Filled and total are two counts taken moments apart, so the difference can
      // come out negative when issues moved in between. That is not a gap.
      const gap = Math.max(0, issues - result.count);
      if (gap > 0) {
        gaps.push({ id: field.id, name: field.name, gap, issues, where });
      }
    }
    if (requiredValues === 0) {
      throw new CheckSkipped(
        `The instance answered for none of the ${candidates.length} required fields.`,
      );
    }
    if (gaps.length === 0) return null;

    const missing = gaps.reduce((sum, entry) => sum + entry.gap, 0);
    const ratio = share(missing, requiredValues);
    return {
      itemKind: 'field',
      /* Counted in values, not in issues: an issue in a project that requires two
         fields owes two values, and calling that one issue would make the number
         smaller than what has to be filled in. */
      headline: `${missing} of ${plural(requiredValues, 'value')} a project requires ${agree(missing, 'is', 'are')} not filled in.`,
      ratio,
      affected: missing,
      total: requiredValues,
      evidence: [
        ...(unreachable > 0
          ? [{ label: 'Required fields the instance did not answer for', value: unreachable }]
          : []),
      ],
      items: toItems(gaps, (entry) => ({
        id: entry.id,
        label: entry.name,
        detail: `${entry.gap} of ${plural(entry.issues, 'issue')} in ${plural(entry.where.length, 'project')}`,
        /* The row names a field and counts issues. Without this the only way out of
           it was the page that lists every field, which cannot answer "which of
           those twelve thousand issues". */
        query: QUERIES.fieldEmptyIn(entry.name, entry.where),
        affected: entry.gap,
        measured: entry.issues,
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
    const ratio = share(unassigned, total);
    /* The threshold decides whether this is worth reporting, not what the share is.
       A moderate number of unassigned issues is a pull model rather than a problem,
       so below it the check says nothing - and above it it says the share it
       measured, like every other check. Scaling the distance above the threshold
       into the ratio put a second number on the page that the headline's own two
       could not produce: 2247 of 2688 is 84 %, and the trend said 79 %. */
    if (ratio <= ctx.config.unassignedThreshold) return null;

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
 * Whether a limit has anywhere to sit on this board.
 *
 * A limit belongs on a column work passes through, so the board needs one after the
 * column work arrives in - which is what more than one unfinished column means. The
 * instance's own resolved flag says which columns are the end, rather than "the
 * last one": a board may end in more than one of them, Released beside Cancelled,
 * and the instance does not list its columns in board order anyway.
 *
 * Which of the unfinished columns is the queue and which is the work is not asked,
 * because nothing in an instance says: a state bundle marks only what counts as
 * resolved, and a real vocabulary holds On Hold beside In Review with nothing to
 * tell them apart. Only the count matters here, and the count does not need it.
 */
function hasColumnForLimit(board: AgileBoard): boolean {
  return board.columns.filter((c) => !c.resolved).length > 1;
}

const boardsWithoutWipLimits: CheckDefinition = checkOf({
  id: 'process.boards-without-wip-limits',
  category: 'process',
  title: 'Boards with no limit on work in progress',
  weight: 5,
  why:
    'A column without a limit takes any amount of work, so a board in use without ' +
    'one cannot say when it is full. Usually that is not a decision but a setting ' +
    'nobody made.',
  legitimateWhen:
    'A team that limits work in another way - by agreement, or by the size of the ' +
    'team - and reads the board as a status view rather than as a pull system.',
  whatItInvolves:
    'One setting per column, and a number the team has to agree on. A ' +
    'limit imposed from outside gets worked around, so the setting is ' +
    'the smaller half.',
  run: async (ctx): Promise<Measured | null> => {
    /* Only boards that plan without sprints, that have a column where a limit
       belongs, and that hold cards at all. A sprint board limits work through its
       sprint, a board of two columns has nothing in between, and an empty board has
       nothing to limit - judged by this rule, each would be reported for a setting
       it does not need. */
    const active = new Set(
      countedProjects(await ctx.client.listProjects()).map((p) => p.shortName),
    );
    const flowBoards = reachOf(
      (await ctx.client.listAgileBoards()).filter(
        (b) => !b.usesSprints && b.columnField !== '',
      ),
      active,
    ).filter((r) => r.projects.length > 0 && hasColumnForLimit(r.board));
    if (flowBoards.length === 0) {
      throw new CheckSkipped(
        'No board plans without sprints, where a column limit is the instrument.',
      );
    }

    const cardCounts = await ctx.client.countMany(
      flowBoards.map((reach) =>
        QUERIES.cardsOnBoard(
          reach.board.name,
          reach.board.usesSprints,
          reach.board.sprints,
          reach.projects,
        ),
      ),
    );

    const carrying: Array<{ reach: BoardReach; cards: number }> = [];
    const without: Array<{ reach: BoardReach; cards: number }> = [];
    let unanswered = 0;
    for (const [index, reach] of flowBoards.entries()) {
      const result = cardCounts[index];
      /* A count the instance will not deliver is a board left out, not a failed
         check. Asking a board about its own cards is a question the instance
         sometimes answers in a fifth of a second and sometimes not at all, and one
         such board used to take this whole check down with it. */
      if (result === undefined || 'failed' in result) {
        unanswered++;
        continue;
      }
      if (result.count === 0) continue;
      carrying.push({ reach, cards: result.count });
      const limited = reach.board.columns.some(
        (c) => c.wipLimitMin != null || c.wipLimitMax != null,
      );
      if (!limited) without.push({ reach, cards: result.count });
    }

    if (carrying.length === 0) {
      /* Two different statements, and the check may only make the one it measured:
         that no board in use holds a card, or that it could not find out. */
      throw new CheckSkipped(
        unanswered > 0
          ? `The instance would not count the cards of ${plural(unanswered, 'board')} that plans without sprints.`
          : 'No board without sprints holds a card.',
      );
    }
    if (without.length === 0) return null;

    const ratio = share(without.length, carrying.length);
    return {
      itemKind: 'board',
      headline: `${without.length} of ${plural(carrying.length, 'board')} in use ${agree(without.length, 'has', 'have')} no limit on any column.`,
      ratio,
      total: carrying.length,
      /* Only the boards nothing could be measured about, and only when there are
         any. The cards were in here too, as one sum over the boards in the list -
         which was the same measurement the rows already carry, in a unit the
         headline does not use: the share is boards of boards, and a board holds
         every card it ever held, finished ones included. Under a heading about work
         in progress that sum read as work in progress. */
      evidence:
        unanswered > 0
          ? [{ label: 'Boards the instance did not answer for', value: unanswered }]
          : [],
      items: toItems(without, ({ reach, cards }) => ({
        id: reach.board.id,
        label: reach.board.name,
        /* Says what the number is: how big the board is, which is what makes one
           missing limit worth more attention than another. Bare, it read as a count
           of cards in progress. */
        detail: `${plural(cards, 'card')} on the board${reachNote(reach.left)}`,
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
      /* Which boards, because a board whose every project is archived is out of
         this count while another card in the same report counts all of them. */
      headline: `${overgrown.length} of ${plural(boards.length, 'board on a project that still takes work', 'boards on a project that still takes work')} ${agree(overgrown.length, 'has', 'have')} more than ${ctx.config.maxBoardColumns} columns.`,
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

const intakeVsThroughput: CheckDefinition = checkOf({
  id: 'process.intake-vs-throughput',
  category: 'process',
  title: 'More work arriving than leaving',
  weight: 7,
  why:
    'An instance that takes in more issues than it finishes accumulates a backlog ' +
    'that no amount of prioritising inside it can clear. The two numbers are the ' +
    'ones a capacity conversation starts from, and neither of them is visible from ' +
    'inside a single project.',
  legitimateWhen:
    'A phase of deliberate collecting - a discovery period, a migration, or an ' +
    'intake that is meant to be triaged later.',
  whatItInvolves:
    'Nothing in the configuration changes this. What it decides is a conversation ' +
    'about capacity and about what is allowed to arrive: who may open an issue, ' +
    'what gets triaged away, and whether the team that finishes them is the size ' +
    'the arrival rate assumes.',
  run: async (ctx): Promise<Measured | null> => {
    const days = ctx.config.flowWindowDays;
    const from = isoDate(ctx.now, days);
    const to = isoDate(ctx.now, 0);
    const counts = requireCounts(
      await ctx.client.countMany([
        QUERIES.createdBetween(from, to),
        QUERIES.resolvedBetween(from, to),
      ]),
    );
    const [created, resolved] = counts;
    if (created === undefined || resolved === undefined) {
      throw new Error('The instance answered fewer counts than were asked for.');
    }
    if (created === 0) {
      throw new CheckSkipped(`No issue was created in this instance in ${days} days.`);
    }
    if (resolved >= created) return null;

    /* The share of the arrivals that stayed. A window that ends level comes out at
       zero rather than at a threshold, so an instance that is just about keeping
       up reads as just about keeping up. */
    const ratio = share(created - resolved, created);
    return {
      headline: `This instance took in ${plural(created, 'issue')} in the last ${days} days and finished ${resolved}.`,
      ratio,
      query: QUERIES.createdBetween(from, to),
    };
  },
});

// --- Governance --------------------------------------------------------------

const openWorkOfBlockedAccounts: CheckDefinition = checkOf({
  id: 'governance.open-work-of-blocked-accounts',
  category: 'governance',
  title: 'Open work on accounts without access',
  weight: 7,
  itemsNamePeople: true,
  why:
    'Blocking an account is the last step of an offboarding, and the issues that ' +
    'were assigned to it stay where they are. Nobody looks there, because the ' +
    'assignee is somebody who has left, and no filter anyone still uses names them.',
  legitimateWhen:
    'Issues kept for the record on purpose, or a project that was closed together ' +
    'with the account.',
  whatItInvolves:
    'Reassigning is a bulk edit per account. The decision in front of it belongs to ' +
    'whoever took the work over, and it is worth making it a step of the ' +
    'offboarding: reassign first, block afterwards.',
  run: async (ctx): Promise<Measured | null> => {
    const blocked = (await ctx.client.listUsers()).filter((user) => user.banned);
    if (blocked.length === 0) {
      throw new CheckSkipped('No account in this instance is blocked.');
    }
    const open = await ctx.client.count(QUERIES.unresolved());
    if (open === 0) {
      throw new CheckSkipped('The instance has no open issues.');
    }

    const counts = await ctx.client.countMany(
      blocked.map((user) => QUERIES.openWorkOf(user.login)),
    );
    const holders: Array<{ user: User; open: number }> = [];
    let unreachable = 0;
    for (const [index, user] of blocked.entries()) {
      const result = counts[index];
      /* Two ways an account can go unanswered: a login free to hold a character
         the parser reads as syntax, and a count the instance was still computing
         when the scan stopped waiting. Either way the account is unmeasured rather
         than clean, and the number of them travels with the finding. */
      if (!result || 'failed' in result) {
        unreachable++;
        continue;
      }
      if (result.count > 0) {
        holders.push({ user, open: result.count });
      }
    }
    if (holders.length === 0) return null;

    const stranded = holders.reduce((sum, entry) => sum + entry.open, 0);
    const ratio = share(stranded, open);
    return {
      itemKind: 'account',
      headline: `${stranded} of ${plural(open, 'open issue')} ${agree(stranded, 'is', 'are')} assigned to an account that can no longer sign in.`,
      ratio,
      evidence: [
        ...(unreachable > 0
          ? [{ label: 'Blocked accounts the instance did not answer for', value: unreachable }]
          : []),
      ],
      /* No weights on the rows, and no population on the finding: this check names
         people, so the app never stores its objects and a single account cannot be
         marked. What can be marked is the finding as a whole. */
      items: toItems(holders, (entry) => ({
        id: entry.user.id,
        label: entry.user.login,
        detail: plural(entry.open, 'open issue'),
      })),
    };
  },
});

const boardsOwnedByBlockedAccounts: CheckDefinition = checkOf({
  id: 'governance.boards-owned-by-blocked-accounts',
  category: 'governance',
  title: 'Boards whose owner has no access',
  weight: 3,
  why:
    'A board belongs to the account that created it. When that account loses ' +
    'access, the board keeps working and keeps being used, but the person who ' +
    'knew what it was for is gone - and so is anyone who feels responsible for its ' +
    'columns and its sprints.',
  legitimateWhen:
    'A board the team maintains together, where the owner was only ever whoever ' +
    'happened to create it.',
  whatItInvolves:
    'Handing a board over is one setting. Deciding who to hand it to is a question ' +
    'for the team that uses it, and it is worth asking whether the board is still ' +
    'in use at all.',
  run: async (ctx): Promise<Measured | null> => {
    const boards = await ctx.client.listAgileBoards();
    if (boards.length === 0) {
      throw new CheckSkipped('The instance has no agile boards.');
    }
    /* An owner the instance did not name is not an owner without access. The
       attribute is optional here for that reason: absent means unknown, and an
       unknown owner is no finding. */
    const orphaned = boards.filter((board) => board.owner?.banned === true);
    if (orphaned.length === 0) return null;

    const ratio = share(orphaned.length, boards.length);
    return {
      itemKind: 'board',
      headline: `${orphaned.length} of ${plural(boards.length, 'board')} ${agree(orphaned.length, 'belongs', 'belong')} to an account that can no longer sign in.`,
      ratio,
      total: boards.length,
      // The board is what a reader acts on, and the account behind it stays out of
      // the row: a finding about configuration should not carry a person's login
      // into what gets stored.
      items: toItems(orphaned, (board) => ({ id: board.id, label: board.name })),
    };
  },
});

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
    'Moving a handful of issues into another project is a bulk edit. The work is ' +
    'deciding where they belong, and who keeps the recurring task afterwards - ' +
    'which is a question for whoever set the project up.',
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

// --- Instance setup ----------------------------------------------------------

/**
 * What the instance says about the server it runs on, for the checks that are
 * only answerable where somebody owns that server.
 *
 * The gate opens only on a positive answer. JetBrains states that a telemetry
 * attribute an edition does not support comes back empty, so a path that arrives
 * is proof of a server of one's own - while its absence could equally be a reader
 * without the permission to ask. Treating silence as proof would tell the
 * administrator of a hosted instance that his email is switched off, and a single
 * finding like that costs the credibility of every other one.
 */
async function ownServer(ctx: ScanContext): Promise<InstanceOperations> {
  const operations = await ctx.client.readOperations();
  if (operations === null) {
    throw new CheckSkipped(
      'Reading how this instance is run needs permission to administer it.',
    );
  }
  if (!operations.selfHosted) {
    throw new CheckSkipped(
      'This instance is run for you, so the server behind it is looked after for you.',
    );
  }
  return operations;
}

/** The settings that are read as a whole, or the reason there is nothing to read. */
async function instanceSettings(ctx: ScanContext): Promise<InstanceSettings> {
  const settings = await ctx.client.readSettings();
  if (settings === null) {
    throw new CheckSkipped(
      'Reading the settings of this instance needs permission to administer it.',
    );
  }
  return settings;
}

const memoryBelowDatabase: CheckDefinition = checkOf({
  id: 'instance.memory-below-database',
  category: 'instance',
  title: 'Less memory than database',
  weight: 6,
  why:
    'JetBrains states the rule plainly: the memory available to YouTrack should be ' +
    'larger than the database it works on. Below that, searches take longer and ' +
    'complex ones take much longer. Nothing announces it - YouTrack raises its own ' +
    'memory in steps on its own, but stops before it would take four fifths of the ' +
    'machine, and then simply keeps going slower.',
  legitimateWhen:
    'A database whose size comes from attachments rather than from issues, where ' +
    'the part that is searched is much smaller than the whole.',
  whatItInvolves:
    'More memory for the server, which is a change to how it is started and ' +
    'usually a request to whoever runs the machine. The alternative is a smaller ' +
    'database, and the first place to look there is attachments.',
  run: async (ctx): Promise<Measured | null> => {
    const operations = await ownServer(ctx);
    const { databaseBytes, memoryBytes, databaseText, memoryText } = operations;
    if (databaseBytes === null || memoryBytes === null) {
      throw new CheckSkipped(
        'This instance did not state both its database size and its memory.',
      );
    }
    if (memoryBytes >= databaseBytes) return null;

    const ratio = share(databaseBytes - memoryBytes, databaseBytes);
    return {
      headline: `The database is ${databaseText} and YouTrack has ${memoryText} of memory to work on it.`,
      ratio,
    };
  },
});

const noWayToNotify: CheckDefinition = checkOf({
  id: 'instance.no-way-to-notify',
  category: 'instance',
  title: 'Nothing can be announced',
  weight: 5,
  why:
    'Email has to be switched on for this instance to tell anybody anything, and ' +
    'an address has to be set for what it has to say about itself. Where both are ' +
    'missing, an assignment reaches nobody and neither does a warning about the ' +
    'instance - and it looks like a quiet tool rather than a switched-off one, ' +
    'which is why teams drift to talking around it.',
  legitimateWhen:
    'Notifications deliberately handled elsewhere, through a chat integration that ' +
    'carries them instead.',
  whatItInvolves:
    'Both are settings, and the work is not in setting them: an outgoing mail ' +
    'server has to exist and be allowed to send, which is a conversation with ' +
    'whoever runs mail.',
  run: async (ctx): Promise<Measured | null> => {
    await ownServer(ctx);
    const settings = await instanceSettings(ctx);
    /* Two ways out of the instance, judged separately, because an attribute this
       instance did not answer is not a channel that is missing. Only what came
       back counts - on either side of the share. */
    const channels = [
      {
        known: settings.mailEnabled !== null,
        missing: settings.mailEnabled === false,
        said: 'Email notifications are switched off, so a change to an issue reaches nobody.',
      },
      {
        known: true,
        missing: !settings.administratorEmail,
        said: 'No address is set for what this instance has to say about itself.',
      },
    ];
    const known = channels.filter((channel) => channel.known);
    if (known.length === 0) {
      throw new CheckSkipped('This instance did not state how it reaches anyone.');
    }
    const missing = known.filter((channel) => channel.missing);
    if (missing.length === 0) return null;

    return {
      headline: missing.map((channel) => channel.said).join(' '),
      ratio: share(missing.length, known.length),
    };
  },
});

/** Addresses that resolve on the server and nowhere else. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Whether an address only works on the machine that serves it.
 *
 * An address the URL parser cannot read is left alone rather than reported: it may
 * be a form this app does not know, and claiming a broken link on that basis would
 * be a guess.
 */
function localOnly(said: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(said).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const baseUrlLocalOnly: CheckDefinition = checkOf({
  id: 'instance.address-only-works-here',
  category: 'instance',
  title: 'Links that only work on the server',
  weight: 4,
  why:
    'Every link this instance sends out - in an email, in an invitation - is built ' +
    'from one address it was given at setup. When that address is the one the ' +
    'server sees itself under, the links work for nobody who receives them, and ' +
    'the usual reading of that is that notifications are broken.',
  legitimateWhen:
    'An instance that is only ever reached from the machine it runs on, and sends ' +
    'nothing to anybody.',
  whatItInvolves:
    'One setting, once the address the instance is reached under is known. Where a ' +
    'proxy sits in front, it is that address rather than the one the server sees.',
  run: async (ctx): Promise<Measured | null> => {
    await ownServer(ctx);
    const settings = await instanceSettings(ctx);
    const said = settings.baseUrl;
    if (said === null) {
      throw new CheckSkipped('This instance did not state the address it puts into its links.');
    }
    if (said.length === 0) {
      return {
        headline: 'This instance has no address set for the links it sends out.',
        ratio: 1,
      };
    }
    if (!localOnly(said)) return null;

    return {
      headline: `The links this instance sends out are built from ${said}, which resolves on the server and nowhere else.`,
      ratio: 1,
    };
  },
});

export const CHECKS: readonly CheckDefinition[] = [
  inactiveUsers,
  unusedGlobalField,
  emptyField,
  clonedValueLists,
  requiredButEmpty,
  duplicateFieldNames,
  stateWithoutResolved,
  unassignedUnresolved,
  staleUnresolved,
  intakeVsThroughput,
  boardsWithoutWipLimits,
  overgrownBoards,
  boardsOnArchivedProjects,
  projectsWithoutLeader,
  emptyGroups,
  openWorkOfBlockedAccounts,
  boardsOwnedByBlockedAccounts,
  dormantProjects,
  tinyProjects,
  memoryBelowDatabase,
  noWayToNotify,
  baseUrlLocalOnly,
];
