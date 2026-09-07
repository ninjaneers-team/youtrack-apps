import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Alert from '@jetbrains/ring-ui-built/components/alert/alert';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import Icon from '@jetbrains/ring-ui-built/components/icon/icon';
/* JetBrains' own glyph set, the one ring-ui draws with. Each import is a module
   holding an SVG string of a few hundred bytes, so only what is used travels. */
import exportGlyph from '@jetbrains/icons/export';
import fileTextGlyph from '@jetbrains/icons/file-text';
import newWindowGlyph from '@jetbrains/icons/new-window';
import printerGlyph from '@jetbrains/icons/printer';
import Loader from '@jetbrains/ring-ui-built/components/loader/loader';
import ProgressBar from '@jetbrains/ring-ui-built/components/progress-bar/progress-bar';

import {effectiveRatio, score} from '../../engine.ts';
import type {
  CategoryScore,
  CheckOutcome,
  IgnoredItems,
  ScanProgressState,
  ScanResult
} from '../../engine.ts';
import {CHECKS} from '../../checks/catalog.ts';
import {CATEGORY_LABEL, DEFAULT_CONFIG, plural, pluralNoun, SEVERITY_FROM} from '../../types.ts';
import {
  byImpact,
  categoryPoints,
  ITEM_NOUN,
  checkPoints,
  CATEGORY_WEIGHTS_NOTE,
  issueSearchUrl,
  itemUrl,
  MOVEMENT_LABEL,
  movementDetail,
  andList,
  instanceOrigin,
  shareText,
  noMeasurementGroups,
  noMeasurementPhrase,
  NO_MEASUREMENT_HEADING,
  NO_MEASUREMENT_NOTE,
  oneDecimal,
  percent,
  RATIO_DECIMALS,
  SCORE_METHOD,
  duration,
  decisionEffect,
  decisionSentence,
  trendSentence,
  scanFateNote,
  WEIGHT_REASON,
  scoreText,
  SEVERITY_LABEL,
  timestampText,
  withoutMeasurement
} from '../../report-shared.ts';
import type {HundredPoints, ScanFate} from '../../report-shared.ts';
import type {
  Category,
  CheckDefinition,
  Finding,
  FindingItem,
  Severity
} from '../../types.ts';

import {createHostClient} from '../../host-client.ts';
import {startScan as startSession, uploadOf} from '../../scan-session.ts';
import type {ScanCost, ScanHandle} from '../../scan-session.ts';
import {createAppStateClient, itemsByCheck} from '../../app-state.ts';
import type {IgnoredState, ScanAggregate} from '../../app-state.ts';
import {outcomesFromRun} from '../../stored-run.ts';
import type {StoredRun} from '../../stored-run.ts';
import {
  agePhrase,
  agoPhrase,
  daysSince,
  compareScans,
  scoreBeforeDecisions,
  scanUnderWay,
  sparkline,
  trendFrom
} from '../../trend.ts';
import type {CheckChange, Trend} from '../../trend.ts';

// Register the widget with YouTrack. The Host API runs REST calls with the
// permissions of the user viewing the widget - no token, no base URL.
const host = await YTApp.register();
const appState = createAppStateClient(host);

const CHECK_BY_ID = new Map<string, CheckDefinition>(CHECKS.map(c => [c.id, c]));

const MS_PER_SECOND = 1000;

/** Sparkline box in CSS pixels. Small enough to sit next to the score. */
const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 56;

/**
 * Hands over the report as a file.
 *
 * YouTrack sandboxes the widget iframe without allow-same-origin, which gives it an
 * opaque origin and makes the clipboard API reject. allow-downloads is set, so a
 * file works.
 */
