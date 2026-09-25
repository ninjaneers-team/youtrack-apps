import React, { useState } from 'react';
import Text from '@jetbrains/ring-ui-built/components/text/text';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { PomodoroState, TimerAction } from '../types/pomodoro';
import { TodoItem } from './TodoItem';

interface TodoSectionProps {
  state: PomodoroState;
  dispatch: React.Dispatch<TimerAction>;
}

export const TodoSection: React.FC<TodoSectionProps> = ({ state, dispatch }) => {
  const [newTodoText, setNewTodoText] = useState('');

  const handleAddTodo = () => {
    if (newTodoText.trim()) {
      dispatch({ type: 'ADD_TODO', payload: { text: newTodoText.trim() } });
      setNewTodoText('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddTodo();
    }
  };

  return (
    <div className="todo-section">
      <Text size={Text.Size.S} style={{ marginBottom: 'calc(var(--ring-unit) / 2)', fontWeight: '500' }}>
        Quick tasks ({state.todos.length})
      </Text>
      
      <div className="todo-list">
        {state.todos.length === 0 ? (
          <Text size={Text.Size.S} style={{ color: 'var(--ring-text-color-secondary)', fontStyle: 'italic', padding: 'calc(var(--ring-unit) / 2)', fontSize: '0.8em' }}>
            No tasks yet. Add one below!
          </Text>
        ) : (
          state.todos.map(todo => (
            <TodoItem key={todo.id} todo={todo} dispatch={dispatch}/>
          ))
        )}
      </div>
      
      <div className="add-todo-form">
        <Input
          placeholder="Add a new task..."
          value={newTodoText}
          onChange={(e) => setNewTodoText(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ flex: 1 }}
        />
        <Button 
          primary
          onClick={handleAddTodo}
          disabled={!newTodoText.trim()}
          style={{ marginLeft: 'calc(var(--ring-unit) / 2)' }}
        >
          Add
        </Button>
      </div>
    </div>
  );
};