import React, { memo, useEffect } from 'react';
import { useTimerState } from './hooks/useTimerState';
import { useTimerPersistence } from './hooks/useTimerPersistence';
import { TimerDisplay } from './components/TimerDisplay';
import { TimerControls } from './components/TimerControls';
import { StatsDisplay } from './components/StatsDisplay';
import { TodoSection } from './components/TodoSection';

// Register widget in YouTrack. To learn more, see https://www.jetbrains.com/help/youtrack/devportal-apps/apps-host-api.html
const host = await YTApp.register();

const AppComponent: React.FunctionComponent = () => {
  const { state, dispatch } = useTimerState();
  
  useEffect(() => {
    console.log('YouTrack host API available:', !!host);
  }, []);
  
  useTimerPersistence(state, dispatch, host);

  return (
    <div className="pomodoro-container">
      <TimerDisplay state={state} dispatch={dispatch}/>
      <TimerControls state={state} dispatch={dispatch}/>
      <StatsDisplay state={state}/>
      <TodoSection state={state} dispatch={dispatch}/>
    </div>
  );
};

export const App = memo(AppComponent);
