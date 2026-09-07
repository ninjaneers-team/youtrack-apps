import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Alert from '@jetbrains/ring-ui-built/components/alert/alert';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
/* JetBrains' own glyph set, the one ring-ui draws with. Each import is a module
   holding an SVG string of a few hundred bytes, so only what is used travels. */
import exportGlyph from '@jetbrains/icons/export';
import fileTextGlyph from '@jetbrains/icons/file-text';
import printerGlyph from '@jetbrains/icons/printer';

import {score} from '../../engine.ts';
import type {IgnoredItems, ScanResult} from '../../engine.ts';
import {CHECKS} from '../../checks/catalog.ts';
import {CATEGORY_LABEL, DEFAULT_CONFIG, plural} from '../../types.ts';
import {
  byImpact,
  instanceOrigin,
  MARKED_SECTION_NOTE,
  NO_FINDINGS_NOTE,
  oneDecimal,
  trendSentence,
  VENDOR
} from '../../report-shared.ts';
import type {ScanFate} from '../../report-shared.ts';

import {createHostClient} from '../../host-client.ts';
import {startScan as startSession, uploadOf} from '../../scan-session.ts';
import type {ScanCost, ScanHandle} from '../../scan-session.ts';
import {createAppStateClient, itemsByCheck} from '../../app-state.ts';
import type {IgnoredState, ScanAggregate} from '../../app-state.ts';
import {compareScans, daysSince, scanUnderWay, trendFrom} from '../../trend.ts';

import {FINDINGS_ANCHOR, findingsAnchor} from './anchors.ts';
import {FindingCard} from './finding.tsx';
import {restoredScan} from './scan-state.ts';
import type {ScanState, StateRead} from './scan-state.ts';
import {ScanElsewhere, ScanIdle, ScanRunning} from './scan-status.tsx';
import {Categories, NotRun, ScoreHeader, SeverityLegend} from './score.tsx';
import {TrendSection} from './trend.tsx';

// Register the widget with YouTrack. The Host API runs REST calls with the
// permissions of the user viewing the widget - no token, no base URL.
const host = await YTApp.register();
const appState = createAppStateClient(host);

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

/**
 * Where the score moved, as the one sentence both exports carry.
 *
 * The same wording as the page, so a reader who has seen the report recognises the
 * line in the file - and nothing when there is only one scan to go on.
 */
function trendLineOf(history: readonly ScanAggregate[], now: Date): string | undefined {
  const trend = trendFrom(history);
  const newest = trend.points[trend.points.length - 1];
  return newest ? trendSentence(trend, daysSince(newest.at, now)) : undefined;
}

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
      <a href={VENDOR.url} target="_blank" rel="noreferrer noopener">
        {VENDOR.name}
      </a>
      {`. ${VENDOR.invitation} - `}
      <a href={`mailto:${VENDOR.email}?subject=${encodeURIComponent(subject)}`}>
        {VENDOR.email}
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
          <p>{NO_FINDINGS_NOTE}</p>
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
          <p className="findings__note">{MARKED_SECTION_NOTE}</p>
          {/* Strongest first, as in the section above and in both exports. */}
          {byImpact(result.ignoredFindings).map(f => (
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
          trendLine: trendLineOf(history, openedAt),
          comparison: compareScans(history),
          instanceUrl: origin ?? undefined,
          markedItems
        })
      );
    }
  }, [result, state, history, openedAt, origin, markedItems]);

  // Both exports carry the trend as the sentence shown on screen; a number without
  // its direction is worth less in a budget conversation.
  const exportPrint = useCallback(async () => {
    if (result && state.phase === 'done') {
      const print = await renderer(import('../../report-print.ts'));
      if (print === null) {
        return;
      }
      printReport(
        print.reportToPrintHtml({
          result,
          checks: CHECKS,
          at: state.at,
          stopped: state.stopped,
          instanceUrl: origin ?? undefined,
          markedItems,
          trendLine: trendLineOf(history, openedAt),
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
