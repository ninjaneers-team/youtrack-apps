export interface TodoItem {
  id: number;
  text: string;
  completed: boolean;
  createdAt: string;
}

export interface PomodoroState {
  currentTime: number; // seconds remaining
  mode: "focus" | "break";
  isRunning: boolean;
  totalFocusTime: number; // cumulative focus time in seconds for this page
  todos: TodoItem[];
  nextTodoId: number;
}

export type TimerAction =
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "RESET" }
  | { type: "TICK" }
  | { type: "TOGGLE_MODE" }
  | { type: "ADD_TODO"; payload: { text: string } }
  | { type: "DELETE_TODO"; payload: { id: number } }
  | { type: "TOGGLE_TODO"; payload: { id: number } }
  | { type: "LOAD_STATE"; payload: Partial<PomodoroState> };

export interface TimerConfig {
  focus: number; // seconds
  break: number; // seconds
}

export const TIMER_CONFIG: TimerConfig = {
  focus: 25 * 60,
  break: 5 * 60,
};
