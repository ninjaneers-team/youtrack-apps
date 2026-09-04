/**
 * What the three reports say the same way.
 *
 * The report exists three times over - as the page in the app, as the printed
 * document and as the Markdown file - and deliberately so: each has its own rules
 * about what it may name and how it may look. What they must not hold three times
 * over is the vocabulary. A severity label, the sentence that explains the score,
 * the invitation in the footer: a wording kept in three places is a wording that
 * agrees in two of them.
 *
 * Nothing here knows about HTML, Markdown or React. It knows the words and the
 * arithmetic that has to read the same everywhere.
 */

import type { CheckOutcome, IgnoredItems, ScanResult } from './engine.ts';
import { agePhrase, gapPhrase } from './trend.ts';
import type { CheckChange, Trend } from './trend.ts';
import type { Category, Finding, FindingItem, ItemKind, Severity } from './types.ts';
import {
  CATEGORY_LABEL,
  CATEGORY_WEIGHT,
  agree,
  percent,
  plural,
  pluralNoun,
  SEVERITY_FROM,
  SCAN_STOPPED_REASON,
  SEVERITY_FACTOR,
} from './types.ts';

export { percent };

// --- Numbers ----------------------------------------------------------------

const ONE_DECIMAL = 10;
const PERCENT = 100;
const SCORE_DECIMALS = 1;

/** Three decimals: enough to reproduce a deduction, few enough to read. */
export const RATIO_DECIMALS = 3;

/** Scores and deductions, at the one decimal a report shows them with. */
export function oneDecimal(n: number): number {
  return Math.round(n * ONE_DECIMAL) / ONE_DECIMAL;
}

/**
 * A score as it is shown: always one decimal.
 *
 * "Licences 9" beside "Kept 67.9" reads as two kinds of number rather than as two
 * shares of the same hundred, and a column of scores only lines up if every one of
 * them has the same shape. Deductions keep their natural form - "3 of 10 points
 * lost" is a sentence, not a column.
 */
export function scoreText(n: number): string {
  return n.toFixed(SCORE_DECIMALS);
}

// --- Vocabulary -------------------------------------------------------------

/**
 * When a scan happened, as all three reports state it.
 *
 * Locale-free on purpose. `toLocaleString()` follows the machine the report is read
 * on, so one administrator read "3.9.2026" and the next "9/3/2026" inside an
 * interface that is English throughout - and no test can see that, because the
 * machine running the test has a locale too. UTC because an app cannot know which
 * zone an instance calls its own, and a time that says which zone it is in beats one
 * the reader has to guess about.
 */
export function dateText(at: Date): string {
  return at.toISOString().slice(0, DATE_END);
}

export function timeText(at: Date): string {
  return `${at.toISOString().slice(DATE_END + 1, MINUTE_END)} UTC`;
}

/** Both of them, for a line of prose rather than two cells. */
export function timestampText(at: Date): string {
  return `${dateText(at)}, ${timeText(at)}`;
}

const DATE_END = 10;
const MINUTE_END = 16;


/**
 * What a check's objects are called, in the words of someone who has not read the
 * code: "Affected projects (35)" says what will be in the list, where "Affected
 * objects (35)" makes the reader open it to find out.
 */
