import { useNavigate } from 'react-router-dom';

import { logout } from '../api/client';
import { useOperator } from '../auth/operatorContext';
import { Screen } from '../components/Screen';

/**
 * Пустая страница кабинета после входа.
 *
 * Разделов и данных в этой задаче нет: в шапке бренд, логин оператора и
 * «Выйти», в теле — блок, который объясняет пустоту словами, чтобы экран не
 * читался как недоделанный.
 */
export function Home(): JSX.Element {
  const operator = useOperator();
  const navigate = useNavigate();

  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } catch {
      // Без сессии сервер всё равно отвечает 204; сетевой отказ — не повод
      // оставлять оператора на экране кабинета, поэтому выход идёт на форму.
    }
    navigate('/login', { replace: true });
  }

  return (
    <Screen
      right={
        <div className="topbar__right">
          <span className="account" title="Логин, под которым открыт кабинет">
            {operator.username}
          </span>
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            onClick={handleLogout}
            data-testid="operator-logout"
          >
            Выйти
          </button>
        </div>
      }
    >
      <main className="screen__main" data-testid="operator-home">
        <div className="empty">
          <span className="empty__icon" aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="7.5" cy="7.5" r="4" />
              <path d="M10.4 10.4 20 20M17.5 17.5l2-2M14.5 14.5l2-2" />
            </svg>
          </span>
          <h2>Данных пока нет</h2>
          <p>
            Обмен с основным кабинетом ещё не подключён — кабинет оператора пока умеет только вход.
            Разделы появятся, когда обмен включат.
          </p>
        </div>
      </main>
    </Screen>
  );
}
