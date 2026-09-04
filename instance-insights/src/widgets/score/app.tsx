import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Loader from '@jetbrains/ring-ui-built/components/loader/loader';

import type {IgnoredItems} from '../../engine.ts';
import {CHECKS} from '../../checks/catalog.ts';
import {DEFAULT_CONFIG, plural} from '../../types.ts';

import {createHostClient} from '../../host-client.ts';
import {createAppStateClient, itemsByCheck} from '../../app-state.ts';
import type {ScanAggregate} from '../../app-state.ts';
import {startScan as startSession} from '../../scan-session.ts';
import type {ScanHandle} from '../../scan-session.ts';
import {agoPhrase, scanUnderWay, scoreBeforeDecisions, trendFrom} from '../../trend.ts';
import {dateText, oneDecimal, scoreText} from '../../report-shared.ts';

/**
 * Dashboard tile. Shows the score of the last scan and can start a new one.
 *
 * The score comes from the app's global storage, not from this widget's own cache,
 * so a scan started on the report page shows up here too. Reopening reads the
 * stored aggregates instead of scanning again.
 */

const host = await YTApp.register();
const appState = createAppStateClient(host);

type State =
  | {phase: 'loading'}
  /** `sent` is the number of requests the running scan has sent to the instance. */
  | {phase: 'running'; sent: number}
  | {phase: 'ready'}
  /**
   * The app's own storage did not answer.
   *
   * Not the same as "no scan has run yet", and it must not look like it: the score
   * and the standing decisions both live there, and a scan started without them
   * would store a score that ignores what an administrator decided.
   */
  | {phase: 'unreadable'}
  | {phase: 'error'; message: string};

/**
 * Movement against the previous scan, or nothing at all before there is one.
 *
 * Measured against measured: a score that rose because findings were marked as
 * intentional says nothing about the instance, and this line is about the instance.
 */
function deltaLabel(delta: number | null): string {
  if (delta === null) {
    return '';
  }
  if (oneDecimal(delta) === 0) {
    return ' - unchanged';
  }
  return delta > 0 ? ` - up ${oneDecimal(delta)}` : ` - down ${oneDecimal(-delta)}`;
}

/**
 * A tile placed before this layout existed keeps its stored height, which can be as
 * little as 104 px, so the content is built to fit that: score and estimate on one
 * line, date and action on the next. Newly placed tiles get more room from the
 * manifest and simply have air left over.
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
          change in the instance. The tile has one line for it, so it is the number
          rather than the sentence the report carries - and set in the quieter
          colour, because it belongs to the score above it rather than to the
          count beside it. */}
        {/* The difference, not a second score: "67.8 as measured" needs a sentence
            to mean anything, and a tile has one line. */}
        {onDecisions === 0 ? null : (
          <span className="score-tile__measured">
            {`, ${scoreText(onDecisions)} marked as intentional`}
          </span>
        )}
      </p>
    </div>
  );
};

const ScoreFoot: React.FunctionComponent<{
  lastScan: ScanAggregate;
  delta: number | null;
  onScan: () => void;
}> = ({lastScan, delta, onScan}) => (
  <div className="score-tile__foot">
    <p className="score-tile__at">
      {`As of ${dateText(new Date(lastScan.at))}`}
      {deltaLabel(delta)}
    </p>
    {/* Not "Refresh": a scan asks the instance a few hundred questions, and the
        report page calls the same action by the same name. */}
    <Button primary onClick={onScan}>{'Scan again'}</Button>
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
  onScan: () => void;
}> = ({history, scanElsewhere, now, onScan}) => {
  const lastScan = history[0] ?? null;
  const elsewhere =
    scanElsewhere === null ? null : <ScanElsewhere startedAt={scanElsewhere} now={now}/>;
  const {measuredDelta} = trendFrom(history);
  if (!lastScan) {
    return (
      <div className="score-tile">
        <p className="score-tile__empty">{'No scan has run yet.'}</p>
        {elsewhere}
        <Button primary onClick={onScan}>{'Start scan'}</Button>
      </div>
    );
  }
  return (
    <div className="score-tile">
      <ScoreView lastScan={lastScan}/>
      {elsewhere}
      <ScoreFoot lastScan={lastScan} delta={measuredDelta} onScan={onScan}/>
    </div>
  );
};

