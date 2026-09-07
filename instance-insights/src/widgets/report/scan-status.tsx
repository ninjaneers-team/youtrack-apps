/**
 * What the page says while there is no report to show.
 *
 * Three situations, each with its own words: nothing scanned yet, a scan running,
 * and one running somewhere else in the instance. A spinner alone would look like
 * a hang on an instance that takes minutes to read, so the wait names the check it
 * is on, the requests it has sent and the findings that are already in.
 */

import React, {useEffect, useState} from 'react';
import Alert from '@jetbrains/ring-ui-built/components/alert/alert';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Loader from '@jetbrains/ring-ui-built/components/loader/loader';
import ProgressBar from '@jetbrains/ring-ui-built/components/progress-bar/progress-bar';

import {plural} from '../../types.ts';
import type {ScanProgressState} from '../../engine.ts';
import {duration} from '../../report-shared.ts';
import {agoPhrase} from '../../trend.ts';
import type {StateRead} from './scan-state.ts';

/** Milliseconds in the second the elapsed time is counted in. */
const MS_PER_SECOND = 1000;

/**
 * What the scan is doing.
 *
 * On an instance with many projects a single check spends minutes on paced
 * requests, so a bare spinner looks like a hang. Three things make the wait
 * readable: which check is running, how many requests have gone to the instance,
 * and the findings that are already in - plus the way out of the wait.
 */
export const ScanRunning: React.FunctionComponent<{
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
export const ScanElsewhere: React.FunctionComponent<{
  startedAt: string;
  now: Date;
}> = ({startedAt, now}) => (
  <Alert type={Alert.Type.WARNING} inline closeable={false} showWithAnimation={false}>
    {`A scan of this instance started ${agoPhrase(startedAt, now)}, in another ` +
      'window or on a dashboard. Scanning again now would ask the instance ' +
      'everything twice; the result of that scan shows up here after a reload.'}
  </Alert>
);

export const ScanIdle: React.FunctionComponent<{
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
