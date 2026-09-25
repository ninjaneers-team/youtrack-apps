import React from 'react';
import Text from '@jetbrains/ring-ui-built/components/text/text';
import { PomodoroState } from '../types/pomodoro';
import { formatDuration } from '../utils/timeUtils';

interface StatsDisplayProps {
  state: PomodoroState;
}

export const StatsDisplay: React.FC<StatsDisplayProps> = ({ state }) => {
  return (
    <div className="stats-display">
      <div className="stat-item-single">
        <Text size={Text.Size.S} style={{ color: 'var(--ring-text-color)' }}>
          Total Focus Time
        </Text>
        <Text size={Text.Size.M}>
          {formatDuration(state.totalFocusTime)}
        </Text>
      </div>
    </div>
  );
};