const AppComponent: React.FunctionComponent = () => {
  const [state, setState] = useState<State>({phase: 'loading'});
  // Kept next to the phase so a stopped scan can leave the last score standing.
  const [history, setHistory] = useState<ScanAggregate[]>([]);
  const running = useRef<ScanHandle | null>(null);
  const stopScan = useCallback(() => running.current?.stop(), []);
  /** When a scan the report page started was started, or null when none was. */
  const [scanElsewhere, setScanElsewhere] = useState<string | null>(null);
  // Fixed at mount, like the age of the last scan: a tile sits open for hours.
  const openedAt = useMemo(() => new Date(), []);
  /* What the instance has decided is not shown on the tile, only applied by it, so
     it stays out of the render and in a ref. */
  const decisions = useRef<{checks: ReadonlySet<string>; items: IgnoredItems}>({
    checks: new Set(),
    items: new Map()
  });

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
        decisions.current = {
          checks: new Set(stored.ignoredChecks),
          items: itemsByCheck(stored.ignoredItems)
        };
        setScanElsewhere(
          scanUnderWay(stored.scanStarted, stored.lastScan?.at, openedAt, stored.lastRun?.seconds)
        );
        setState({phase: 'ready'});
      })
      .catch(() => setState({phase: 'unreadable'}));
    // `openedAt` is the moment this tile opened and never changes after it.
  }, [reads, openedAt]);

  const runScanNow = useCallback(async () => {
    // This tile is the one scanning now, whatever it read when it opened.
    setScanElsewhere(null);
    const startedAt = new Date();
    /* A tile has no room for a progress bar, and a scan of a large instance takes
       minutes, so the request count is what shows it is alive. Said before the scan
       starts, because the first count arrives while it is starting. */
    setState({phase: 'running', sent: 0});
    const handle = startSession({
      checks: CHECKS,
      config: DEFAULT_CONFIG,
      store: appState,
      client: hooks => createHostClient(host, hooks),
      /* With the standing decisions, or a scan started here would store a score
         the report page contradicts: what an administrator marked as intentional
         holds for every scan, whichever widget starts it. */
      decisions: decisions.current,
      /* True by construction: a tile whose storage did not answer shows what that
         means and an invitation to read again, not a button that scans. */
      stateRead: true,
      startedAt,
      onRequest: sent =>
        setState(prev => (prev.phase === 'running' ? {phase: 'running', sent} : prev))
    });
    running.current = handle;
    try {
      const run = await handle.done;
      if (run.history !== null) {
        setHistory(run.history);
      }
      // Part of an instance has no score worth storing, and the findings of a
      // partial scan belong on the report page, not on a tile.
      setState({phase: 'ready'});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({phase: 'error', message});
    }
  }, []);

  if (state.phase === 'loading') {
    return (
      <div className="score-tile score-tile--center">
        <Loader/>
      </div>
    );
  }

  if (state.phase === 'running') {
    return (
      <div className="score-tile">
        <p className="score-tile__empty">
          {`Scanning... ${plural(state.sent, 'request')}`}
        </p>
        <Button onClick={stopScan}>{'Stop'}</Button>
      </div>
    );
  }

  if (state.phase === 'unreadable') {
    return (
      <div className="score-tile">
        <p className="score-tile__error">
          {'The stored score could not be read. It needs permission to manage ' +
            'apps in this instance.'}
        </p>
        <Button onClick={readAgain}>{'Try again'}</Button>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="score-tile">
        <p className="score-tile__error">{`Scan failed: ${state.message}`}</p>
        <Button onClick={runScanNow}>{'Try again'}</Button>
      </div>
    );
  }

  return (
    <ReadyTile
      history={history}
      scanElsewhere={scanElsewhere}
      now={openedAt}
      onScan={runScanNow}
    />
  );
};

export const App = memo(AppComponent);
