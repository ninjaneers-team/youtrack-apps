/**
 * Core domain types for the Instance Insights scan engine.
 *
 * Design rule: nothing in this file knows about HTTP, YouTrack REST paths or the
 * app framework. Checks receive a ScanContext and return a Finding. That keeps
 * the whole catalog testable against a mock client.
 */

export type Category =
  | 'licensing'
  | 'fields'
  | 'process'
  | 'governance'
  | 'portfolio'
  | 'instance';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Multiplier applied to a check's weight when a finding fires at this severity. */
export const SEVERITY_FACTOR: Record<Severity, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

/**
 * Where one severity band ends and the next begins, as a share of what a check
 * measured.
 *
 * A constant rather than four numbers inside a function, because the report names
 * them: a reader who is told "critical" without being told from where is left to
 * guess, and a guessed threshold is the kind of detail that costs a report its
 * credibility. The bands line up with the factors in SEVERITY_FACTOR.
 */
export const SEVERITY_FROM: Record<Severity, number> = {
  critical: 0.75,
  high: 0.5,
  medium: 0.25,
  low: 0,
};

/**
 * Severity band for a finding, derived from its ratio.
 *
 * Severity stays out of the score, where the deduction is weight * ratio and
 * nothing else. It is a display concern only: it drives ordering and the colour in
 * the report.
 */
export function severityFromRatio(ratio: number): Severity {
  if (ratio >= SEVERITY_FROM.critical) return 'critical';
  if (ratio >= SEVERITY_FROM.high) return 'high';
  if (ratio >= SEVERITY_FROM.medium) return 'medium';
  return 'low';
}

/**
 * A part of a whole, as a share in 0..1.
 *
 * Where both numbers are counts, they come from two searches the instance answered
 * moments apart, and issues move between them: a subset counted second can come
 * back larger than the set counted first - a bulk import of old issues is enough.
 * A share above one would break the score's contract, so it is bounded here rather
 * than at each call site. The counted numbers stay as the instance gave them,
 * because those are what the headline states.
 */
export function share(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(1, Math.max(0, part / whole));
}

/**
 * Continuous ratio for a "share over a threshold" check. Zero at the threshold,
 * one at 100 %, so a check that barely trips returns a small ratio instead of
 * jumping to 1: a binary ratio would make the score jump, which makes it worthless.
 * `value` and `threshold` are both shares in 0..1.
 */
export function ratioAboveThreshold(value: number, threshold: number): number {
  if (threshold >= 1) return value >= 1 ? 1 : 0;
  const scaled = (value - threshold) / (1 - threshold);
  return Math.min(1, Math.max(0, scaled));
}

export const CATEGORY_WEIGHT: Record<Category, number> = {
  licensing: 3,
  fields: 2,
  process: 2,
  governance: 2,
  portfolio: 1,
  instance: 2,
};

export const CATEGORY_LABEL: Record<Category, string> = {
  licensing: 'Licences',
  fields: 'Fields & configuration',
  process: 'Process hygiene',
  governance: 'Governance',
  portfolio: 'Project portfolio',
  instance: 'Instance setup',
};

/**
 * A count with its noun: `plural(1, 'board')` reads "1 board", `plural(3, 'board')`
 * reads "3 boards". The regular plural unless a second form is given.
 *
 * Every headline states a number the instance produced, and a number can be one.
 * "1 groups of fields carry the same meaning" is the kind of sentence that makes a
 * reader doubt the measurement behind it. Here rather than in the report, because
 * checks write sentences too and may import nothing else.
 */
export function plural(n: number, noun: string, many = `${noun}s`): string {
  return `${n} ${pluralNoun(n, noun, many)}`;
}

/** Just the noun in the form a count needs, for a heading that carries the count. */
export function pluralNoun(n: number, noun: string, many = `${noun}s`): string {
  return n === 1 ? noun : many;
}

