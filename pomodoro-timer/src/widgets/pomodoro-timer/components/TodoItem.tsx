import React from 'react';
import Text from '@jetbrains/ring-ui-built/components/text/text';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { TodoItem as TodoItemType, TimerAction } from '../types/pomodoro';

interface TodoItemProps {
  todo: TodoItemType;
  dispatch: React.Dispatch<TimerAction>;
}

export const TodoItem: React.FC<TodoItemProps> = ({ todo, dispatch }) => {
  const handleToggle = () => {
    dispatch({ type: 'TOGGLE_TODO', payload: { id: todo.id } });
  };

  const handleDelete = () => {
    dispatch({ type: 'DELETE_TODO', payload: { id: todo.id } });
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    }
  };

  return (
    <div className="todo-item">
      <button
        type="button"
        className="todo-content"
        onClick={handleToggle}
        onKeyDown={handleKeyPress}
        style={{ cursor: 'pointer', flex: 1, border: 'none', background: 'none', padding: 0, textAlign: 'left' }}
        aria-label={`${todo.completed ? 'Mark as incomplete' : 'Mark as complete'}: ${todo.text}`}
      >
        <Text 
          size={Text.Size.M} 
          style={{ 
            textDecoration: todo.completed ? 'line-through' : 'none',
            color: todo.completed ? 'var(--ring-text-color-secondary)' : 'var(--ring-text-color)'
          }}
        >
          {todo.completed ? '✓' : '○'} {todo.text}
        </Text>
      </button>
      <Button 
        inline
        ghost
        danger
        onClick={handleDelete}
        className="delete-button"
        style={{ marginLeft: 'calc(var(--ring-unit) / 2)' }}
        aria-label={`Delete todo: ${todo.text}`}
      >
        ×
      </Button>
    </div>
  );
};