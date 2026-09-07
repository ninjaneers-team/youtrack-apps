/**
 * The scores of earlier scans, and what moved between the last two.
 *
 * This is what makes the app a recurring appointment rather than a one-off
 * diagnosis. A stored scan keeps a number per check, not its finding, so this
 * section works from aggregates alone.
 */

import React, {useMemo} from 'react';

import {plural} from '../../types.ts';
import {
  agePhrase,
  compareScans,
  daysSince,
  scoreBeforeDecisions,
  sparkline,
  trendFrom
} from '../../trend.ts';
import type {CheckChange, ScanAggregate, Trend} from '../../trend.ts';
import {
  MOVEMENT_LABEL,
  movementDetail,
  noMeasurementPhrase,
  nothingMovedNote,
  oneDecimal,
  scoreText,
  shareText,
  trendSentence
} from '../../report-shared.ts';
import {CHECK_BY_ID} from './checks.ts';

/** Sparkline box in CSS pixels. Small enough to sit next to the score. */
const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 56;

/** ISO date without the time, which is the resolution a trend is read at. */
function dayOf(iso: string): string {
  return iso.slice(0, 'YYYY-MM-DD'.length);
}

/** How many movements the section lists before it stops naming them. */
const MOVED_SHOWN = 6;

/** A check and its two shares, for a line that names the kind beside it. */
function movedText(change: CheckChange): string {
  const title = CHECK_BY_ID.get(change.id)?.title ?? change.id;
  return `${title} - ${movementDetail(change)}`;
}

/**
 * The same line where nothing beside it names the kind.
 *
 * The list above every movement puts the kind in its own column; a collapsed list
 * has no column, so the line carries it - but only where the two shares do not say
 * it themselves. Both at once read as a stutter: "not measured Required fields
 * without a value - not measured, was 0 %".
 */
function changeText(change: CheckChange): string {
  const named: readonly CheckChange['kind'][] = ['new', 'resolved', 'unmeasured'];
  const kind = named.includes(change.kind) ? `${MOVEMENT_LABEL[change.kind]}, ` : '';
  const title = CHECK_BY_ID.get(change.id)?.title ?? change.id;
  return `${title} - ${kind}${movementDetail(change)}`;
}

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

/**
 * What moved between the two newest scans.
 *
 * A trend that only shows a line invites the one question it cannot answer: what
 * changed? Per-check ratios are aggregates, so they are stored, and this is what
 * they buy - the sentence that says whether the work paid off.
 */
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
          summary={nothingMovedNote(unchanged.length)}
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
              {movedText(change)}
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
export const TrendSection: React.FunctionComponent<{
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