export const ITEM_NOUN: Record<ItemKind, string> = {
  project: 'project',
  board: 'board',
  field: 'field',
  'field-group': 'group of fields',
  group: 'user group',
  account: 'account',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * The share a check measured, or that it did not measure one.
 *
 * A check that did not run has no share, and "0 %" would read as a check that
 * found nothing - the opposite statement.
 */
function shareText(ratio: number | null): string {
  return ratio === null ? 'not measured' : `${percent(ratio)} %`;
}

/**
 * What moved about one check, in the words all three reports use.
 *
 * Each report frames it differently - a line in a list, a table cell, a sentence -
 * but the numbers behind it are one statement, and three copies of it were three
 * wordings waiting to disagree.
 */
export function movementDetail(change: CheckChange): string {
  if (change.kind === 'new') {
    return `${shareText(change.after)} affected`;
  }
  if (change.kind === 'resolved') {
    return `was ${shareText(change.before)}`;
  }
  return `${shareText(change.before)} -> ${shareText(change.after)}`;
}

/** How a check's movement since the previous scan is named. */
export const MOVEMENT_LABEL: Record<CheckChange['kind'], string> = {
  new: 'new',
  resolved: 'resolved',
  better: 'improved',
  worse: 'worse',
  unchanged: 'unchanged',
};

/**
 * Who to talk to about the report.
 *
 * It travels with the exported document, because the document is forwarded to
 * people who never saw the app, and the app never phones home.
 */
export const VENDOR = {
  name: 'Ninjaneers GmbH',
  url: 'https://ninjaneers.de',
  email: 'info@ninjaneers.de',
  invitation: 'Happy to walk through this report together',
} as const;

/**
 * How many affected objects an exported report lists before it says how many are
 * left.
 *
 * A display limit, not a measuring one: a finding carries every object it found, so
 * the count next to the list is the real one. Cutting the list inside the check
 * would have made "Affected objects (25)" true of the list and false of the
 * instance. The page in the app lists all of them and scrolls, because there a name
 * is a link and a name left out is a way left out.
 */
export const ITEMS_SHOWN = 25;

// --- The sentences ----------------------------------------------------------

/**
 * What severity means, with the thresholds in it.
 *
 * "It orders the findings" without saying by what leaves the reader to guess, and
 * the bands are three numbers - cheap to state, and read off the constant so the
 * sentence cannot drift from the code that sorts by it.
 */
export const SEVERITY_NOTE = (() => {
  const bands = (['critical', 'high', 'medium'] as const)
    .map(level => `${SEVERITY_LABEL[level].toLowerCase()} from ${percent(SEVERITY_FROM[level])} %`)
    .join(', ');
  return (
    `Severity is the share a check measured: ${bands}, low below that. It sorts ` +
    'the findings, strongest first, and colours them. It is not part of the score.'
  );
})();

export const NO_MEASUREMENT_HEADING = 'Checks without a measurement';

/**
 * Three ways to end up here, and the note names all three.
 *
 * "Each of these ran" was true of two of them and read as a contradiction above the
 * third: a stopped scan lists every check it never got to, and each of those rows
 * says so in as many words.
 */
export const NO_MEASUREMENT_NOTE =
  'Each of these came back without a number: there was nothing in this instance ' +
  'for it to measure, it hit an error, or the scan was stopped before it got ' +
  'there. They stay out of the score entirely, so they neither help nor hurt it.';

/** Said in every export, because a partial score reads like a whole one. */
export const STOPPED_NOTE =
  'This scan was stopped before it had read the whole instance. The score below ' +
  'covers the checks that ran; the ones it did not reach are listed at the end.';

/**
 * What became of a scan: whether the app kept it, and if not, why.
 *
 * The two ways of not keeping one differ in what a reader may expect on the next
 * visit, so the page says which it was. `partial` is a scan that was stopped: a
 * part of an instance has no score that belongs beside the scores of whole ones,
 * so it stays off the trend - and it is not kept as the last run either.
 */
export type ScanFate = 'kept' | 'stateUnreadable' | 'partial';

/** What the report says about the fate of the scan it is showing. */
export function scanFateNote(fate: ScanFate, restored: boolean): string {
  switch (fate) {
    case 'stateUnreadable':
      return (
        " It was not recorded: the app's stored state could not be read when this " +
        'page opened, so this score stays off the trend. Reloading usually settles it.'
      );
    case 'partial':
      /* That a stopped scan stays off the trend is said where the scan is stopped.
         What nothing else says is that it is not kept as the last run either, so
         the next visit shows the scan before it. */
      return (
        ' It is not kept as the last run either, so opening this page again shows ' +
        'the last whole scan rather than this one.'
      );
    case 'kept':
      return restored
        ? ' This is that scan, kept as it was.'
        : ' It is kept, so opening this page again shows it without a new scan.';
  }
}

/**
 * Which way the score moved, in points.
 *
 * Measured against measured: a score that rose because findings were marked as
 * intentional says nothing about the instance, and this sentence is about the
 * instance.
 */
export function movementPhrase(delta: number): string {
  if (oneDecimal(delta) === 0) {
    return 'unchanged';
  }
  return delta > 0
    ? `up ${plural(oneDecimal(delta), 'point')}`
    : `down ${plural(oneDecimal(-delta), 'point')}`;
}

/**
 * The trend as one sentence, for the page and for the printed document.
 *
 * A number without its direction is worth little in a budget conversation, which
 * is why the printed report carries this line too rather than the figure alone.
 */
export function trendSentence(trend: Trend, age: number): string {
  if (trend.measuredDelta === null) {
    return `One scan so far, ${agePhrase(age)}. A second one puts it in context.`;
  }
  const movement = movementPhrase(trend.measuredDelta);
  /* How many scans the line is made of is the line's own business: the chart draws
     one point per scan and its axis carries the dates. As a number in the sentence
     it read as a measurement of the instance, which it is not - it is how many
     scans this app has kept. */
  const where = `against the scan ${gapPhrase(trend.daysBetween ?? 0)}`;
  return trend.decided
    ? `Without the marks, ${movement} ${where}.`
    : `${movement[0]?.toUpperCase() ?? ''}${movement.slice(1)} ${where}.`;
}

/**
 * Minutes and seconds, because a scan of a large instance is measured in both.
 */
export function duration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
  const rest = whole % SECONDS_PER_MINUTE;
  return minutes === 0
    ? `${rest} s`
    : `${minutes}:${String(rest).padStart(SECONDS_DIGITS, '0')}`;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_DIGITS = 2;

export const SCORE_METHOD =
  'The score is a hundred points. They are divided between the categories, and ' +
  'inside a category between the checks that ran, by weight. Every check reports ' +
  'how much of what it measured is affected, between 0 and 1, and gives up that ' +
  'share of its own points. What no finding took away is the score.';

/**
 * How the hundred points are divided, read off the weights themselves.
 *
 * In points rather than in weights: a reader who is told "licences 3" has to work
 * out what three means, and every figure elsewhere in the report is a slice of the
 * hundred. Written out by hand, this sentence sat in four places and had drifted
 * from the code in one of them.
 */
export const CATEGORY_WEIGHTS_NOTE = (() => {
  const categories = Object.keys(CATEGORY_WEIGHT) as Category[];
  const total = categories.reduce((sum, c) => sum + CATEGORY_WEIGHT[c], 0);
  const shares = categories
    .map(c => `${CATEGORY_LABEL[c].toLowerCase()} ${(CATEGORY_WEIGHT[c] / total) * PERCENT}`)
    .join(', ');
  return (
    `Of the hundred: ${shares}. A category that could not be measured at all ` +
    'leaves its points to the others rather than counting as zero.'
  );
})();

/**
 * Why the shares are what they are.
 *
 * Without it the numbers look chosen at random, and a reader who cannot see the
 * reasoning supplies his own - usually a worse one. It ends by saying that the
 * weighting is a judgement: a report that pretends otherwise loses the argument the
 * moment someone disagrees with one number, whereas one that shows every step
 * survives the disagreement.
 */
export const WEIGHT_REASON =
  'Why these shares: an unused licence costs money every month, so licences weigh ' +
  'most. Fields, process and governance weigh the same - each of them decides ' +
  'whether the work in this instance can be found, trusted and owned. The ' +
  'portfolio weighs least, because a forgotten project costs attention rather than ' +
  'money. Inside a category the same idea sets the shares: a check weighs more the ' +
  'more it costs to leave alone. The numbers are a judgement, not a law - and every ' +
  'step from a measurement to a point is in this report, so a reader who would ' +
  'weigh it differently can still follow how this score came about.';

/** The whole method as one paragraph, for a document that has no room to unfold. */
export const METHOD_NOTE = `${SCORE_METHOD} ${CATEGORY_WEIGHTS_NOTE}`;

/**
 * Why a check produced no measurement, as one phrase.
 *
 * "Skipped" is the engine's word for it and the wrong one in a report: the check did
 * run, it just found nothing in this instance it could measure - no board with a
 * column in between, no field in a project with enough issues. The reason names what
 * was missing and stands on its own; an error and a stopped scan need saying.
 */
export function noMeasurementPhrase(status: string, reason?: string): string {
  if (reason === SCAN_STOPPED_REASON) {
    return 'not reached, the scan was stopped';
  }
  if (status === 'failed') {
    return reason ? `the check hit an error: ${reason}` : 'the check hit an error';
  }
  return reason ?? 'nothing in this instance to measure';
}

// --- What a decision did to the score ----------------------------------------

export interface DecisionEffect {
  /** How many whole findings are marked as intentional. */
  findings: number;
  /** How many single objects are, counting only those this scan still found. */
  items: number;
  /** What they are worth in the overall score, at the decimal a report shows. */
  points: number;
  /**
   * The score as the report shows it, and the one without the decisions.
   *
   * Both at the decimal they are printed with, and `reported` taken from the score
   * itself rather than added up from the other two: 67.8 + 0.1 rounds to 67.9 while
   * the card says 68.0, and a sentence that contradicts the figure above it is
   * worse than no sentence.
   */
  reported: number;
  asMeasured: number;
}

/**
 * What the marked findings are worth, or null while nothing is marked.
 *
 * Marking a finding raises the score, and nothing in the instance changed for it.
 * Reopening the report later shows only the raised number, which reads as an
 * improvement nobody made - so every report states the difference next to the score.
 */
export function decisionEffect(
  result: ScanResult,
  markedItems: IgnoredItems = new Map(),
): DecisionEffect | null {
  const { overallScore, overallAsMeasured } = result;
  if (overallScore === null || overallAsMeasured === null) {
    return null;
  }
  const points = oneDecimal(overallScore - overallAsMeasured);
  if (points === 0) {
    return null;
  }
  return {
    findings: result.ignoredFindings.length,
    items: markedCount(result, markedItems),
    points,
    reported: oneDecimal(overallScore),
    asMeasured: oneDecimal(overallAsMeasured),
  };
}

/**
 * How many marked objects this scan actually found.
 *
 * A mark on a project that has since been archived is not counted, for the same
 * reason it does not change the score: it applies to nothing right now.
 */
function markedCount(result: ScanResult, markedItems: IgnoredItems): number {
  let found = 0;
  for (const outcome of result.outcomes) {
    const marks = markedItems.get(outcome.checkId);
    if (!marks || !outcome.finding?.items) {
      continue;
    }
    found += outcome.finding.items.filter(item => marks.has(item.id)).length;
  }
  return found;
}

/** The same sentence in the app, in the printed document and in the file. */
export function decisionSentence(effect: DecisionEffect): string {
  const what: string[] = [];
  if (effect.findings > 0) {
    what.push(plural(effect.findings, 'finding'));
  }
  if (effect.items > 0) {
    what.push(plural(effect.items, 'object'));
  }
  const subject = what.length > 0 ? what.join(' and ') : 'Some of this';
  const verb = agree(effect.findings + effect.items, 'is', 'are');
  const points = pluralNoun(effect.points, 'point');
  /* Both numbers in one sentence, because neither explains itself as a figure. A
     line reading "as measured 67.8" beside the score was shorter and meant nothing
     to anyone who did not already know the concept. */
  return (
    `${subject} ${verb} marked as intentional, so ${effect.points} of those ` +
    `${effect.reported} ${points} rest on that decision rather than on a ` +
    `measurement. Measured, this scan is ${effect.asMeasured} out of 100. Nothing ` +
    'in the instance was measured again for it.'
  );
}

// --- What the score is made of -----------------------------------------------

export interface ScoreSegment {
  category: Category;
  /** Points of the overall score this category took away. */
  points: number;
}

/**
 * What a part of the report is worth of the hundred, and what it took away.
 *
 * One unit for every score figure. Before this, a report stated four: the overall
 * score out of a hundred, a category out of a hundred of its own, a check out of the
 * points it happens to weigh inside its category, and a movement as a percentage of
 * those. Four scales for one number, and a reader who tried to add them up got
 * nowhere - which is the opposite of a score you can recompute by hand.
 *
 * Now everything is a slice of the same hundred, and the slices add up: the losses
 * of the checks in a category are its loss, the losses of the categories are
 * `100 - score`, and the bar is the picture of exactly that.
 */
export interface HundredPoints {
  /** What it is worth of the hundred. */
  worth: number;
  /** How much of that is gone. */
  lost: number;
}

/** The weight of the categories that scored; the divisor for every share below. */
function scoredWeight(result: ScanResult): number {
  return result.categories
    .filter(c => c.score !== null)
    .reduce((sum, c) => sum + CATEGORY_WEIGHT[c.category], 0);
}

/**
 * A category's slice of the hundred.
 *
 * A category that ran nothing has no slice, and the others grow to fill the
 * hundred - the same normalisation the overall score does, and the reason a
 * category's worth is not simply its weight times ten.
 */
export function categoryPoints(
  result: ScanResult,
  category: Category,
): HundredPoints | null {
  const scored = result.categories.find(c => c.category === category);
  const weightSum = scoredWeight(result);
  if (!scored || scored.score === null || weightSum === 0) {
    return null;
  }
  const worth = (CATEGORY_WEIGHT[category] / weightSum) * PERCENT;
  return { worth, lost: worth * ((PERCENT - scored.score) / PERCENT) };
}

/**
 * One check's slice of the hundred, and what its finding took away of it.
 *
 * The check's share inside its category is its weight against the weight of the
 * checks that ran there - so a check is worth more when its neighbours were skipped,
 * exactly as the score treats it.
 */
export function checkPoints(
  result: ScanResult,
  category: Category,
  weight: number,
  ratio: number,
): HundredPoints | null {
  const scored = result.categories.find(c => c.category === category);
  const ofCategory = categoryPoints(result, category);
  if (!scored || !ofCategory || scored.ranWeight === 0) {
    return null;
  }
  const worth = ofCategory.worth * (weight / scored.ranWeight);
  return { worth, lost: worth * ratio };
}

/** How much fainter each following loss is drawn, so their order stays readable. */
const FADE_STEP = 0.15;
const FADE_FLOOR = 0.4;

/** One part of the score bar: how wide, what it is called, how strongly drawn. */
export interface ScoreBarPart {
  key: string;
  label: string;
  points: number;
  kind: 'kept' | 'decisions' | 'loss';
  opacity: number;
}

/**
 * The score bar as parts, for whoever draws it.
 *
 * The page and the printed document draw the same bar with different means - CSS
 * variables against fixed colours on paper - but the order of the parts, their
 * names and the fading are the same picture, and a picture that is assembled twice
 * is two pictures a release apart.
 */
export function scoreBarParts(composition: ScoreComposition): ScoreBarPart[] {
  const kept: ScoreBarPart = {
    key: 'kept',
    label: 'Kept',
    points: composition.kept,
    kind: 'kept',
    opacity: 1,
  };
  const decisions: ScoreBarPart[] =
    composition.decisions > 0
      ? [
          {
            key: 'decisions',
            label: 'Marked as intentional',
            points: composition.decisions,
            kind: 'decisions',
            opacity: 1,
          },
        ]
      : [];
  const losses = composition.losses.map((loss, index) => ({
    key: loss.category,
    label: CATEGORY_LABEL[loss.category],
    points: loss.points,
    kind: 'loss' as const,
    // Largest first at full strength, each following one a step fainter.
    opacity: Math.max(FADE_FLOOR, 1 - index * FADE_STEP),
  }));
  return [kept, ...decisions, ...losses];
}

export interface ScoreComposition {
  /** The measured score: what is left after every category took its points. */
  kept: number;
  /** Points handed back because findings are marked as intentional. */
  decisions: number;
  /** One per scored category, strongest loss first. */
  losses: ScoreSegment[];
}

/**
 * The score split into what it is made of, in points of the same hundred.
 *
 * A single number says nothing about where it came from, and a table of category
 * scores hides the size of each: a category worth 3 that lost half its points costs
 * more of the overall score than one worth 1 that lost all of them. Splitting it
 * makes the weights visible without explaining them.
 *
 * The parts add up to a hundred: what is kept, what decisions handed back, and what
 * each category took away. Null when not a single check ran.
 */
export function scoreComposition(result: ScanResult): ScoreComposition | null {
  const scored = result.categories.filter(c => c.score !== null);
  const weightSum = scored.reduce((sum, c) => sum + CATEGORY_WEIGHT[c.category], 0);
  if (weightSum === 0 || result.overallScore === null) {
    return null;
  }
  const losses = scored
    .map(c => ({
      category: c.category,
      points: categoryPoints(result, c.category)?.lost ?? 0,
    }))
    .filter(segment => segment.points > 0)
    .sort((a, b) => b.points - a.points);
  const decisions = result.overallAsMeasured === null
    ? 0
    : result.overallScore - result.overallAsMeasured;
  return { kept: result.overallScore - decisions, decisions, losses };
}

// --- Where a finding leads ---------------------------------------------------

/**
 * The URL shapes YouTrack's own interface uses.
 *
 * Read off a running instance rather than guessed: a project is `/projects/<key>`
 * with its settings under `/projects/<key>/settings?tab=<people|fields>`, a board is
 * `/agiles/<id>`, a group is `/admin/groups/<id>` with the same id the API returns,
 * custom fields all live on one page, and a search is `/issues?q=<query>`. A check
 * never sees any of this - it says what kind of thing it listed, and the answer to
 * "where do I look" is built here.
 *
 * Every function takes the instance origin and returns null without one. In the app
 * the origin comes from the document's own base; a report rendered outside an
 * instance simply has no links.
 */

/**
 * The page that lists every custom field.
 *
 * There is no address for a single field - the interface keeps the selection out of
 * the URL, checked on a running instance - so a field leads to the list it is in.
 * The tab is the flat list of fields rather than the per-project view, since that is
 * where a name is compared with the others and changed.
 *
 * `fields-list-vew` is spelled the way YouTrack spells it, typo included: it is the
 * value its own interface puts in the URL, read off a running instance, not a guess.
 * Should a later version correct it, this link lands on the neighbouring tab of the
 * same page rather than nowhere - worth re-reading when the minimum version rises.
 */
const FIELDS_PAGE = '/admin/customFieldsConfiguration?tab=fields-list-vew';
/**
 * A name or a query as part of an address.
 *
 * `encodeURIComponent` throws on half a character - a surrogate whose other half is
 * missing, which JSON can carry and an import through the API can therefore put in
 * a name. Thrown while a link is being built, it would take the whole report down
 * over one name, so the halves are dropped and the rest of the name still leads
 * somewhere.
 */
function encodePart(value: string): string {
  let whole = '';
  // Iterating a string walks code points, so a pair arrives as one character and
  // a half arrives on its own, in the range no character of its own can be in.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0xd800 || code > 0xdfff) {
      whole += character;
    }
  }
  return encodeURIComponent(whole);
}

