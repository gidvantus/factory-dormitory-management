import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError } from '../api/client';
import type { UserProfile } from '../api/client';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface SessionValue {
  status: SessionStatus;
  user: UserProfile | null;
  setUser: (user: UserProfile) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);

  const setAuthenticatedUser = useCallback((profile: UserProfile) => {
    setUser(profile);
    setStatus('authenticated');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const profile = await api.me();
      setUser(profile);
      setStatus('authenticated');
    } catch (error) {
      // 401 — это обычная «нет сессии», а не сбой: любой другой ответ тоже
      // оставляет пользователя неавторизованным, но не ломает экран.
      if (!(error instanceof ApiError)) {
        console.error('Не удалось проверить сессию', error);
      }
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({ status, user, setUser: setAuthenticatedUser, refresh, logout }),
    [status, user, setAuthenticatedUser, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// Провайдер и хук живут в одном модуле: это одна публичная точка входа слоя сессии.
// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession используется вне SessionProvider');
  }
  return value;
}
