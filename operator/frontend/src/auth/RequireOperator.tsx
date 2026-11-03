import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';

import { me } from '../api/client';
import { Screen } from '../components/Screen';
import { OperatorContext } from './operatorContext';

type SessionState =
  { status: 'checking' } | { status: 'anonymous' } | { status: 'operator'; username: string };

/**
 * Защищённый маршрут кабинета оператора.
 *
 * При монтировании спрашивает `GET /api/auth/me`. Пока идёт запрос — только
 * строка статуса (ни формы, ни действия в шапке). `401` (и любой другой отказ:
 * сессию проверить не удалось) уводит на `/login`; `200` пускает детей и отдаёт
 * им логин оператора.
 */
export function RequireOperator({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<SessionState>({ status: 'checking' });

  useEffect(() => {
    let active = true;
    me().then(
      (operator) => {
        if (active) setState({ status: 'operator', username: operator.username });
      },
      () => {
        // 401 — нет сессии; сеть или 5xx — сессию тоже не подтвердили, а экран
        // без подтверждения показывать нельзя. Оба случая ведут на форму входа.
        if (active) setState({ status: 'anonymous' });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'checking') {
    return (
      <Screen>
        <main className="login">
          <p className="status" role="status">
            Проверяем сессию…
          </p>
        </main>
      </Screen>
    );
  }

  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }

  return (
    <OperatorContext.Provider value={{ username: state.username }}>
      {children}
    </OperatorContext.Provider>
  );
}