function downloadMarkdown(markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], {type: 'text/markdown'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'instance-insights.md';
  // In the document, because a detached anchor is not guaranteed to start a
  // download in every engine.
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Waits for the code that renders an export, and says so if it never arrives.
 *
 * The two renderers are fetched when a reader asks for one, not when the page
 * loads: together they are 17 kB that a report is read without, and the dashboard
 * tile never exports at all. What that buys costs one failure mode - the request
 * for them can fail where a bundled module could not - so it is named rather than
 * left as a menu item that does nothing.
 */
async function renderer<T>(loading: Promise<T>): Promise<T | null> {
  try {
    return await loading;
  } catch {
    host.alert(
      'The part of the app that builds the export did not load. Reloading this ' +
        'page usually helps; the report itself is unaffected.'
    );
    return null;
  }
}

/**
 * Hands the report to the browser's print dialog.
 *
 * The widget iframe is sandboxed without allow-modals, so window.print() from it is
 * discarded. allow-popups and allow-popups-to-escape-sandbox are set, though, so a
 * popup is not sandboxed and can print.
 *
 * The document it receives is rendered from the result, not copied from this page:
 * the print window resolves no relative stylesheet of ours, and the controls of an
 * interactive report have no meaning on paper.
 */
function printReport(html: string): void {
  const win = window.open('', '_blank');
  if (!win) {
    // A blocked popup must not leave the button doing nothing, so it names the way
    // that always works: the browser's own print command on this page.
    host.alert(
      'The browser blocked the print window. Printing this page directly ' +
        '(Cmd-P or Ctrl-P) produces the same report - it is laid out for print.'
    );
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

/**
 * The marks with one check, or one object of a check, marked or unmarked.
 *
 * Written as a change to what is there rather than as a new value built from what
 * was read: a click is answered at once and confirmed by the handler afterwards, so
 * two of them can be in flight, and each has to end up applying only itself.
 */
function withCheck(
  marks: ReadonlySet<string>,
  checkId: string,
  marked: boolean
): ReadonlySet<string> {
  const next = new Set(marks);
  if (marked) {
    next.add(checkId);
  } else {
    next.delete(checkId);
  }
  return next;
}

function withItem(
  marks: IgnoredItems,
  checkId: string,
  item: string,
  marked: boolean
): IgnoredItems {
  const next = new Map(marks);
  const forCheck = new Set(next.get(checkId) ?? []);
  if (marked) {
    forCheck.add(item);
  } else {
    forCheck.delete(item);
  }
  next.set(checkId, forCheck);
  return next;
}

/** A finished scan, whether it just ran or was read back from storage. */
interface ScanDone {
  phase: 'done';
  outcomes: CheckOutcome[];
  at: Date;
  stopped: boolean;
  cost: ScanCost;
  /**
   * True for the run the app kept, as opposed to one that just ran.
   *
   * The report is the same either way; what differs is what it may claim. A kept
   * run describes the instance as it was at its timestamp, its accounts were not
   * kept with it, and the way to a current answer is another scan.
   */
  restored: boolean;
  /** True when the run was too large to keep the objects it named. */
  itemsOmitted: boolean;
  /**
   * Whether this scan was written to the app's storage, and if not, why.
   *
   * Two scans are not written. One whose decisions were unknown, because the
   * storage could not be read when the page opened: a score computed without them
   * would have replaced the one that has them. And a stopped one, which measured
   * part of the instance - it belongs neither on the trend nor in the place the
   * next visit reads its report from.
   */
  fate: ScanFate;
}

/**
 * Whether the app's own storage answered when the page opened.
 *
 * It holds the standing decisions and the trend, so a scan started without it is
 * still worth running and must not be recorded. See the state below.
 */
type StateRead = 'pending' | 'read' | 'failed';

/**
 * The kept run as a finished scan, or null when there is none to render.
 *
 * A run whose checks the installed app no longer knows scores nothing, and a page
 * showing a score of nothing would be worse than the invitation to scan.
 */
function restoredScan(run: StoredRun | null): ScanDone | null {
  if (run === null) {
    return null;
  }
  const outcomes = outcomesFromRun(run, CHECKS);
  if (outcomes.length === 0) {
    return null;
  }
  return {
    phase: 'done',
    outcomes,
    at: new Date(run.at),
    stopped: false,
    cost: {requests: run.requests, seconds: run.seconds, throttled: run.throttled},
    restored: true,
    itemsOmitted: run.itemsOmitted === true,
    fate: 'kept'
  };
}

type ScanState =
  | {phase: 'idle'}
  | {
      phase: 'running';
      progress: ScanProgressState;
      sent: number;
      startedAt: number;
      throttled: number;
    }
  | ScanDone
  | {phase: 'error'; message: string};

const Evidence: React.FunctionComponent<{finding: Finding}> = ({finding}) => {
  if (finding.evidence.length === 0) {
    return null;
  }
  return (
    <ul className="finding__evidence">
      {finding.evidence.map(e => (
        <li key={e.label}>
          {`${e.label}: `}
          <strong>{e.value}</strong>
        </li>
      ))}
    </ul>
  );
};

/**
 * One affected object: what it is, the way to it, and whether it is deliberate.
 *
 * A row of a table rather than a list item with a button of its own. A finding can
 * name hundreds of objects, and a framed control repeated three hundred times reads
 * as a wall; a checkbox column under one heading reads as a choice. Marking is
 * offered where a finding counts the things it also lists - three of five nearly
 * empty projects can be deliberate while the other two are not. Where the objects
 * are accounts, or where the finding counts without listing, the whole check is the
 * only unit there is, and then the column is absent.
 */
const AffectedItem: React.FunctionComponent<{
  finding: Finding;
  item: FindingItem;
  origin: string | null;
  marked: boolean;
  onToggleItem: ItemToggle | null;
}> = ({finding, item, origin, marked, onToggleItem}) => {
  const href = itemUrl(origin, finding.itemKind, item, finding.checkId);
  const toggle = useCallback(
    () => onToggleItem?.(finding.checkId, item.id, !marked),
    [finding.checkId, item.id, marked, onToggleItem]
  );
  return (
    <tr className={marked ? 'finding__item finding__item--marked' : 'finding__item'}>
      {onToggleItem === null ? null : (
        <td className="finding__item-mark">
          <Checkbox
            checked={marked}
            onChange={toggle}
            aria-label={`Mark ${item.label} as intentional`}
          />
        </td>
      )}
      <td className="finding__item-name">
        {href === null ? (
          item.label
        ) : (
          /* A new tab, because the report is the scan: navigating away in place
             loses it and the next look costs another scan. */
          <a className="jump" href={href} target="_blank" rel="noreferrer">
            {item.label}
          </a>
        )}
      </td>
      <td className="finding__item-detail">{item.detail ?? ''}</td>
    </tr>
  );
};

const AffectedItems: React.FunctionComponent<{
  finding: Finding;
  origin: string | null;
  marked: ReadonlySet<string>;
  onToggleItem: ((checkId: string, item: string, ignored: boolean) => void) | null;
  /**
   * What to say under the table, where a control is missing.
   *
   * Inside this row rather than beside it: the sentence explains why the table has
   * no column to tick, and a plain line between two disclosures broke the one
   * rhythm a card has.
   */
  note: React.ReactNode;
}> = ({finding, origin, marked, onToggleItem, note}) => {
  const items = finding.items ?? [];
  if (items.length === 0) {
    return null;
  }
  const markedHere = items.filter(item => marked.has(item.id)).length;
  /* The kind of thing the check found, so the closed row already says what opening
     it will show. "Objects" is a word from the code, not from the instance. */
  const noun = finding.itemKind === undefined ? 'object' : ITEM_NOUN[finding.itemKind];
  /* Whether the names in this table are links at all. Two kinds are not: an account,
     which is a person, and anything the check found that has no page of its own. The
     hint below said "opens in a new tab" for those as well, because it only asked
     whether the report can build links in this instance - not whether these rows
     carry one. */
  const linked = items.some(
    item => itemUrl(origin, finding.itemKind, item, finding.checkId) !== null,
  );
  return (
    <details className="finding__items">
      <summary>
        {`Affected ${pluralNoun(items.length, noun)} (${items.length})` +
          (markedHere > 0 ? ` - ${markedHere} marked as intentional` : '')}
      </summary>
      {/* Every object, not the first few. The table is behind a click and scrolls,
          and a name that is a way there is only useful if it is actually in the
          list - the exports still cut theirs, since a document has no scrollbar. */}
      <table className="finding__table">
        <thead>
          <tr>
            {onToggleItem === null ? null : <th scope="col">{'Intentional'}</th>}
            <th scope="col">
              {noun}
              {/* Said once for the whole column instead of on every row: the names
                  below are links, and they open a tab of their own. */}
              {linked ? (
                <span className="finding__table-hint">
                  <Icon glyph={newWindowGlyph}/>
                  {' opens in a new tab'}
                </span>
              ) : null}
            </th>
            <th scope="col">{'What was measured'}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(it => (
            <AffectedItem
              key={it.id}
              finding={finding}
              item={it}
              origin={origin}
              marked={marked.has(it.id)}
              onToggleItem={onToggleItem}
            />
          ))}
        </tbody>
      </table>
      {note}
    </details>
  );
};

/**
 * The search a counted finding stands on.
 *
 * "989 open issues have not been updated" names nothing to act on. The query makes
 * the number checkable - a reader can paste it and see the same number - and inside
 * an instance it is the way to those issues.
 */
const FindingQuery: React.FunctionComponent<{
  finding: Finding;
  origin: string | null;
}> = ({finding, origin}) => {
  const {query} = finding;
  if (query === undefined) {
    return null;
  }
  const href = issueSearchUrl(origin, query);
  /* One row, in the same place and of the same kind as "Affected objects" on a
     finding that lists them - a check either lists objects or counts issues, never
     both. Before this, the way to the issues was a link sitting between two
     disclosures: four blue lines of two different sorts, and the reader had to work
     out which was which. */
  return (
    <details className="finding__found">
      <summary>{'The issues behind this number'}</summary>
      {href === null ? null : (
        <p className="finding__query">
          <a className="jump" href={href} target="_blank" rel="noreferrer">
            {'Open these issues in YouTrack'}
            {/* The link opens a tab of its own, which was invisible before. This is
                the glyph YouTrack uses for exactly that. */}
            <Icon glyph={newWindowGlyph} className="jump__new-window"/>
          </a>
        </p>
      )}
      {/* The syntax makes the number checkable by hand, and a consultant pastes it.
          It is the evidence, not the instruction, so it comes second. */}
      <p className="finding__search">
        <code>{query}</code>
      </p>
    </details>
  );
};

/** The consulting part of a finding: why it matters, when it is fine, what it takes. */
/**
 * The reasoning behind a finding, one click away.
 *
 * Eleven cards, each with three paragraphs standing open, made a page nobody reads
 * to the end - and the sentence with the number, which is the finding, drowned in
 * them. So the card shows what is needed to judge it (severity, title, the sentence,
 * the evidence) and folds the reasoning away.
 *
 * The label carries the promise, which is what mattered about keeping
 * `legitimateWhen` visible: a reader sees that the report says when this finding is
 * fine, before deciding whether to trust it.
 */
const FindingContext: React.FunctionComponent<{
  def: CheckDefinition | undefined;
}> = ({def}) =>
  def === undefined ? null : (
    <details className="finding__context">
      <summary>{'Why it matters'}</summary>
      <p className="finding__why">{def.why}</p>
      <p className="finding__legit">
        <span className="finding__legit-label">{'May be intentional:'}</span>{' '}
        {def.legitimateWhen}
      </p>
      <p className="finding__effort">
        <span className="finding__legit-label">{'What this involves:'}</span>{' '}
        {def.whatItInvolves}
      </p>
    </details>
  );

/**
 * The score arithmetic for one finding, openable.
 *
 * A score nobody can recalculate gets argued with instead of acted on, so every
 * term is available. In words rather than as a formula: "worth 10 points, 60 % of
 * what it measured is affected, so it takes away 6 of those 10". The exact ratio
 * stays in brackets for whoever wants to redo the multiplication.
 */
/** The last row of the arithmetic: what this check does to the hundred. */
function scoreEffect(points: HundredPoints | null, ignored: boolean): string {
  if (points === null) {
    return 'nothing - nothing in this category could be scored';
  }
  const worth = scoreText(points.worth);
  return ignored
    ? `nothing while marked as intentional - its ${worth} points stay in the score`
    : `${scoreText(points.lost)} of those ${worth} points`;
}

const ScoreTerms: React.FunctionComponent<{
  finding: Finding;
  def: CheckDefinition | undefined;
  ignored: boolean;
  marked: ReadonlySet<string>;
  result: ScanResult;
}> = ({finding, def, ignored, marked, result}) => {
  if (def === undefined) {
    return null;
  }
  const ratio = effectiveRatio(finding, marked);
  const markedHere = (finding.items ?? []).filter(item => marked.has(item.id)).length;
  /* Points of the same hundred the score is out of, not of the category's own
     total: the check's weight against the weight of the checks that ran beside it,
     times what that category is worth. Null only when the category scored nothing,
     and then there is no finding here to explain. */
  const points = checkPoints(result, def.category, def.weight, ratio);
  const noun = finding.itemKind === undefined ? 'object' : ITEM_NOUN[finding.itemKind];
  return (
    <details className="finding__terms">
      <summary>{'How this affects the score'}</summary>
      {/* Rows, not sentences: three lines that each said "this label is that value"
          read as a table, and a table is what a reader checks a score against. */}
      <dl className="terms">
        <dt>{'Worth'}</dt>
        <dd>
          {points === null
            ? `weighted ${def.weight} inside ${CATEGORY_LABEL[def.category]}`
            : `${scoreText(points.worth)} points of the hundred, as its share of ` +
              `${CATEGORY_LABEL[def.category]}`}
        </dd>
        <dt>{'Affected'}</dt>
        <dd>
          {`${shareText(finding.ratio)} of what it measured ` +
            `(ratio ${finding.ratio.toFixed(RATIO_DECIMALS)})`}
        </dd>
        {/* Marked objects change the share this check deducts for, so the arithmetic
            has to show the share that is actually counted. */}
        {markedHere > 0 && !ignored ? (
          <>
            <dt>{'Counted'}</dt>
            <dd>
              {`${shareText(ratio)}, with ${plural(markedHere, noun)} marked as ` +
                `intentional (ratio ${ratio.toFixed(RATIO_DECIMALS)})`}
            </dd>
          </>
        ) : null}
        <dt>{'Takes away'}</dt>
        <dd>{scoreEffect(points, ignored)}</dd>
      </dl>
    </details>
  );
};

interface FindingCardProps {
  /**
   * The whole result, for the one thing a finding cannot know alone: what its
   * points are worth of the hundred. That depends on which checks ran beside it.
   */
  result: ScanResult;
  finding: Finding;
  ignored: boolean;
  origin: string | null;
  /** Objects of this finding that are marked as intentional. */
  marked: ReadonlySet<string>;
  onToggleIgnore: (checkId: string, ignored: boolean) => void;
  onToggleItem: (checkId: string, item: string, ignored: boolean) => void;
}

/** Marks one named object of a check, or takes the mark off again. */
type ItemToggle = (checkId: string, item: string, ignored: boolean) => void;

/**
 * Whether single objects of this finding can be marked, and with what.
 *
 * Two conditions, and both are the check's own doing: it has to count things it also
 * lists - `total` says so - and its objects must not be people. A finding that
 * counts issues has nothing to point at, and an account is never stored.
 */
function itemMarking(
  finding: Finding,
  def: CheckDefinition | undefined,
  onToggleItem: ItemToggle
): ItemToggle | null {
  return finding.total !== undefined && !def?.itemsNamePeople ? onToggleItem : null;
}

/** Severity, title, and the control that takes the whole finding out of the score. */
const FindingHeader: React.FunctionComponent<{
  finding: Finding;
  title: string;
  ignored: boolean;
  onToggle: () => void;
}> = ({finding, title, ignored, onToggle}) => (
  <div className="finding__header">
    <span className="finding__severity">{SEVERITY_LABEL[finding.severity]}</span>
    <h4 className="finding__title">{title}</h4>
    <Button className="finding__ignore" onClick={onToggle}>
      {ignored ? 'Count again' : 'Mark as intentional'}
    </Button>
  </div>
);

/**
 * The sentences a card needs where a control or a list would be.
 *
 * Every one of these absences reads as a bug when nothing explains it - a control
 * that failed to load, a list that failed to arrive.
 */
const MARKING_NOTE = {
  accountsListed:
    'Single accounts are not marked one by one, because the app does not store ' +
    'them. The finding as a whole can be.',
  accountsNotKept:
    'The accounts behind this number are not kept with the report. A scan names ' +
    'them again.',
  wholeOnly:
    'This finding counts something other than the things listed here, so it can ' +
    'only be marked as a whole.',
} as const;

/** A licence finding either lists its accounts or was read back without them. */
function accountNote(listed: number): string {
  return listed > 0 ? MARKING_NOTE.accountsListed : MARKING_NOTE.accountsNotKept;
}

/**
 * Why the objects of this finding carry no control of their own.
 *
 * Only for a finding that counts something other than what it lists: cards on a
 * board, fields in a group. Taking one object out of such a list would not tell the
 * score what to subtract.
 */
function wholeOnlyNote(finding: Finding, offered: boolean): string | null {
  const listed = finding.items?.length ?? 0;
  return offered || listed === 0 ? null : MARKING_NOTE.wholeOnly;
}

const MarkingNote: React.FunctionComponent<{
  finding: Finding;
  def: CheckDefinition | undefined;
  ignored: boolean;
  perItem: ItemToggle | null;
}> = ({finding, def, ignored, perItem}) => {
  const text = def?.itemsNamePeople
    ? accountNote(finding.items?.length ?? 0)
    : wholeOnlyNote(finding, ignored || perItem !== null);
  return text === null ? null : <p className="finding__unnamed">{text}</p>;
};

/**
 * What a finding found: the objects it names, or the sentence that says why it
 * cannot name them one by one.
 *
 * Both live in the same place, so a card is always the same three rows.
 */
const FindingFound: React.FunctionComponent<{
  finding: Finding;
  def: CheckDefinition | undefined;
  ignored: boolean;
  origin: string | null;
  marked: ReadonlySet<string>;
  perItem: ItemToggle | null;
}> = ({finding, def, ignored, origin, marked, perItem}) => {
  const note = (
    <MarkingNote finding={finding} def={def} ignored={ignored} perItem={perItem}/>
  );
  if ((finding.items?.length ?? 0) === 0) {
    /* A row of its own, like every other card has: a sentence standing loose among
       disclosures reads as an inconsistency to a reader who has forgotten that this
       report came back from storage. Behind the same kind of line, it reads as an
       answer to the question the line asks. */
    return def?.itemsNamePeople === true ? (
      <details className="finding__found">
        <summary>{'The accounts behind this number'}</summary>
        {note}
      </details>
    ) : (
      note
    );
  }
  return (
    <AffectedItems
      finding={finding}
      origin={origin}
      marked={marked}
      onToggleItem={perItem}
      note={note}
    />
  );
};

const FindingCard: React.FunctionComponent<FindingCardProps> = ({
  finding,
  result,
  ignored,
  origin,
  marked,
  onToggleIgnore,
  onToggleItem
}) => {
  const def = CHECK_BY_ID.get(finding.checkId);
  const perItem = ignored ? null : itemMarking(finding, def, onToggleItem);
  const toggle = useCallback(
    () => onToggleIgnore(finding.checkId, !ignored),
    [finding.checkId, ignored, onToggleIgnore]
  );
  return (
    <article
      className={`finding finding--${finding.severity}${ignored ? ' finding--ignored' : ''}`}
    >
      <FindingHeader
        finding={finding}
        title={def?.title ?? finding.checkId}
        ignored={ignored}
        onToggle={toggle}
      />
      <p className="finding__headline">{finding.headline}</p>
      <Evidence finding={finding}/>
      {/* What was found comes before why it matters, and the arithmetic last: that
          is the order a reader asks in, and it puts the one sentence that has no
          row of its own - accounts are not kept with the report - directly under
          the numbers it is about instead of between two disclosures. */}
      <FindingFound
        finding={finding}
        def={def}
        ignored={ignored}
        origin={origin}
        marked={marked}
        perItem={perItem}
      />
      <FindingQuery finding={finding} origin={origin}/>
      <FindingContext def={def}/>
      <ScoreTerms
        finding={finding}
        def={def}
        ignored={ignored}
        marked={marked}
        result={result}
      />
    </article>
  );
};

/**
 * The score against the hundred it is out of.
 *
 * A track with the score filled in and the rest left empty, which is the shape the
 * table below already uses for every category and the shape a reader has met on
 * every score they have seen. Where the missing points went is not drawn here: the
 * table says it in words, with the area, the points lost, and what the area was
 * worth. Two pictures of one thing read as two things.
 */
/**
 * Geometry of the ring, in its own coordinates.
 *
 * The arc is drawn as one stroked circle whose dash pattern is the score: a dash of
 * the score's share of the circumference, then a gap for the rest. Rotated so it
 * starts at the top, where a reader expects a dial to start.
 */
const RING_SIZE = 108;
const RING_STROKE = 10;
/* Half the box, and the radius that leaves the stroke room inside it rather than
   half outside: (108 - 10) / 2 = 49. */
const RING_CENTRE = 54;
const RING_RADIUS = 49;
/** Circumference, so the dash pattern can be a share of it. */
const RING_LENGTH = Math.PI * (RING_SIZE - RING_STROKE);
/** A full ring. */
const FULL_SCORE = 100;
/** Back a quarter turn, so the arc starts at the top where a dial starts. */
const QUARTER_TURN = -90;

/**
 * The score inside the hundred it is out of.
 *
 * A ring rather than a bar, for two reasons. The maximum is the shape itself - a
 * full circle is a hundred, and how much of it is missing is visible without a
 * scale to read - and the app's own mark is a dial, so the page repeats the mark
 * instead of opening a second visual language. What is missing is not broken down
 * here: the table below names every area with what it was worth and what it lost,
 * and two pictures of one thing read as two things.
 *
 * "out of 100" in words under the figure, because that is the sentence a reader
 * needs and no arc can say it. A slash beside the number was small print.
 */
const ScoreRing: React.FunctionComponent<{points: number | null}> = ({points}) => (
  <div className="score-ring">
    <svg
      className="score-ring__dial"
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      role="img"
      aria-label={points === null ? 'No score' : `${oneDecimal(points)} out of 100 points`}
    >
      <circle
        className="score-ring__track"
        cx={RING_CENTRE}
        cy={RING_CENTRE}
        r={RING_RADIUS}
        strokeWidth={RING_STROKE}
      />
      {points === null ? null : (
        <circle
          className="score-ring__arc"
          cx={RING_CENTRE}
          cy={RING_CENTRE}
          r={RING_RADIUS}
          strokeWidth={RING_STROKE}
          strokeDasharray={`${(Math.max(points, 0) / FULL_SCORE) * RING_LENGTH} ${RING_LENGTH}`}
          transform={`rotate(${QUARTER_TURN} ${RING_CENTRE} ${RING_CENTRE})`}
        />
      )}
    </svg>
    <div className="score-ring__figures">
      <div className="score-ring__value">
        {points === null ? 'n/a' : scoreText(points)}
      </div>
      <div className="score-ring__max">{'out of 100'}</div>
    </div>
  </div>
);

/**
 * What a category kept, in points of the same hundred as the score above it.
 *
 * Not out of a hundred of its own: a category is a slice of the score, and stating
 * it as its own hundred made four numbers on one page mean four different things.
 * The figures here are the numbers of the bar, so the table and the bar can be read
 * against each other.
 */
const CategoryFigures: React.FunctionComponent<{
  result: ScanResult;
  category: CategoryScore;
}> = ({result, category}) => {
  const points = categoryPoints(result, category.category);
  if (points === null) {
    return (
      <>
        <td className="categories__score">{'-'}</td>
        <td className="categories__terms">{'nothing measured here'}</td>
      </>
    );
  }
  return (
    <>
      <td className="categories__score">
        {scoreText(points.worth - points.lost)}
        <span className="categories__score-max">{` / ${scoreText(points.worth)}`}</span>
      </td>
      <td className="categories__terms">
        {/* Bare figures: the column header carries the noun. */}
        {points.lost === 0 ? 'nothing' : scoreText(points.lost)}
      </td>
    </>
  );
};

/**
 * What the severity badges mean, shown as the badges.
 *
 * A sentence naming the bands ("critical from 75 %, high from 50 %, ...") leaves
 * the reader to map words onto coloured cards. Here each band is the thing it labels:
 * the same bar of colour the card carries, the same word, and the share it starts
 * at. Only the part no picture can say is left in words.
 */
const SEVERITY_BANDS: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

const SeverityLegend: React.FunctionComponent = () => (
  <div className="findings__note">
    <ul className="severity">
      {SEVERITY_BANDS.map(level => (
        <li key={level} className={`severity__band severity__band--${level}`}>
          <span className="severity__label">{SEVERITY_LABEL[level]}</span>
          <span className="severity__from">
            {level === 'low'
              ? `under ${percent(SEVERITY_FROM.medium)} %`
              : `from ${percent(SEVERITY_FROM[level])} %`}
          </span>
        </li>
      ))}
    </ul>
    {/* The one thing the picture cannot say. */}
    <p className="severity__aside">
      {'The share a check measured. It sorts the findings and colours them; it is ' +
        'not part of the score.'}
    </p>
  </div>
);

/** Anchor of the findings section as a whole. */
const FINDINGS_ANCHOR = 'findings';

/**
 * A number or a name that leads to the section it is about.
 *
 * Scrolled rather than jumped, so the reader keeps the connection between what
 * they clicked and where they land.
 */
const SectionJump: React.FunctionComponent<{
  anchor: string;
  children: React.ReactNode;
}> = ({anchor, children}) => (
  <a
    className="jump"
    href={`#${anchor}`}
    onClick={event => {
      const target = document.getElementById(anchor);
      if (!target) {
        return;
      }
      event.preventDefault();
      target.scrollIntoView({behavior: 'smooth', block: 'start'});
    }}
  >
    {children}
  </a>
);

/**
 * When the scan ran, what it cost the instance, and how far it can be trusted.
 *
 * A kept report describes the instance at its timestamp; whether that is still
 * true is the one thing it cannot know, so it says which of the two it is.
 */
const ScanNote: React.FunctionComponent<{
  at: Date;
  cost: ScanCost;
  restored: boolean;
  itemsOmitted: boolean;
  fate: ScanFate;
}> = ({at, cost, restored, itemsOmitted, fate}) => {
  const asked = `${cost.requests} requests in ${duration(cost.seconds)}`;
  // A scan that slowed down did so for a reason the instance gave.
  const pauses =
    cost.throttled === 0
      ? ''
      : ` The instance asked for a pause ${plural(cost.throttled, 'time')}, so the ` +
        'scan continued one request at a time.';
  return (
    <p className="score__note">
      {`Collected on ${timestampText(at)} - ${asked}.${pauses}`}
      {scanFateNote(fate, restored)}
      {itemsOmitted
        ? ' It named more objects than the report keeps, so they were left out ' +
          'rather than shortened; a scan lists them again.'
        : ''}
    </p>
  );
};

const ScoreHeader: React.FunctionComponent<{
  result: ScanResult;
  at: Date;
  cost: ScanCost;
  restored: boolean;
  itemsOmitted: boolean;
  fate: ScanFate;
  markedItems: IgnoredItems;
}> = ({result, at, cost, restored, itemsOmitted, fate, markedItems}) => {
  const decision = decisionEffect(result, markedItems);
  return (
    <section className="score">
      <div className="score__figures">
        <div className="score__figure">
          <div className="score__label">{'Overall score'}</div>
          {/* No second figure here: what the difference between the two scores
              means takes a sentence, and the sentence is beside this card. */}
          <ScoreRing points={result.overallScore}/>
        </div>
        {/* Countable, and the reader can check it against the list below. No
          duration: an estimate for an unknown instance would be guessed, and one
          item a reader can judge precisely would take the whole report with it. */}
        <div className="score__figure">
          <div className="score__label">{'Findings'}</div>
          <div className="score__value">
            {result.findings.length === 0 ? (
            0
          ) : (
            <SectionJump anchor={FINDINGS_ANCHOR}>{result.findings.length}</SectionJump>
          )}
          </div>
        </div>
      </div>
      <div className="score__meta">
        <ScanNote
          at={at}
          cost={cost}
          restored={restored}
          itemsOmitted={itemsOmitted}
          fate={fate}
        />
        {/* After the note, not before it: what a decision did to the score is a
            statement about absence - points that were not measured - and no picture
            carries that, but it is not the headline either. The same sentence the
            exports use, so all three media say it the same way. */}
        {decision === null ? null : <p className="score__decisions">{decisionSentence(decision)}</p>}
        <details className="score__formula">
          <summary>{'How the score is calculated'}</summary>
          <p>{SCORE_METHOD}</p>
          <p>{CATEGORY_WEIGHTS_NOTE}</p>
          {/* The mechanics without the reasoning leave the shares looking arbitrary,
              and a reader who cannot see the reasoning invents one. */}
          <p>{WEIGHT_REASON}</p>
        </details>
      </div>
    </section>
  );
};

/**
 * Category scores.
 *
 * Columns named "sum of the deductions" and "sum of the weights that ran" cannot be
 * read without the formula in mind. The same two numbers are one plain sentence
 * instead - "10 of 10 points lost" - and the bar carries the comparison the eye
 * wants anyway. The arithmetic stays available per finding.
 */
/** Anchor of a category's findings, shared by the table and the findings section. */
function findingsAnchor(category: Category): string {
  return `findings-${category}`;
}

/**
 * The name of a category, as a jump to its findings.
 *
 * The table answers "where did the points go" and the findings answer "why", two
 * screens apart with nothing between them but this jump. A category that
 * lost nothing has nothing to jump to, so it stays plain text rather than becoming
 * a control that does nothing.
 */
const CategoryName: React.FunctionComponent<{category: CategoryScore}> = ({
  category
}) => {
  const label = CATEGORY_LABEL[category.category];
  if (category.findings.length === 0) {
    return <span className="categories__plain">{label}</span>;
  }
  return (
    <SectionJump anchor={findingsAnchor(category.category)}>
      {`${label} (${plural(category.findings.length, 'finding')})`}
    </SectionJump>
  );
};

const Categories: React.FunctionComponent<{
  categories: CategoryScore[];
  result: ScanResult;
}> = ({categories, result}) => (
  <section className="categories">
    <h2>{'Where the points went'}</h2>
    {/* No caption: the bar sits with the score above, this table breaks the same
        hundred down per area, and a name that leads somewhere looks like one. */}
    <table className="categories__table">
      {/* Named columns, because "21.0 / 30.0" beside "9.0 points lost" is two
          figures a reader has to guess at otherwise. */}
      <thead>
        <tr>
          <th scope="col">{'Area'}</th>
          <th scope="col"/>
          <th scope="col" className="categories__score">{'Points kept'}</th>
          <th scope="col" className="categories__terms">{'Points lost'}</th>
        </tr>
      </thead>
      <tbody>
        {categories.map(c => (
          <tr key={c.category}>
            <th scope="row" className="categories__name">
              <CategoryName category={c}/>
            </th>
            <td className="categories__bar-cell">
              <div className="categories__bar">
                <div
                  className="categories__bar-fill"
                  style={{width: `${c.score === null ? 0 : Math.max(c.score, 0)}%`}}
                  /* The fill is the share this category kept of its own points -
                     the same proportion the two figures beside it state. */
                />
              </div>
            </td>
            <CategoryFigures result={result} category={c}/>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);


/**
 * How the instance moved between the two newest scans.
 *
 * Built on the measured scores, not the reported ones: marking a finding as
 * intentional raises the score without anything in the instance changing, and
 * "up 0.5 points" would then credit the instance for a decision.
 */

/**
 * Checks that produced no measurement.
 *
 * Without this the score moves for no visible reason: a failed check leaves its
 * category empty, the number jumps, and the page looks as if it had simply found
 * less. Naming them also separates "nothing to check here" from "this did not work".
 */
const NotRun: React.FunctionComponent<{outcomes: CheckOutcome[]}> = ({outcomes}) => {
  const notRun = withoutMeasurement(outcomes);
  if (notRun.length === 0) {
    return null;
  }
  return (
    <section className="not-run">
      <h2>{`${NO_MEASUREMENT_HEADING} (${notRun.length})`}</h2>
      <p className="not-run__note">{NO_MEASUREMENT_NOTE}</p>
      <ul className="not-run__list">
        {noMeasurementGroups(outcomes, id => CHECK_BY_ID.get(id)?.title ?? id).map(group => (
          <li key={group.phrase}>
            {`${andList(group.titles)} - `}
            {group.phrase}
          </li>
        ))}
      </ul>
    </section>
  );
};

/** ISO date without the time, which is the resolution a trend is read at. */
function dayOf(iso: string): string {
  return iso.slice(0, 'YYYY-MM-DD'.length);
}

/** How many movements the section lists before it stops naming them. */
const MOVED_SHOWN = 6;

function changeText(change: CheckChange): string {
  const title = CHECK_BY_ID.get(change.id)?.title ?? change.id;
  /* A check that appeared or is gone is named as that; one that only moved is
     read from the two shares themselves. */
  const kind =
    change.kind === 'new' || change.kind === 'resolved'
      ? `${MOVEMENT_LABEL[change.kind]}, `
      : '';
  return `${title} - ${kind}${movementDetail(change)}`;
}

/**
 * What moved between the two newest scans.
 *
 * A trend that only shows a line invites the one question it cannot answer: what
 * changed? Per-check ratios are aggregates, so they are stored, and this is what
 * they buy - the sentence that says whether the work paid off.
 */
/**
 * Where a check stands, for the ones that did not move.
 *
 * "Unchanged" alone leaves open whether the check found nothing or found the same
 * problem as last time - which is the difference between good news and no news. And
 * a check that produced no measurement says why in the same breath: "did not run"
 * on its own reads as something having gone wrong.
 */
function levelText(change: CheckChange): string {
  if (change.after === null) {
    return noMeasurementPhrase(change.status ?? '');
  }
  /* The share the check measured, not a fraction of its points: this list sits
     next to figures that are all slices of the hundred, and "3 % of its points"
     was a fifth scale nobody could add up. */
  return change.after === 0 ? 'nothing found' : `${shareText(change.after)} affected`;
}

/** The checks behind a count, so the sentence above can be checked. */
const CheckList: React.FunctionComponent<{
  summary: string;
  changes: readonly CheckChange[];
  withLevel?: boolean;
}> = ({summary, changes, withLevel = false}) => (
  <details className="trend__unchanged">
    <summary>{summary}</summary>
    <ul className="trend__unchanged-list">
      {changes.map(change => (
        <li key={change.id}>
          {withLevel
            ? `${CHECK_BY_ID.get(change.id)?.title ?? change.id} - ${levelText(change)}`
            : changeText(change)}
        </li>
      ))}
    </ul>
  </details>
);

const Moved: React.FunctionComponent<{history: ScanAggregate[]}> = ({history}) => {
  const {compared, moved, unchanged} = useMemo(() => compareScans(history), [history]);
  if (!compared) {
    return null;
  }
  return (
    <div className="trend__moved">
      <h3 className="trend__moved-title">{'Since the previous scan'}</h3>
      {moved.length === 0 ? (
        // Silence here would read as a missing feature rather than as a result.
        <CheckList
          summary={`Nothing moved: all ${plural(unchanged.length, 'check')} came back within a percentage point of before.`}
          changes={unchanged}
          withLevel
        />
      ) : (
        <ul className="trend__moved-list">
          {moved.slice(0, MOVED_SHOWN).map(change => (
            <li key={change.id} className={`trend__moved-item trend__moved-item--${change.kind}`}>
              {/* The space is not decoration: the label is spaced by CSS on screen,
                  and without it a copied line and a screen reader both say
                  "worseBoards without WIP limits". */}
              <span className="trend__moved-kind">{MOVEMENT_LABEL[change.kind]}</span>{' '}
              {changeText(change)}
            </li>
          ))}
        </ul>
      )}
      {moved.length > MOVED_SHOWN ? (
        <CheckList
          summary={`and ${moved.length - MOVED_SHOWN} more checks moved`}
          changes={moved.slice(MOVED_SHOWN)}
        />
      ) : null}
      {moved.length > 0 && unchanged.length > 0 ? (
        <CheckList
          summary={`${plural(unchanged.length, 'check')} unchanged.`}
          changes={unchanged}
          withLevel
        />
      ) : null}
    </div>
  );
};

/**
 * How much of a stored score rests on decisions rather than on a measurement.
 *
 * Only when there is something to say: "0.0 points rest on decisions" is noise, and
 * a bare second score ("as measured 67.8") said nothing to anyone who did not
 * already know what it meant.
 */
const DecisionShare: React.FunctionComponent<{
  reported: number;
  measured: number | null;
  show: boolean;
}> = ({reported, measured, show}) => {
  const onDecisions = measured === null ? 0 : oneDecimal(reported - measured);
  if (!show || onDecisions === 0) {
    return null;
  }
  return (
    <p className="trend__measured">
      {`${scoreText(onDecisions)} of those points rest on findings marked as intentional.`}
    </p>
  );
};

/** The line, with the span it covers. */
const Sparkline: React.FunctionComponent<{trend: Trend}> = ({trend}) => {
  const {path, measuredPath, from, to} = sparkline(
    trend.points,
    SPARK_WIDTH,
    SPARK_HEIGHT
  );
  const first = trend.points[0];
  const last = trend.points[trend.points.length - 1];
  if (!path || !first || !last) {
    return null;
  }
  return (
    <div className="trend__chart-box">
      {/* The scale belongs on the axis, not in a caption. A sentence naming the
          span made the reader hold two numbers in mind and map them onto an
          unlabelled band; the same two numbers beside the line need no explaining -
          top is the top, bottom is the bottom. The axis does not start at zero,
          which is what makes a move of two points visible at all, so saying where
          it does start is not decoration. */}
      <div className="trend__plot">
        <div className="trend__scale" aria-hidden="true">
          <span>{scoreText(to)}</span>
          <span>{scoreText(from)}</span>
        </div>
        <svg
          className="trend__chart"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          role="img"
          aria-label={
            `Score of the last ${plural(trend.points.length, 'scan')}, ` +
            `on a scale from ${scoreText(from)} to ${scoreText(to)} points`
          }
        >
          {/* The measured line first, so the reported one stays on top of it. */}
          {measuredPath ? (
            <path className="trend__line trend__line--measured" d={measuredPath}/>
          ) : null}
          <path className="trend__line" d={path}/>
        </svg>
      </div>
      {/* Without dates the line is decoration: two scans an hour apart look like
          months of progress. */}
      <div className="trend__axis">
        <span>{dayOf(first.at)}</span>
        <span>{dayOf(last.at)}</span>
      </div>
      {/* Two lines, labelled by a sample of themselves. Written out - "Solid: the
          score as reported. Dashed: as measured, before findings were marked as
          intentional." - it was a sentence the reader had to map onto a picture
          that could simply carry its own labels. */}
      {measuredPath ? (
        <ul className="trend__legend">
          <li>
            <svg className="trend__sample" viewBox="0 0 24 4" aria-hidden="true">
              <path className="trend__line" d="M0 2 H24"/>
            </svg>
            {'as shown'}
          </li>
          <li>
            <svg className="trend__sample" viewBox="0 0 24 4" aria-hidden="true">
              <path className="trend__line trend__line--measured" d="M0 2 H24"/>
            </svg>
            {'without the marks'}
          </li>
        </ul>
      ) : null}
    </div>
  );
};

/**
 * The score of earlier scans, and what the last one came out at.
 *
 * This is what makes the app a recurring appointment instead of a one-off diagnosis
 * the administrator sees that the work moved the number. It is stated
 * plainly, without praise - the report is his material for a budget conversation.
 *
 * It also carries the result of the last scan, because reopening the page starts
 * without findings: they are not stored, only these numbers are. Without them the
 * page would look as if the earlier scan had never happened.
 */
const TrendSection: React.FunctionComponent<{
  history: ScanAggregate[];
  now: Date;
  /** False while a fresh report is on screen, which states the score itself. */
  withScore: boolean;
}> = ({history, now, withScore}) => {
  const trend = useMemo(() => trendFrom(history), [history]);
  const latest = history.find(entry => entry.score !== null);
  const newest = trend.points[trend.points.length - 1];
  if (!newest || !latest) {
    return null;
  }
  const age = daysSince(newest.at, now);
  const measured = scoreBeforeDecisions(latest);
  return (
    <section className="trend">
      <h2>{withScore ? 'Last scan' : 'Score over time'}</h2>
      <div className="trend__body">
        <Sparkline trend={trend}/>
        <div>
          {withScore ? (
            <p className="trend__latest">
              <strong className="trend__score">{scoreText(newest.score)}</strong>
              {/* In words, like the ring: a slash and a maximum on one page and
                  words for the same thing on another read as two scales. */}
              {' out of 100 - '}
              {`${plural(latest.findings, 'finding')} - ${agePhrase(age)}`}
            </p>
          ) : null}
          {/* Reopening the page shows stored numbers and no findings, and a number
              that a decision raised looks like an instance that improved. */}
          <DecisionShare reported={newest.score} measured={measured} show={withScore}/>
          <p className="trend__delta">{trendSentence(trend, age)}</p>
        </div>
      </div>
      <Moved history={history}/>
    </section>
  );
};

/**
 * The report gets forwarded internally and lands with people who never saw the app,
 * so it carries its own attribution. The app never phones home.
 */
/**
 * Attribution and the one next step the report offers.
 *
 * The report gets forwarded internally and lands with people who never saw the app,
 * so it carries its own sender. The mail link is prefilled with the two numbers a
 * first conversation starts from - nothing is sent, the administrator's mail client
 * opens with a draft.
 */
const Attribution: React.FunctionComponent<{result: ScanResult | null}> = ({
  result
}) => {
  const subject = result
    ? `Instance Insights: score ${
        result.overallScore === null ? 'n/a' : oneDecimal(result.overallScore)
      }, ${plural(result.findings.length, 'finding')}`
    : 'Instance Insights';
  return (
    <footer className="report__attribution">
      {'Report by '}
      <a href="https://ninjaneers.de" target="_blank" rel="noreferrer noopener">
        {'Ninjaneers GmbH'}
      </a>
      {'. Happy to walk through this report together - '}
      <a href={`mailto:info@ninjaneers.de?subject=${encodeURIComponent(subject)}`}>
        {'info@ninjaneers.de'}
      </a>
      {'.'}
    </footer>
  );
};

interface ReportProps {
  result: ScanResult;
  at: Date;
  cost: ScanCost;
  /**
   * The trend, rendered between the score and where its points went.
   *
   * Handed in rather than built here: the trend is drawn from what earlier scans
   * left behind, which is the page's business and not this report's. Its place in
   * the reading order is - the score first, how it moved second.
   */
  trend: React.ReactNode;
  /** True for the report the app kept, false for one that just ran. */
  restored: boolean;
  itemsOmitted: boolean;
  /** False when this scan was not written to the app's storage. */
  fate: ScanFate;
  /** The instance to link to, or null when the report cannot establish it. */
  origin: string | null;
  /** Marked objects per check. */
  markedItems: IgnoredItems;
  onToggleIgnore: (checkId: string, ignored: boolean) => void;
  onToggleItem: (checkId: string, item: string, ignored: boolean) => void;
}

/** Shared empty set, so a finding with no marks does not allocate one per render. */
const NO_MARKS: ReadonlySet<string> = new Set();

const Report: React.FunctionComponent<ReportProps> = ({
  result,
  at,
  cost,
  restored,
  itemsOmitted,
  fate,
  trend,
  origin,
  markedItems,
  onToggleIgnore,
  onToggleItem
}) => {
  return (
    <div className="report__body">
      <ScoreHeader
        result={result}
        at={at}
        cost={cost}
        restored={restored}
        itemsOmitted={itemsOmitted}
        fate={fate}
        markedItems={markedItems}
      />
      {trend}
      <Categories categories={result.categories} result={result}/>
      <section className="findings">
        <h2 id={FINDINGS_ANCHOR}>{'Findings'}</h2>
        {result.findings.length > 0 ? <SeverityLegend/> : null}
        {result.findings.length === 0 ? (
          <p>{'No findings. The areas that were checked look unremarkable.'}</p>
        ) : null}
        {/* Grouped by category, in the order of the table above, so a jump from
            there lands on a heading instead of somewhere in a flat list. */}
        {result.categories.map(category =>
          category.findings.length === 0 ? null : (
            <div key={category.category} className="findings__group">
              <h3
                className="findings__group-title"
                id={findingsAnchor(category.category)}
              >
                {CATEGORY_LABEL[category.category]}
              </h3>
              {byImpact(category.findings).map(f => (
                <FindingCard
                  key={f.checkId}
                  finding={f}
                  result={result}
                  ignored={false}
                  origin={origin}
                  marked={markedItems.get(f.checkId) ?? NO_MARKS}
                  onToggleIgnore={onToggleIgnore}
                  onToggleItem={onToggleItem}
                />
              ))}
            </div>
          )
        )}
      </section>
      {result.ignoredFindings.length > 0 ? (
        <section className="findings findings--ignored">
          <h2>{`Marked as intentional (${result.ignoredFindings.length})`}</h2>
          <p className="findings__note">
            {'These findings stay visible but no longer affect the score. Their ' +
              'checks still count as having run.'}
          </p>
          {result.ignoredFindings.map(f => (
            <FindingCard
              key={f.checkId}
              finding={f}
              result={result}
              ignored
              origin={origin}
              marked={markedItems.get(f.checkId) ?? NO_MARKS}
              onToggleIgnore={onToggleIgnore}
              onToggleItem={onToggleItem}
            />
          ))}
        </section>
      ) : null}
      <NotRun outcomes={result.outcomes}/>
      <Attribution result={result}/>
    </div>
  );
};

/**
 * What the scan is doing.
 *
 * On an instance with many projects a single check spends minutes on paced
 * requests, so a bare spinner looks like a hang. Three things make the wait
 * readable: which check is running, how many requests have gone to the instance,
 * and the findings that are already in - plus the way out of the wait.
 */
const ScanRunning: React.FunctionComponent<{
  progress: ScanProgressState;
  sent: number;
  startedAt: number;
  throttled: number;
  onStop: () => void;
}> = ({progress, sent, startedAt, throttled, onStop}) => {
  // Re-rendered once a second, so the elapsed time moves while a check is busy.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), MS_PER_SECOND);
    return (): void => clearInterval(tick);
  }, []);
  return (
    <div className="report__loader">
      {progress.total === 0 ? (
        <Loader message="Starting the scan..."/>
      ) : (
        <>
          <ProgressBar
            className="report__progress"
            max={progress.total}
            value={progress.done}
            label={`${progress.done} of ${progress.total} checks done`}
          />
          <div className="report__progress-foot">
            <p className="report__progress-label">
              {`${progress.done} of ${progress.total} checks done`}
              {progress.running === null ? '' : ` - ${progress.running}`}
              {` - ${plural(sent, 'request')} in ` +
                `${duration((now - startedAt) / MS_PER_SECOND)}`}
              {throttled > 0
                ? ' - the instance asked for a pause, continuing one at a time'
                : ''}
            </p>
            <Button onClick={onStop}>{'Stop the scan'}</Button>
          </div>
          {/* Where the scan actually runs, because that has consequences a reader
              can act on: browsers slow a tab down once it is in the background, and
              a scan of a large instance sends a few thousand requests, one every
              fifty milliseconds - a pace a throttled tab does not keep. */}
          <p className="report__progress-label">
            {'The scan runs in this tab: browsers slow a tab down while it is in ' +
              'the background, and closing the page ends the scan.'}
          </p>
          {progress.findings.length > 0 ? (
            <ul className="report__early">
              {progress.findings.map(finding => (
                <li key={finding.checkId}>{finding.headline}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
};

interface ScanStatusProps {
  state: ScanState;
  result: ScanResult | null;
  /** The trend section, shown in every state - with or without a report. */
  trend: React.ReactNode;
  scannedBefore: boolean;
  /** How far the read of the app's own storage has come. */
  stateRead: StateRead;
  origin: string | null;
  markedItems: IgnoredItems;
  onToggleIgnore: (checkId: string, ignored: boolean) => void;
  onToggleItem: (checkId: string, item: string, ignored: boolean) => void;
  onStop: () => void;
}

/**
 * What stands on the page before the first click.
 *
 * Four different situations, and the difference matters enough to name: storage
 * that did not answer is not an instance that has never been scanned, storage that
 * has not answered *yet* is neither, and an instance with earlier numbers but no
 * kept findings is a fourth. Getting the third one wrong is what this page did: it
 * said "the report is kept afterwards, so opening this page again does not scan
 * again" while the kept report was still on its way, under a button offering to
 * scan - and a scan started then is not recorded, so the wait bought nothing.
 */
const IDLE_TEXT = {
  unreadable:
    "The app's stored state could not be read, so neither earlier scans nor what " +
    'was marked as intentional are known here. A scan still reads the instance, ' +
    'but it will not be recorded. Reading it needs permission to manage apps in ' +
    'this instance; with that permission, reloading usually settles it.',
  scannedBefore:
    'The numbers above come from earlier scans; their findings are not here. A ' +
    'scan brings them back from the instance as it stands now.',
  /* Said while the storage is still answering. Short: it is a wait, not a state
     the reader has to decide anything about. */
  reading: 'Looking for a scan this instance already has...',
  first:
    'A scan reads counts, IDs and timestamps, never issue content, and names the ' +
    'projects, boards and accounts behind each finding so they can be acted on. ' +
    'The report is kept afterwards, so opening this page again does not scan again.',
  /** What the instance is in for, said before the click rather than after it. */
  cost:
    'One question per project and per licensed account: a few hundred requests on ' +
    'a small instance, a few thousand on a large one, spaced out so the instance ' +
    'keeps answering everyone else. Can be stopped while it runs.',
} as const;

/**
 * Says that a scan is already under way somewhere else.
 *
 * Not a lock: the button stays where it is and does what it says. What the second
 * administrator - or the second window - is missing is the fact and its price, and
 * with both stated the decision is theirs. The age carries the weight: "a moment
 * ago" is a scan in flight, "three days ago" is a browser that went away, and one
 * sentence covers both without the app having to invent an expiry.
 */
const ScanElsewhere: React.FunctionComponent<{
  startedAt: string;
  now: Date;
}> = ({startedAt, now}) => (
  <Alert type={Alert.Type.WARNING} inline closeable={false} showWithAnimation={false}>
    {`A scan of this instance started ${agoPhrase(startedAt, now)}, in another ` +
      'window or on a dashboard. Scanning again now would ask the instance ' +
      'everything twice; the result of that scan shows up here after a reload.'}
  </Alert>
);

const ScanIdle: React.FunctionComponent<{
  scannedBefore: boolean;
  stateRead: StateRead;
}> = ({scannedBefore, stateRead}) => {
  /* A wait is drawn as a wait. The dashboard tile has done this since it was
     built; the page had only the three outcomes of the read and none of them. */
  if (stateRead === 'pending') {
    return (
      <div className="report__loader">
        <Loader message={IDLE_TEXT.reading}/>
      </div>
    );
  }
  if (stateRead === 'failed') {
    return (
      <Alert type={Alert.Type.WARNING} inline closeable={false} showWithAnimation={false}>
        {`${IDLE_TEXT.unreadable} ${IDLE_TEXT.cost}`}
      </Alert>
    );
  }
  const situation = scannedBefore ? IDLE_TEXT.scannedBefore : IDLE_TEXT.first;
  return <p className="report__hint">{`${situation} ${IDLE_TEXT.cost}`}</p>;
};

const ScanStatus: React.FunctionComponent<ScanStatusProps> = ({
  state,
  result,
  trend,
  scannedBefore,
  stateRead,
  origin,
  markedItems,
  onToggleIgnore,
  onToggleItem,
  onStop
}) => {
  switch (state.phase) {
    case 'idle':
      return (
        <>
          {trend}
          <ScanIdle scannedBefore={scannedBefore} stateRead={stateRead}/>
        </>
      );
    case 'running':
      return (
        <>
          {trend}
          <ScanRunning
            progress={state.progress}
            sent={state.sent}
            startedAt={state.startedAt}
            throttled={state.throttled}
            onStop={onStop}
          />
        </>
      );
    case 'error':
      return (
        <>
          {trend}
          <Alert type={Alert.Type.ERROR} inline closeable={false} showWithAnimation={false}>
            {`The scan did not finish completely: ${state.message}`}
          </Alert>
        </>
      );
    case 'done':
      return result ? (
        <>
          {state.stopped ? (
            <Alert type={Alert.Type.WARNING} inline closeable={false} showWithAnimation={false}>
              {'This scan was stopped, so it read part of the instance. What it ' +
                'measured is below, together with the checks it did not reach; ' +
                'this run is not part of the trend, because a part and a whole ' +
                'cannot be compared.'}
            </Alert>
          ) : null}
          <Report
            result={result}
            at={state.at}
            cost={state.cost}
            restored={state.restored}
            itemsOmitted={state.itemsOmitted}
            fate={state.fate}
            trend={trend}
            origin={origin}
            markedItems={markedItems}
            onToggleIgnore={onToggleIgnore}
            onToggleItem={onToggleItem}
          />
        </>
      ) : null;
    default:
      return null;
  }
};

const AppComponent: React.FunctionComponent = () => {
  const [state, setState] = useState<ScanState>({phase: 'idle'});
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const [markedItems, setMarkedItems] = useState<IgnoredItems>(new Map());
  const [history, setHistory] = useState<ScanAggregate[]>([]);
  /* Null until the handler has named the host - and it stays null when the widget's
     own base names a different host than the instance. */
  const [origin, setOrigin] = useState<string | null>(null);
  /**
   * Whether the app's own storage answered.
   *
   * It holds the trend and the standing decisions. Failing to read it looks exactly
   * like an instance that has never been scanned, and the difference matters: a scan
   * started without the decisions would compute a score that ignores them and store
   * it over the one that does not. So a scan still runs - it reads the instance and
   * that is useful - but it is not recorded, and the page says so.
   */
  const [stateRead, setStateRead] = useState<StateRead>('pending');
  /** When a scan the other widget started was started, or null when none was. */
  const [scanElsewhere, setScanElsewhere] = useState<string | null>(null);

  // Fixed at mount: the age of a scan must not change while the page sits open.
  const openedAt = useMemo(() => new Date(), []);

  // Both are instance-wide: which findings an administrator marked as intentional,
  // and the scores of earlier scans. Loaded before the first scan of this session,
  // so a returning administrator sees the trend without scanning again.
  useEffect(() => {
    appState
      .read()
      .then(state_ => {
        setIgnored(new Set(state_.ignoredChecks));
        setMarkedItems(itemsByCheck(state_.ignoredItems));
        setHistory(state_.history);
        setOrigin(instanceOrigin(state_.host, document.baseURI));
        setScanElsewhere(
          scanUnderWay(state_.scanStarted, state_.lastScan?.at, openedAt, state_.lastRun?.seconds),
        );
        const kept = restoredScan(state_.lastRun);
        if (kept) {
          setState(kept);
        }
        setStateRead('read');
      })
      .catch(() => setStateRead('failed'));
    // `openedAt` is the moment this page opened and never changes after it.
  }, [openedAt]);

  // Scoring is pure, so a toggle recomputes from the outcomes already in hand.
  const result = useMemo(
    () =>
      state.phase === 'done' ? score(state.outcomes, ignored, markedItems) : null,
    [state, ignored, markedItems]
  );

  const saveAggregate = useCallback(
    async (current: ScanResult, at: Date, cost: ScanCost) => {
      // Saving the same timestamp again revises that point of the trend instead of
      // adding one, which is what marking a finding does. See src/backend.js.
      setHistory(await appState.saveScan(uploadOf(current, at, cost, CHECKS)));
    },
    []
  );

  // Held for the running scan only: stopping is about the scan in flight.
  const running = useRef<ScanHandle | null>(null);
  const stopScan = useCallback(() => running.current?.stop(), []);

  const startScan = useCallback(async () => {
    // This page is the one scanning now, whatever it read when it opened.
    setScanElsewhere(null);
    const startedAt = new Date();
    /* Said before the scan starts, because its first progress report arrives while
       the call that starts it is still running. */
    setState({
      phase: 'running',
      progress: {done: 0, total: CHECKS.length, running: null, findings: []},
      sent: 0,
      startedAt: startedAt.getTime(),
      throttled: 0
    });
    const handle = startSession({
      checks: CHECKS,
      config: DEFAULT_CONFIG,
      store: appState,
      // A client per scan: the signal that stops it and the counter that shows how
      // far it has come belong to this run, not to the widget.
      client: hooks => createHostClient(host, hooks),
      decisions: {checks: ignored, items: markedItems},
      stateRead: stateRead === 'read',
      startedAt,
      onProgress: progress =>
        setState(prev => (prev.phase === 'running' ? {...prev, progress} : prev)),
      onRequest: sent =>
        setState(prev => (prev.phase === 'running' ? {...prev, sent} : prev)),
      onThrottle: throttled =>
        setState(prev => (prev.phase === 'running' ? {...prev, throttled} : prev))
    });
    running.current = handle;
    try {
      const run = await handle.done;
      if (run.history !== null) {
        setHistory(run.history);
      }
      setState({
        phase: 'done',
        outcomes: run.outcomes,
        at: run.at,
        stopped: run.stopped,
        cost: run.cost,
        restored: false,
        itemsOmitted: false,
        fate: run.fate
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      host.alert(`The scan could not be completed: ${message}`);
      setState({phase: 'error', message});
    }
  }, [ignored, markedItems, stateRead]);

  // The export is one click: rendering is pure, so the file is built on demand
  // instead of shown in a panel the click would have to scroll to.
  const exportMarkdown = useCallback(async () => {
    if (result && state.phase === 'done') {
      const md = await renderer(import('../../report-markdown.ts'));
      if (md === null) {
        return;
      }
      downloadMarkdown(
        md.reportToMarkdown({
          result,
          checks: CHECKS,
          at: state.at,
          stopped: state.stopped,
          comparison: compareScans(history),
          instanceUrl: origin ?? undefined,
          markedItems
        })
      );
    }
  }, [result, state, history, origin, markedItems]);

  // The printed document carries the trend as the sentence shown on screen; a
  // number without its direction is worth less in a budget conversation.
  const exportPrint = useCallback(async () => {
    if (result && state.phase === 'done') {
      const print = await renderer(import('../../report-print.ts'));
      if (print === null) {
        return;
      }
      const trend = trendFrom(history);
      const newest = trend.points[trend.points.length - 1];
      printReport(
        print.reportToPrintHtml({
          result,
          checks: CHECKS,
          at: state.at,
          stopped: state.stopped,
          instanceUrl: origin ?? undefined,
          markedItems,
          trendLine: newest
            ? trendSentence(trend, daysSince(newest.at, openedAt))
            : undefined,
          comparison: compareScans(history)
        })
      );
    }
  }, [result, state, history, openedAt, origin, markedItems]);

  /* What the handler stored is authoritative: it replaces the view, and the
     dashboard tile follows through the revised scan aggregate. */
  const applyMarks = useCallback(
    (stored: IgnoredState) => {
      const checks = new Set(stored.ignoredChecks);
      const items = itemsByCheck(stored.ignoredItems);
      setIgnored(checks);
      setMarkedItems(items);
      if (state.phase === 'done') {
        return saveAggregate(score(state.outcomes, checks, items), state.at, state.cost);
      }
      return undefined;
    },
    [state, saveAggregate]
  );

  const toggleIgnore = useCallback(
    (checkId: string, nextIgnored: boolean) => {
      // The view first: the score must react to the click, not to the round trip.
      setIgnored(prev => withCheck(prev, checkId, nextIgnored));

      appState
        .setIgnored(checkId, nextIgnored)
        .then(applyMarks)
        .catch(() => {
          /* This click is undone, not the state as it stood when it was made: two
             marks in quick succession and a snapshot would take the first one back
             along with the second. */
          setIgnored(prev => withCheck(prev, checkId, !nextIgnored));
          host.alert('The finding could not be marked. Please try again.');
        });
    },
    [applyMarks]
  );

  const toggleItem = useCallback(
    (checkId: string, item: string, nextIgnored: boolean) => {
      setMarkedItems(prev => withItem(prev, checkId, item, nextIgnored));

      appState
        .setItemIgnored(checkId, item, nextIgnored)
        .then(applyMarks)
        .catch(() => {
          setMarkedItems(prev => withItem(prev, checkId, item, !nextIgnored));
          host.alert('The object could not be marked. Please try again.');
        });
    },
    [applyMarks]
  );

  return (
    <div className="report">
      <header className="report__head">
        {/* YouTrack puts the app's name above this page; repeating it here left the
            heading standing twice. What the page is about takes its place. */}
        <div>
          <h1 className="report__title">
            {"Where this instance's configuration and process have drifted over time"}
          </h1>
        </div>
        <div className="report__actions">
          {/* Busy while the storage is still answering, too: a scan started then
              runs without the standing decisions and is therefore not recorded, so
              offering it would cost a few hundred requests for nothing. */}
          <Button
            primary
            loader={state.phase === 'running' || stateRead === 'pending'}
            disabled={state.phase === 'running' || stateRead === 'pending'}
            onClick={startScan}
          >
            {state.phase === 'done' ? 'Scan again' : 'Start scan'}
          </Button>
          {/* One menu rather than two buttons. A button label has room for a name
              and not for a purpose, which is why "Markdown" told nobody what it was
              good for; a menu item has a second line, and YouTrack's own menus look
              like this. */}
          {state.phase === 'done' ? (
            <DropdownMenu
              anchor={(
                <Button dropdown icon={exportGlyph}>
                  {'Export'}
                </Button>
              )}
              data={[
                {
                  rgItemType: DropdownMenu.ListProps.Type.ITEM,
                  glyph: printerGlyph,
                  label: 'Print, or save as PDF',
                  description: 'A document to hand on outside this instance',
                  onClick: exportPrint
                },
                {
                  rgItemType: DropdownMenu.ListProps.Type.ITEM,
                  glyph: fileTextGlyph,
                  label: 'Markdown file',
                  description: 'To paste into an issue or article, which render Markdown',
                  onClick: exportMarkdown
                }
              ]}
            />
          ) : null}
        </div>
      </header>
      {/* Above the report rather than beside the button: it is a fact about the
          instance right now, and the reader needs it before deciding anything. */}
      {scanElsewhere === null || state.phase === 'running' ? null : (
        <ScanElsewhere startedAt={scanElsewhere} now={openedAt}/>
      )}
      <ScanStatus
        state={state}
        result={result}
        trend={(
          <TrendSection
            history={history}
            now={openedAt}
            withScore={state.phase !== 'done'}
          />
        )}
        scannedBefore={history.length > 0}
        stateRead={stateRead}
        origin={origin}
        markedItems={markedItems}
        onToggleIgnore={toggleIgnore}
        onToggleItem={toggleItem}
        onStop={stopScan}
      />
    </div>
  );
};

export const App = memo(AppComponent);
