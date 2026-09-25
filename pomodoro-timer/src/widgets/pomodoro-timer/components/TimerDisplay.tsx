import React from 'react';
import Text from '@jetbrains/ring-ui-built/components/text/text';
import { PomodoroState, TimerAction } from '../types/pomodoro';
import { formatTime } from '../utils/timeUtils';

interface TimerDisplayProps {
  state: PomodoroState;
  dispatch: React.Dispatch<TimerAction>;
}

export const TimerDisplay: React.FC<TimerDisplayProps> = ({ state, dispatch }) => {
  const isCompleted = state.currentTime === 0 && !state.isRunning;
  
  const handleModeSwitch = () => {
    if (!state.isRunning) {
      dispatch({ type: 'TOGGLE_MODE' });
    }
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleModeSwitch();
    }
  };
  
  return (
    <div className={`timer-display ${isCompleted ? 'completed' : ''} ${state.mode}-mode`}>
      <div className="time-and-mode">
        <div className="timer-time">
          {formatTime(state.currentTime)}
        </div>
        <div className="mode-with-switch">
          <Text 
            size={Text.Size.S} 
            className="mode-text"
            style={{ 
              color: state.mode === 'focus' ? 'var(--ring-main-color)' : 'var(--ring-warning-color)',
              fontWeight: '500'
            }}
          >
            {state.mode === 'focus' ? 'Focus' : 'Break'}
          </Text>
          <span
            className={`mode-switch-icon ${state.isRunning ? 'disabled' : ''}`}
            onClick={handleModeSwitch}
            onKeyDown={handleKeyPress}
            tabIndex={state.isRunning ? -1 : 0}
            role="button"
            title={state.isRunning ? 'Cannot switch while timer is running' : `Switch to ${state.mode === 'focus' ? 'Break' : 'Focus'}`}
            aria-label={state.isRunning ? 'Cannot switch while timer is running' : `Switch to ${state.mode === 'focus' ? 'Break' : 'Focus'} mode`}
          >
            ↻
          </span>
        </div>
      </div>
    </div>
  );
};