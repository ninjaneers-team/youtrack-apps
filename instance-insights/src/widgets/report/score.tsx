/**
 * The score, and where its points went.
 *
 * The ring and the category table are two views of one hundred points: the ring
 * says how many are left, the table says which area lost the rest. The checks that
 * came back without a number are here as well, since they are the reason the
 * hundred is divided the way it is.
 */

import React from 'react';

import type {CategoryScore, CheckOutcome, IgnoredItems, ScanResult} from '../../engine.ts';
import {CATEGORY_LABEL, plural, SEVERITY_FROM} from '../../types.ts';
import type {Severity} from '../../types.ts';
import type {ScanCost} from '../../scan-session.ts';
import {
  andList,
  categoryPoints,
  CATEGORY_WEIGHTS_NOTE,
  decisionEffect,
  decisionSentence,
  duration,
  NO_MEASUREMENT_HEADING,
  NO_MEASUREMENT_NOTE,
  noMeasurementByCategory,
  oneDecimal,
  percent,
  scanFateNote,
  SCORE_METHOD,
  scoreText,
  SEVERITY_LABEL,
  timestampText,
  WEIGHT_REASON,
  unmeasuredIn,
  withoutMeasurement
} from '../../report-shared.ts';
import type {ScanFate} from '../../report-shared.ts';
import {FINDINGS_ANCHOR, findingsAnchor, NOT_RUN_ANCHOR, notRunAnchor} from './anchors.ts';
import {CHECK_BY_ID} from './checks.ts';

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
        {/* Both a dash: the name of the row says how many of its checks came back
            without a number, and saying it again here made one statement read as
            two. */}
        <td className="categories__score">{'-'}</td>
        <td className="categories__terms">{'-'}</td>
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

export const SeverityLegend: React.FunctionComponent = () => (
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

export const ScoreHeader: React.FunctionComponent<{
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
 * The name of a category, as a jump to what happened in it.
 *
 * The table answers "where did the points go" and the findings answer "why", two
 * screens apart with nothing between them but this jump. A category that scored
 * nothing is the other case: its row carries a dash and "nothing measured here",
 * which says that it was not measured but not why - and the reason is a sentence,
 * too long for a cell and already written out at the end of the report. So the row
 * says how many of its checks came back without a number and leads there. A
 * category that ran and simply found nothing has nowhere to go, so it stays plain
 * text rather than becoming a control that does nothing.
 */
const CategoryName: React.FunctionComponent<{
  category: CategoryScore;
  unmeasured: number;
}> = ({category, unmeasured}) => {
  const label = CATEGORY_LABEL[category.category];
  if (category.score === null) {
    return unmeasured === 0 ? (
      <span className="categories__plain">{label}</span>
    ) : (
      <SectionJump anchor={notRunAnchor(category.category)}>
        {`${label} (${plural(unmeasured, 'check')} without a measurement)`}
      </SectionJump>
    );
  }
  if (category.findings.length === 0) {
    return <span className="categories__plain">{label}</span>;
  }
  return (
    <SectionJump anchor={findingsAnchor(category.category)}>
      {`${label} (${plural(category.findings.length, 'finding')})`}
    </SectionJump>
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
export const Categories: React.FunctionComponent<{
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
              <CategoryName category={c} unmeasured={unmeasuredIn(result, c.category)}/>
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
export const NotRun: React.FunctionComponent<{outcomes: CheckOutcome[]}> = ({outcomes}) => {
  const notRun = withoutMeasurement(outcomes);
  if (notRun.length === 0) {
    return null;
  }
  return (
    <section className="not-run">
      <h2 id={NOT_RUN_ANCHOR}>{`${NO_MEASUREMENT_HEADING} (${notRun.length})`}</h2>
      <p className="not-run__note">{NO_MEASUREMENT_NOTE}</p>
      {/* By category, like the findings above, so the table of points can lead into
          this section the same way it leads into those - to a heading with the
          reader's own category on it. */}
      {noMeasurementByCategory(outcomes, id => CHECK_BY_ID.get(id)?.title ?? id).map(
        ({category, groups}) => (
          <div key={category} className="not-run__group">
            <h3 className="not-run__group-title" id={notRunAnchor(category)}>
              {CATEGORY_LABEL[category]}
            </h3>
            <ul className="not-run__list">
              {groups.map(group => (
                <li key={group.phrase}>
                  {`${andList(group.titles)} - `}
                  {group.phrase}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </section>
  );
};
