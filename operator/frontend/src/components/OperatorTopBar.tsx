import { useNavigate } from 'react-router-dom';

import { logout } from '../api/client';
import { useOperator } from '../auth/operatorContext';

/**
 * Правая часть шапки кабинета после входа: логин оператора и «Выйти».
 *
 * Шапка одна на все экраны (`Screen`), а её содержимое знает, кто вошёл,
 * поэтому живёт здесь, а не в каждой странице. Пустая страница кабинета ушла
 * вместе с задачей #131 — этот блок переехал на список организаций.
 */
export function OperatorTopBar(): JSX.Element {
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
  );
}
