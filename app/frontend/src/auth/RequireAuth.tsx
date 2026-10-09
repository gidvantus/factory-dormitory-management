import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { ACTIVATION_ROUTE } from './activation';
import { useSession } from './SessionProvider';

/**
 * Защищённый маршрут: без валидной сессии отправляет на /login,
 * запоминая, куда пользователь шёл. Сессия есть, но кабинет не активирован —
 * отправляет на /activate: рабочие ручки такому пользователю отвечают 403.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status, user } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <p data-testid="session-loading" role="status">
        Проверяем сессию…
      </p>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (user?.is_active === false) {
    return <Navigate to={ACTIVATION_ROUTE} replace />;
  }

  return <>{children}</>;
}