/**
 * A ratio as whole percent, which is how every report states a share.
 *
 * Here rather than with the other report vocabulary because the trend needs the
 * same rounding: it decides whether a check moved, and it may only call a move a
 * move if a report can show it.
 */
export function percent(ratio: number): number {
  return Math.round(ratio * PERCENT_FACTOR);
}

const PERCENT_FACTOR = 100;

/**
 * The verb form that agrees with a count: `agree(1, 'has', 'have')` is "has".
 *
 * Only exactly one takes the singular - "0 boards have", "0.5 points" - so the
 * comparison is against one and not against a range.
 */
export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A single number shown next to a finding, e.g. "Affected users: 14". */
export interface Evidence {
  label: string;
  value: string | number;
}

/** Drill-down row. Complete, and never an issue body: names of projects, boards, accounts. */
export interface FindingItem {
  id: string;
  label: string;
  /**
   * What a report should lead to, when that is not the label.
   *
   * Most items are named by the thing they are - a project by its key, a board by
   * its name - but not all: a state field is named "PROJECT / State", and the way
   * there is the project. The check knows which; a report cannot guess it.
   */
  target?: string;
  detail?: string;
  /**
   * What this object contributes to the measured share, where objects weigh
   * differently from one another.
   *
   * A board with 18 stopped cards out of 18 weighs more than one with 2 out of 2,
   * so `(items - marked) / total` would be wrong for that finding: taking the big
   * board out has to take its cards out too. `affected` is this object's part of
   * the numerator, `measured` its part of the population - zero where the object
   * is counted in the numerator but its own existence is not the population, as
   * with a group of fields sharing a name among all the fields there are.
   *
   * Set together with `Finding.affected`, or not at all.
   */
  affected?: number;
  measured?: number;
}

export interface Finding {
  checkId: string;
  severity: Severity;
  /** One sentence with the concrete number in it. This is what the report shows. */
  headline: string;
  /**
   * Badness from 0..1. Multiplied by the check weight to produce the score
   * deduction. A check that fires but is barely over threshold should return a
   * small ratio, not 1 - otherwise the score is binary and useless.
   */
  ratio: number;
  evidence: Evidence[];
  items?: FindingItem[];
  /**
   * How many things the ratio was measured against, when the items are the affected
   * ones out of that many.
   *
   * Set only where one item means one affected thing out of a countable population -
   * 5 of 40 projects, 2 of 9 groups. That is what lets a report recompute the ratio
   * when single items are marked as intentional: `(items - marked) / total`. A check
   * that counts issues rather than listing them, or whose items weigh differently
   * from one another, leaves this unset and can only be marked as a whole.
   */
  total?: number;
  /**
   * The counted numerator behind `ratio`, when it is not the number of items.
   *
   * "25 of 25 cards in progress have stopped moving" is measured in cards and
   * listed in boards, so the number of items says nothing about the share. Where
   * this is set, every item carries its own `affected` and `measured`, and marking
   * one takes both out of the fraction.
   */
  affected?: number;
  /**
   * What the listed items are, so a report can lead to them.
   *
   * A reader who sees a board named in a finding wants to look at that board, and
   * the way there is a URL - which no check may build (they know no paths). The
   * kind is the piece of knowledge only the check has; the report turns it into a
   * link, or into plain text where it cannot.
   */
  itemKind?: ItemKind;
  /**
   * The search behind a counted number.
   *
   * Findings that count rather than list - stale issues, unassigned issues - state
   * a number and name nothing. The query is the handle: it makes the number
   * checkable, and in the app it leads straight to those issues.
   */
  query?: string;
}

/**
 * What a finding's items are. Accounts are named but never linked to.
 *
 * `field-group` is a set of fields that mean the same thing, listed as one row and
 * decided on as one: a reader who marks "Priority / Prioritaet / Prio" as
 * intentional is deciding about the overlap, not about one of the three. It leads
 * to the same page as a single field, and it is a separate kind because a report
 * has to be able to call it what it is.
 */
