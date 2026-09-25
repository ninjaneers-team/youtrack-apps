import { useReducer, useEffect, useRef } from 'react';
import { PomodoroState, TimerAction, TIMER_CONFIG } from '../types/pomodoro';

const getInitialState = (): PomodoroState => ({
  currentTime: TIMER_CONFIG.focus,
  mode: 'focus',
  isRunning: false,
  totalFocusTime: 0,
  todos: [],
  nextTodoId: 1,
});

const timerReducer = (state: PomodoroState, action: TimerAction): PomodoroState => {
  switch (action.type) {
    case 'START':
      return { ...state, isRunning: true };
      
    case 'PAUSE':
      return { ...state, isRunning: false };
      
    case 'RESET':
      return {
        ...state,
        currentTime: TIMER_CONFIG[state.mode],
        isRunning: false
      };
      
    case 'TICK':
      if (state.currentTime <= 1) {
        const focusTimeToAdd = state.mode === 'focus' ? TIMER_CONFIG.focus : 0;
        
        return {
          ...state,
          currentTime: 0,
          isRunning: false,
          totalFocusTime: state.totalFocusTime + focusTimeToAdd,
        };
      }
      return { ...state, currentTime: state.currentTime - 1 };
      
    case 'TOGGLE_MODE':
      const newMode = state.mode === 'focus' ? 'break' : 'focus';
      return {
        ...state,
        mode: newMode,
        currentTime: TIMER_CONFIG[newMode],
        isRunning: false
      };
      
    case 'ADD_TODO':
      return {
        ...state,
        todos: [
          ...state.todos,
          {
            id: state.nextTodoId,
            text: action.payload.text,
            completed: false,
            createdAt: new Date().toISOString(),
          }
        ],
        nextTodoId: state.nextTodoId + 1,
      };
      
    case 'DELETE_TODO':
      return {
        ...state,
        todos: state.todos.filter(todo => todo.id !== action.payload.id),
      };
      
    case 'TOGGLE_TODO':
      return {
        ...state,
        todos: state.todos.map(todo =>
          todo.id === action.payload.id
            ? { ...todo, completed: !todo.completed }
            : todo
        ),
      };
      
    case 'LOAD_STATE':
      return { ...state, ...action.payload };
      
    default:
      return state;
  }
};

export const useTimerState = () => {
  const [state, dispatch] = useReducer(timerReducer, getInitialState());
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (state.isRunning && state.currentTime > 0) {
      intervalRef.current = window.setInterval(() => {
        dispatch({ type: 'TICK' });
      }, 1000);
    } else if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [state.isRunning, state.currentTime]);

  return { state, dispatch };
};