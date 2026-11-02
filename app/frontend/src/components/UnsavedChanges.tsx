import { useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';

import { ChangesContext, DISCARD_MESSAGE, useUnloadWarning } from './useUnsavedChanges';

function NavigationGuard({ dirty }: { dirty: boolean }): null {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm(DISCARD_MESSAGE)) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  return null;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }): JSX.Element {
  const [entries, setEntries] = useState<Set<string>>(() => new Set());
  const router = useContext(UNSAFE_DataRouterContext);
  const register = useCallback((id: string, active: boolean) => {
    setEntries((current) => {
      if (current.has(id) === active) return current;
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  useUnloadWarning(entries.size > 0);
  return (
    <ChangesContext.Provider value={register}>
      {router && <NavigationGuard dirty={entries.size > 0} />}
      {children}
    </ChangesContext.Provider>
  );
}