export type ItemKind =
  | 'project'
  | 'board'
  | 'field'
  | 'field-group'
  | 'value-list'
  | 'group'
  | 'account';

/**
 * Thrown by a check that cannot be evaluated on this instance - e.g. the
 * empty-field check when no project has enough issues. The engine treats a skip
 * as "did not run": it stays out of the score denominator, exactly like a failed
 * check, but is not an error. A check that ran and simply found nothing returns
 * null instead, because only checks that ran belong in the denominator.
 */
export class CheckSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CheckSkipped';
  }
}

/**
 * Thrown as soon as a stopped scan tries to send its next request.
 *
 * Stopping is a request the administrator makes about their own instance, so it
 * travels as an error rather than as a return value: it has to leave whatever check
 * is running immediately, without every check having to ask whether it may go on.
 * The engine turns it into "did not run" for the checks that were still to come.
 */
export const SCAN_STOPPED_REASON = 'The scan was stopped.';

export class ScanCancelled extends Error {
  constructor() {
    super(SCAN_STOPPED_REASON);
    this.name = 'ScanCancelled';
  }
}

export interface CheckDefinition {
  id: string;
  category: Category;
  title: string;
  /** Relative weight inside its category. */
  weight: number;
  /** Why this is worth attention. Goes into the report verbatim. */
  why: string;
  /**
   * When this finding is legitimate and should be ignored. Mandatory, because a
   * single obvious false positive costs the credibility of every other finding.
   */
  legitimateWhen: string;
  /**
   * What the work consists of: the kind of change, and who has to be involved.
   * Mandatory, and deliberately without a duration.
   *
   * An estimate in person-days would be guessed - the instance, its history and the
   * people are unknown - and a reader who can judge one item precisely would drop
   * the whole report over it. Worse, a number invites doing it alone. What cannot be
   * guessed is the shape of the work: whether a change touches one setting or data
   * across projects, and whom it has to be agreed with. The countable facts stay in
   * the finding's evidence, so a reader can size it himself.
   */
  whatItInvolves: string;
  /**
   * True when this check's drill-down names people rather than configuration
   * objects. The report shows those names - an administrator cannot act on the
   * finding otherwise - but the Markdown export leaves them out, because that file
   * is meant to be forwarded outside the team.
   */
  itemsNamePeople?: boolean;
  run(ctx: ScanContext): Promise<Finding | null>;
}

export interface ScanConfig {
  /** Days without login/activity before a licensed user counts as inactive. */
  inactiveUserDays: number;
  /** Days without update before an unresolved issue counts as stale. */
  staleIssueDays: number;
  /** Days without any issue activity before a project counts as dormant. */
  dormantProjectDays: number;
  /** Share of issues that must be empty for a field to count as unused. */
  emptyFieldThreshold: number;
  /** Minimum issues across a field's projects before judging how often it is filled. */
  minIssuesForFieldCheck: number;
  /** Columns a board may carry before it counts as overgrown. */
  maxBoardColumns: number;
  /** Issues a project needs before it counts as more than a leftover. */
  minProjectIssues: number;
  /** Share of unresolved issues without assignee before the check fires. */
  unassignedThreshold: number;
  /** Days of intake and completion compared against each other. */
  flowWindowDays: number;
}

export const DEFAULT_CONFIG: ScanConfig = {
  inactiveUserDays: 90,
  staleIssueDays: 180,
  dormantProjectDays: 180,
  emptyFieldThreshold: 0.95,
  minIssuesForFieldCheck: 50,
  maxBoardColumns: 7,
  minProjectIssues: 10,
  unassignedThreshold: 0.2,
  flowWindowDays: 90,
};

export interface ScanContext {
  client: YouTrackClient;
  config: ScanConfig;
  /** Injected so tests are deterministic and queries are reproducible. */
  now: Date;
}

// --- Data shapes returned by the client -------------------------------------

