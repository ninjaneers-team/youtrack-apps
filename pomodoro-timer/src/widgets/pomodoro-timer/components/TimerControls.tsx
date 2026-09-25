import React from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { PomodoroState, TimerAction } from '../types/pomodoro';

interface TimerControlsProps {
  state: PomodoroState;
  dispatch: React.Dispatch<TimerAction>;
}

export const TimerControls: React.FC<TimerControlsProps> = ({ state, dispatch }) => {
  const handleStartPause = () => {
    if (state.isRunning) {
      dispatch({ type: 'PAUSE' });
    } else {
      dispatch({ type: 'START' });
    }
  };

  const handleReset = () => {
    dispatch({ type: 'RESET' });
  };

  return (
    <div className="timer-controls">
      <Button 
        primary 
        onClick={handleStartPause}
        disabled={state.currentTime === 0}
      >
        {state.isRunning ? 'Pause' : 'Start'}
      </Button>
      
      <Button 
        onClick={handleReset}
        disabled={state.isRunning}
      >
        Reset
      </Button>
    </div>
  );
};