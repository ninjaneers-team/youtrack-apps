/**
 * One finding, as a card.
 *
 * The card shows what is needed to judge the finding - severity, title, the
 * sentence with the number, the objects behind it - and folds the reasoning and the
 * arithmetic away behind a click. Marking lives here too, because the decision is
 * taken while reading the finding.
 */

import React, {useCallback} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Icon from '@jetbrains/ring-ui-built/components/icon/icon';
import newWindowGlyph from '@jetbrains/icons/new-window';

import {effectiveRatio} from '../../engine.ts';
import type {ScanResult} from '../../engine.ts';
import {CATEGORY_LABEL} from '../../types.ts';
import type {CheckDefinition, Finding, FindingItem} from '../../types.ts';
import {
  checkPoints,
  issueSearchUrl,
  itemKindPage,
  itemNoun,
  itemUrl,
  ONE_PAGE_LINK,
  ONE_PAGE_NOTE,
  RATIO_DECIMALS,
  scoreText,
  SEVERITY_LABEL,
  shareText
} from '../../report-shared.ts';
import type {HundredPoints} from '../../report-shared.ts';
import {CHECK_BY_ID} from './checks.ts';

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
/**
 * What was measured about one object, and the way to it where that is issues.
 *
 * Some rows name one thing and count another: a field is named, and what is
 * measured about it is how many issues have no value for it. A field has no address
 * of its own, so what a reader wants from "1 of 12494 issues" is those issues - and
 * the number is the thing to click.
 */
const MeasuredCell: React.FunctionComponent<{
  item: FindingItem;
  origin: string | null;
}> = ({item, origin}) => {
  const {detail, query} = item;
  const search = query === undefined ? null : issueSearchUrl(origin, query);
  if (detail === undefined) {
    return <td className="finding__item-detail"/>;
  }
  return (
    <td className="finding__item-detail">
      {search === null ? (
        detail
      ) : (
        <a className="jump" href={search} target="_blank" rel="noreferrer">
          {detail}
        </a>
      )}
    </td>
  );
};

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
      <MeasuredCell item={item} origin={origin}/>
    </tr>
  );
};

/**
 * Said once for a whole column instead of on every row.
 *
 * A glyph on three hundred rows is a wall; one at the head of the column that
 * carries the links says the same thing once.
 */
const NewTabHint: React.FunctionComponent = () => (
  <span className="finding__table-hint">
    <Icon glyph={newWindowGlyph}/>
    {' opens in a new tab'}
  </span>
);

/**
 * The columns of the table, and which of them carries links.
 *
 * Either the name leads somewhere or the number does, never both: a project has an
 * address, a field has not and counts issues instead. The hint belongs to whichever
 * column links, or it promises a link where there is none - which it used to, by
 * asking only whether the report can build links in this instance at all.
 */
const ItemsHead: React.FunctionComponent<{
  finding: Finding;
  origin: string | null;
  marking: boolean;
}> = ({finding, origin, marking}) => {
  const items = finding.items ?? [];
  const named = items.some(
    item => itemUrl(origin, finding.itemKind, item, finding.checkId) !== null,
  );
  const counted = origin !== null && items.some(item => item.query !== undefined);
  return (
    <thead>
      <tr>
        {marking ? <th scope="col">{'Intentional'}</th> : null}
        <th scope="col">
          {itemNoun(finding.itemKind, 1)}
          {named ? <NewTabHint/> : null}
        </th>
        <th scope="col">
          {'What was measured'}
          {counted ? <NewTabHint/> : null}
        </th>
      </tr>
    </thead>
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
  /* Whether the names in this table are links at all. Two kinds are not: an account,
     which is a person, and anything the check found that has no page of its own. The
     hint below said "opens in a new tab" for those as well, because it only asked
     whether the report can build links in this instance - not whether these rows
     carry one. */
  const page = itemKindPage(origin, finding.itemKind);
  return (
    <details className="finding__items">
      <summary>
        {/* The kind of thing the check found, so the closed row already says what
             opening it will show. "Objects" is a word from the code, not from the
             instance. */}
        {`Affected ${itemNoun(finding.itemKind, items.length)} (${items.length})` +
          (markedHere > 0 ? ` - ${markedHere} marked as intentional` : '')}
      </summary>
      {/* Every object, not the first few. The table is behind a click and scrolls,
          and a name that is a way there is only useful if it is actually in the
          list - the exports still cut theirs, since a document has no scrollbar. */}
      <table className="finding__table">
        <ItemsHead
          finding={finding}
          origin={origin}
          marking={onToggleItem !== null}
        />
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
      {/* One link where the rows have no address of their own, and the reason
          beside it: fifteen rows all leading to the same unfiltered list read as
          fifteen ways to fifteen places. */}
      {page === null ? null : (
        <p className="finding__page">
          <a className="jump" href={page} target="_blank" rel="noreferrer">
            {ONE_PAGE_LINK}
            <Icon glyph={newWindowGlyph} className="jump__new-window"/>
          </a>
          <span className="finding__page-note">{ONE_PAGE_NOTE}</span>
        </p>
      )}
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

/**
 * The score arithmetic for one finding, openable.
 *
 * A score nobody can recalculate gets argued with instead of acted on, so every
 * term is available. In words rather than as a formula: "worth 10 points, 60 % of
 * what it measured is affected, so it takes away 6 of those 10". The exact ratio
 * stays in brackets for whoever wants to redo the multiplication.
 */
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
              {`${shareText(ratio)}, with ${markedHere} ` +
                `${itemNoun(finding.itemKind, markedHere)} marked as ` +
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
export type ItemToggle = (checkId: string, item: string, ignored: boolean) => void;

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

export const FindingCard: React.FunctionComponent<FindingCardProps> = ({
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
