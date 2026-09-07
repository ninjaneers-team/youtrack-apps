import React, {memo, useCallback, useEffect, useMemo, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Icon from '@jetbrains/ring-ui-built/components/icon/icon';
import Loader from '@jetbrains/ring-ui-built/components/loader/loader';
import newWindowGlyph from '@jetbrains/icons/new-window';

import {plural} from '../../types.ts';

import {createAppStateClient} from '../../app-state.ts';
import type {ScanAggregate} from '../../app-state.ts';
import {agoPhrase, scanUnderWay, scoreBeforeDecisions, trendFrom} from '../../trend.ts';
import {
  dateText,
  instanceOrigin,
  movementPhrase,
  oneDecimal,
  reportPageUrl,
  scoreText
} from '../../report-shared.ts';

/**
 * Dashboard tile. Shows the score of the last scan and leads to the report.
 *
 * The score comes from the app's global storage, not from this widget's own cache,
 * so a scan started on the report page shows up here too. Reopening reads the
 * stored aggregates rather than measuring anything.
 *
 * A scan cannot be started from here, and that is deliberate. It is a job in the
 * foreground of whichever tab holds it - a few hundred requests on a small instance
 * and a few thousand on a large one, measured at five and a half minutes for three
 * hundred - and a dashboard is the page a reader leaves first. Left, it dies, and
 * everything it asked the instance was asked for nothing. A tile also has no room
 * to show what a job of that length is doing. So the scan lives on the report page,
 * where somebody is watching it, and the tile leads there.
 */

const host = await YTApp.register();
const appState = createAppStateClient(host);

type State =
  | {phase: 'loading'}
  | {phase: 'ready'}
  /**
   * The app's own storage did not answer.
   *
   * Not the same as "no scan has run yet", and it must not look like it: one is a
   * tile that has nothing to show yet, the other a tile that cannot see.
   */
  | {phase: 'unreadable'};

/**
 * Movement against the previous scan, or nothing at all before there is one.
 *
 * Measured against measured: a score that rose because findings were marked as
 * intentional says nothing about the instance, and this line is about the instance.
 * The wording is the report's, so the tile and the page name a movement the same
 * way - and it carries the unit, which a bare "up 2.3" beside a date does not.
 */
function deltaLabel(delta: number | null): string {
  return delta === null ? '' : ` - ${movementPhrase(delta)}`;
}

/**
 * A tile placed before this layout existed keeps its stored height, which can be as
 * little as 104 px, so the content is built to fit that: the score and what it is
 * out of on one line, the count below it, date and action on the next. Newly placed
 * tiles get more room from the manifest and simply have air left over.
 */
const ScoreView: React.FunctionComponent<{lastScan: ScanAggregate}> = ({
  lastScan
}) => {
  const measured = scoreBeforeDecisions(lastScan);
  const onDecisions =
    measured === null || lastScan.score === null
      ? 0
      : oneDecimal(lastScan.score - measured);
  return (
    <div className="score-tile__figures">
      <div className="score-tile__value">
        {lastScan.score === null ? 'n/a' : scoreText(lastScan.score)}
        {/* In words rather than as a slash: a maximum in small print beside the
            figure is read as decoration, and then nothing on the tile says which
            direction on this scale is the good one. */}
        <span className="score-tile__max">{' out of 100'}</span>
      </div>
      <p className="score-tile__offer">
        {plural(lastScan.findings, 'finding')}
        {/* A tile that only shows the raised score sends its reader looking for a
            change in the instance. The difference rather than a second score:
            "67.8 as measured" needs a sentence to mean anything and a tile has one
            line - and the unit is named, or the figure reads as half a finding
            beside the count in front of it. Set in the quieter colour, because it
            belongs to the score above rather than to that count. */}
        {onDecisions === 0 ? null : (
          <span className="score-tile__measured">
            {`, ${scoreText(onDecisions)} points rest on a decision`}
          </span>
        )}
      </p>
    </div>
  );
};

/**
 * The way to the report, or a sentence where a link cannot be built.
 *
 * What the reader gains rather than where it goes: the report is where the findings
 * behind this number are, and where a new scan is started. A tab of its own, so a
 * dashboard nobody asked to leave stays open - said with the glyph the instance
 * uses for it, since a link that replaces the page it was clicked on is the one
 * surprise a tile can spring.
 */
const ToReport: React.FunctionComponent<{href: string | null; label: string}> = ({
  href,
  label
}) =>
  href === null ? (
    <p className="score-tile__at">
      {'Open Instance Insights from the main menu for the findings behind this.'}
    </p>
  ) : (
    <Button primary href={href} target="_blank" rel="noreferrer">
      {label}
      <Icon glyph={newWindowGlyph} className="score-tile__new-window"/>
    </Button>
  );

const ScoreFoot: React.FunctionComponent<{
  lastScan: ScanAggregate;
  delta: number | null;
  reportHref: string | null;
}> = ({lastScan, delta, reportHref}) => (
  <div className="score-tile__foot">
    <p className="score-tile__at">
      {`As of ${dateText(new Date(lastScan.at))}`}
      {deltaLabel(delta)}
    </p>
    <ToReport href={reportHref} label={'Findings and a new scan'}/>
  </div>
);

/**
 * That a scan is already under way, in the words a tile has room for.
 *
 * The reason it matters - two scans ask the instance everything twice - is on the
 * report page, where there is room for it. Here the fact and its age are enough to
 * hold a second click back.
 */
const ScanElsewhere: React.FunctionComponent<{startedAt: string; now: Date}> = ({
  startedAt,
  now
}) => (
  <p className="score-tile__at">
    {`A scan started ${agoPhrase(startedAt, now)}, somewhere else in this instance.`}
  </p>
);

const ReadyTile: React.FunctionComponent<{
  history: ScanAggregate[];
  scanElsewhere: string | null;
  now: Date;
  reportHref: string | null;
}> = ({history, scanElsewhere, now, reportHref}) => {
  const lastScan = history[0] ?? null;
  const elsewhere =
    scanElsewhere === null ? null : <ScanElsewhere startedAt={scanElsewhere} now={now}/>;
  const {measuredDelta} = trendFrom(history);
  if (!lastScan) {
    return (
      <div className="score-tile">
        <p className="score-tile__empty">{'No scan has run yet.'}</p>
        {elsewhere}
        <ToReport href={reportHref} label={'Open Instance Insights'}/>
      </div>
    );
  }
  return (
    <div className="score-tile">
      <ScoreView lastScan={lastScan}/>
      {elsewhere}
      <ScoreFoot lastScan={lastScan} delta={measuredDelta} reportHref={reportHref}/>
    </div>
  );
};

const AppComponent: React.FunctionComponent = () => {
  const [state, setState] = useState<State>({phase: 'loading'});
  const [history, setHistory] = useState<ScanAggregate[]>([]);
  /** When a scan somebody else started was started, or null when none was. */
  const [scanElsewhere, setScanElsewhere] = useState<string | null>(null);
  /* The way to the report page, once the instance behind this tile is established.
     Null in the development entry, where the page is served by a dev server and a
     link into it would lead nowhere. */
  const [reportHref, setReportHref] = useState<string | null>(null);
  // Fixed at mount, like the age of the last scan: a tile sits open for hours.
  const openedAt = useMemo(() => new Date(), []);

  /* Bumped to read the state again: the failure is usually a blip, and a tile that
     can only be fixed by reloading the whole dashboard is a tile nobody fixes. */
  const [reads, setReads] = useState(0);
  const readAgain = useCallback(() => {
    setState({phase: 'loading'});
    setReads(count => count + 1);
  }, []);

  useEffect(() => {
    appState
      .read()
      .then(stored => {
        setHistory(stored.history);
        setReportHref(reportPageUrl(instanceOrigin(stored.host, document.baseURI)));
        setScanElsewhere(
          scanUnderWay(stored.scanStarted, stored.lastScan?.at, openedAt, stored.lastRun?.seconds)
        );
        setState({phase: 'ready'});
      })
      .catch(() => setState({phase: 'unreadable'}));
    // `openedAt` is the moment this tile opened and never changes after it.
  }, [reads, openedAt]);

  if (state.phase === 'loading') {
    return (
      <div className="score-tile score-tile--center">
        <Loader/>
      </div>
    );
  }

  if (state.phase === 'unreadable') {
    return (
      <div className="score-tile">
        <p className="score-tile__error">
          {'The stored score could not be read. Reading it needs permission to ' +
            'manage apps in this instance.'}
        </p>
        <Button onClick={readAgain}>{'Try again'}</Button>
      </div>
    );
  }

  return (
    <ReadyTile
      history={history}
      scanElsewhere={scanElsewhere}
      now={openedAt}
      reportHref={reportHref}
    />
  );
};

export const App = memo(AppComponent);