export interface Project {
  id: string;
  shortName: string;
  name: string;
  archived: boolean;
  /**
   * Issues in the project, or null when it was not counted.
   *
   * Null means archived: YouTrack search does not accept an archived project as a
   * scope - `project: {KEY}` is a rejected query, not an empty result - so there is
   * no number to have. Every check works on active projects, where there is one.
   */
  issuesCount: number | null;
  leader?: { id: string; login: string; banned: boolean } | null;
}

/** A project with a counted issue total: active, and therefore searchable. */
export type CountedProject = Project & { issuesCount: number };

/**
 * The projects a check can reason about.
 *
 * Archived ones are out of every check by intent - they take no new work - and out
 * of every query by necessity, since search does not accept them as a scope.
 */
export function countedProjects(projects: readonly Project[]): CountedProject[] {
  return projects.filter((p): p is CountedProject => !p.archived && p.issuesCount !== null);
}

export interface CustomFieldInstance {
  id: string;
  projectShortName: string;
  /**
   * The value bundle this project uses for the field, or null if the field type has
   * none. Projects usually get a bundle of their own, so the values of a field can
   * differ from project to project - which is where a state without a resolved value
   * comes from.
   */
  bundleId: string | null;
  /**
   * Whether the project demands a value for the field.
   *
   * The project's own rule, which is what makes an empty value a contradiction
   * rather than a matter of taste: an issue without a value for a field the
   * project requires got there before the rule, through an import, or through the
   * API, and every report that groups by the field carries it as a silent gap.
   */
  required: boolean;
}

export interface CustomField {
  id: string;
  name: string;
  fieldType: string;
  instances: CustomFieldInstance[];
}

export interface User {
  id: string;
  login: string;
  fullName: string;
  banned: boolean;
  /**
   * Registration date in epoch millis. The REST API exposes no last-login time at
   * all, so this is what keeps a fresh account from looking dormant.
   */
  registered: number;
}

export interface BoardColumn {
  presentation: string;
  wipLimitMin?: number | null;
  wipLimitMax?: number | null;
  /**
   * Whether work in this column counts as done, as the instance says.
   *
   * The board's own statement, rather than "the last column": a board may end in
   * more than one of them - Released beside Cancelled - and the last of a list that
   * is not in order is not the end of anything.
   */
  resolved: boolean;
  /** Values of the board's column field that this column collects. */
  fieldValues: string[];
}

export interface AgileBoard {
  id: string;
  name: string;
  /**
   * Whether the board plans in sprints.
   *
   * A sprint board limits work through the sprint it commits to; column WIP limits
   * are a flow-board instrument. Judging both by the same rule reports half the
   * boards in an instance for a setting they are not meant to have.
   */
  usesSprints: boolean;
  /** Field the columns are built from, e.g. `State`. Empty if the board has none. */
  columnField: string;
  /** Short names of the projects on the board, for scoping a query to it. */
  projects: string[];
  /**
   * Names of the board's sprints, for asking which issues it holds.
   *
   * A board is a search field: `Board <name>` carries the sprint an issue sits in.
   * `has:` answers for every real sprint at once, but a card nobody scheduled sits
   * in a sprint of its own that `has:` does not count - so the names are needed
   * beside it. Measured on a live instance: `has:` alone found no card at all on
   * two boards out of four.
   */
  sprints: string[];
  columns: BoardColumn[];
  /** Who the board belongs to, or null where the instance names nobody. */
  owner?: { login: string; banned: boolean } | null;
}

export interface UserGroup {
  id: string;
  name: string;
  usersCount: number;
}

/** One value of a state bundle. `resolved` is what makes an issue count as done. */
export interface StateValue {
  name: string;
  resolved: boolean;
}

export interface StateBundle {
  id: string;
  name: string;
  values: StateValue[];
}

/**
 * A list of values a field offers, as the instance keeps it.
 *
 * YouTrack gives each project a list of its own unless someone picks an existing
 * one, so an instance accumulates copies with the same contents. `values` are the
 * names in it, which is what makes two lists comparable.
 */
