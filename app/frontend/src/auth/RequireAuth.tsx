import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useSession } from './SessionProvider';

/**
 * Защищённый маршрут: без валидной сессии отправляет на /login,
 * запоминая, куда пользователь шёл.
 */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useSession();
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

  return <>{children}</>;
}
