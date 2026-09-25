import { useEffect, useCallback, useRef } from 'react';
import { PomodoroState } from '../types/pomodoro';

const debounce = <T extends (...args: any[]) => void>(fn: T, delay: number) => {
  let timeoutId: number;
  const debouncedFn = (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), delay);
  };
  debouncedFn.cancel = () => clearTimeout(timeoutId);
  return debouncedFn;
};

const memoryStorage: { [key: string]: any } = {};

export const useTimerPersistence = (
  state: PomodoroState,
  dispatch: React.Dispatch<any>,
  host: any
) => {
  const currentUserIdRef = useRef<string>('anonymous');
  const fallbackKey = `pomodoro-${currentUserIdRef.current}-${window.location.pathname.replace(/\//g, '-')}`;
  const hasLoadedRef = useRef(false);
  const isInitialMount = useRef(true);

  const loadState = useCallback(async () => {
    if (hasLoadedRef.current) {return;}
    
    try {
      console.log('Loading timer state...');
      
      let cached = null;
      let storageType = 'none';
      
      try {
        if (typeof host.fetchApp === 'function') {
          const response = await host.fetchApp('backend-storage/timer-data', {
            scope: true // Use issue scope - backend will handle user context
          });
          
          if (response && !response.error) {
            if (response.userId) {
              currentUserIdRef.current = response.userId;
            }
            
            cached = response;
            storageType = 'backend-per-user';
            console.log('Loaded timer data from backend for user:', response.userId);
          } else {
            console.warn('Backend response error:', response?.error || 'Unknown error');
          }
        } else {
          console.warn('host.fetchApp not available');
        }
      } catch (apiError) {
        console.warn('Backend fetch failed:', apiError);
      }
      
      const actualFallbackKey = `pomodoro-${currentUserIdRef.current}-${window.location.pathname.replace(/\//g, '-')}`;
      
      if (!cached && memoryStorage[actualFallbackKey]) {
        cached = memoryStorage[actualFallbackKey];
        storageType = 'memory-fallback-per-user';
        console.log('Using memory fallback storage');
      }
      
      if (cached && typeof cached === 'object') {
        const stateData = { ...cached };
        delete stateData.userId;
        
        console.log(`Loaded state from ${storageType}`);
        dispatch({ type: 'LOAD_STATE', payload: stateData });
        hasLoadedRef.current = true;
      } else {
        console.log('No cached state found, using initial state');
        hasLoadedRef.current = true;
      }
    } catch (error) {
      console.warn('Failed to load cached state:', error);
      hasLoadedRef.current = true;
    }
  }, [dispatch, host]);

  const saveState = useCallback(
    debounce(async (stateToSave: PomodoroState) => {
      if (isInitialMount.current) {return;}
      
      try {
        console.log('Saving timer state:', stateToSave);
        
        let saved = false;
        let storageType = 'none';
        
        try {
          if (typeof host.fetchApp === 'function') {
            const response = await host.fetchApp('backend-storage/timer-data', {
              method: 'POST',
              scope: true, // Backend will handle user context automatically
              query: {
                action: 'save',
                data: JSON.stringify(stateToSave)
              }
            });
            
            if (response && response.success) {
              if (response.userId) {
                currentUserIdRef.current = response.userId;
              }
              
              saved = true;
              storageType = 'backend-per-user';
              console.log('Saved timer data to backend');
            } else {
              console.warn('Backend save response error:', response?.error || 'Unknown error');
            }
          } else {
            console.warn('host.fetchApp not available for saving');
          }
        } catch (apiError) {
          console.warn('Backend save failed:', apiError);
        }
        
        if (!saved) {
          const actualFallbackKey = `pomodoro-${currentUserIdRef.current}-${window.location.pathname.replace(/\//g, '-')}`;
          memoryStorage[actualFallbackKey] = stateToSave;
          storageType = 'memory-per-user';
          saved = true;
          console.log('Saved to memory storage as fallback');
        }
        
      } catch (error) {
        console.error('Failed to save state:', error);
        const actualFallbackKey = `pomodoro-${currentUserIdRef.current}-${window.location.pathname.replace(/\//g, '-')}`;
        memoryStorage[actualFallbackKey] = stateToSave;
        console.log('Saved to memory storage as last resort');
      }
    }, 1500),
    [host]
  );

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const timer = setTimeout(() => {
      console.log('Initial mount complete, enabling saves');
      isInitialMount.current = false;
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isInitialMount.current) {
      saveState(state);
    }
    return saveState.cancel;
  }, [state, saveState]);

  return { loadState, saveState };
};