export interface ValueBundle {
  id: string;
  name: string;
  values: string[];
}

/**
 * What the instance says about the machine it runs on.
 *
 * `selfHosted` is the one fact the rest depends on: JetBrains documents that
 * telemetry attributes a hosted instance does not support come back empty, and a
 * path on a filesystem is such an attribute. So a path that arrives is proof the
 * instance runs somewhere its administrator owns, and its absence is not proof of
 * anything - which is why the checks built on this only ever switch themselves
 * *on* for a positive answer.
 */
export interface InstanceOperations {
  selfHosted: boolean;
  /** Size of the database in bytes, and as the instance worded it. */
  databaseBytes: number | null;
  databaseText: string | null;
  /** Memory YouTrack may use, in bytes, and as the instance worded it. */
  memoryBytes: number | null;
  memoryText: string | null;
}

/** The instance-wide settings that decide whether it can reach anyone. */
export interface InstanceSettings {
  /** The address the instance puts into the links it sends out. */
  baseUrl: string | null;
  /** Where the instance sends what it has to say about itself. */
  administratorEmail: string | null;
  /** Whether email notifications are switched on at all. */
  mailEnabled: boolean | null;
}

/** What a count came back with: a number, or why the instance refused the query. */
export type CountResult = { readonly count: number } | { readonly failed: string };

/**
 * The counts of a batch, or the first refusal as an error.
 *
 * Most checks cannot do anything sensible with a partial answer: a share of the
 * projects is not a share of the instance. The one check that can - the empty-field
 * check, which reports how many fields no query could reach - reads the results
 * itself instead of calling this.
 */
export function requireCounts(results: readonly CountResult[]): number[] {
  return results.map(result => {
    if ('failed' in result) {
      throw new Error(result.failed);
    }
    return result.count;
  });
}

/**
 * Everything the checks are allowed to ask YouTrack for.
 *
 * Implemented by YouTrackApiClient over a transport (youtrack-api.ts) and by
 * MockYouTrackClient in tests. Checks depend only on this interface, so correcting
 * a REST path never touches the catalog.
 */
export interface YouTrackClient {
  /** Issue count for a YouTrack search query. */
  count(query: string): Promise<number>;
  /**
   * Issue counts for several queries, in the order they were given.
   *
   * A scan of a large instance asks one of these per project, per field and two per
   * board, and waiting for each answer before sending the next is what makes it
   * slow. Handing the whole batch over lets the client decide how many to have in
   * flight - the checks stay free of that decision, and of HTTP.
   */
  countMany(queries: readonly string[]): Promise<CountResult[]>;
  /**
   * When the user last changed anything, in epoch millis, or null if never.
   *
   * Reading is invisible everywhere in the API, but every change is not: creating,
   * commenting, editing a field, attaching a file, logging work, voting. This is
   * the closest thing to a last-seen time the app can obtain.
   */
  lastActivity(userId: string): Promise<number | null>;
  listProjects(): Promise<Project[]>;
  listCustomFields(): Promise<CustomField[]>;
  listUsers(): Promise<User[]>;
  listAgileBoards(): Promise<AgileBoard[]>;
  listGroups(): Promise<UserGroup[]>;
  /** Every state bundle in the instance, with the resolved flag of each value. */
  listStateBundles(): Promise<StateBundle[]>;
  /** Every list of field values in the instance, with the names in it. */
  listValueBundles(): Promise<ValueBundle[]>;
  /**
   * What the instance says about its own operation, or null if it would not say.
   *
   * Null covers both a reader without system-administrator permissions and an
   * instance that has no such resource, because a check can do nothing different
   * with the two: it steps out of the score either way.
   */
  readOperations(): Promise<InstanceOperations | null>;
  /** The instance-wide settings, or null if they cannot be read. */
  readSettings(): Promise<InstanceSettings | null>;
}