export function issueSearchUrl(origin: string | null, query: string): string | null {
  return origin === null ? null : `${origin}/issues?q=${encodePart(query)}`;
}

/**
 * Findings that are acted on in a project's settings rather than in the project.
 *
 * A map rather than an object literal: the key is looked up, and a plain object
 * answers for keys nobody put in it - `toString` would come back as a function and
 * end up in the address as one.
 */
const PROJECT_TAB = new Map<string, string>([
  ['governance.projects-without-leader', 'people'],
  ['fields.state-without-resolved', 'fields'],
]);

export function itemUrl(
  origin: string | null,
  kind: ItemKind | undefined,
  item: FindingItem,
  checkId: string,
): string | null {
  if (origin === null || kind === undefined) {
    return null;
  }
  switch (kind) {
    case 'project': {
      const key = item.target ?? item.label;
      /* Each of these is settled on a different page: an owner under People, a state
         that never resolves under the project's own fields. Everything else about a
         project is judged by looking at the project itself. */
      const tab = PROJECT_TAB.get(checkId);
      return tab === undefined
        ? `${origin}/projects/${encodePart(key)}`
        : `${origin}/projects/${encodePart(key)}/settings?tab=${tab}`;
    }
    case 'board':
      return `${origin}/agiles/${encodePart(item.target ?? item.id)}`;
    case 'field':
    // A group of fields is compared and renamed on the same page as a single one.
    case 'field-group':
      return `${origin}${FIELDS_PAGE}`;
    case 'group':
      return `${origin}/admin/groups/${encodePart(item.target ?? item.id)}`;
    case 'account':
      /* An account is named in the app and counted in an export, and neither links
         to a person. */
      return null;
    default:
      return null;
  }
}

// --- Selection --------------------------------------------------------------

/** Severity weight * ratio. Ordering only, never part of the score. */
function impact(finding: Finding): number {
  return SEVERITY_FACTOR[finding.severity] * finding.ratio;
}

/** Findings strongest first, the order every report shows them in. */
export function byImpact(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => impact(b) - impact(a));
}

/** The checks that came back without a number, in the order they ran. */
export function withoutMeasurement(outcomes: readonly CheckOutcome[]): CheckOutcome[] {
  return outcomes.filter(o => o.status === 'skipped' || o.status === 'failed');
}
