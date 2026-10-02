import { useNavigate } from 'react-router-dom';

import { useSession } from '../auth/SessionProvider';

export function Cabinet(): JSX.Element {
  const { user, logout } = useSession();
  const navigate = useNavigate();

  async function handleLogout(): Promise<void> {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <section>
      <h1>Личный кабинет</h1>
      <dl>
        <dt>ФИО</dt>
        <dd data-testid="cabinet-full-name">{user?.full_name}</dd>
        <dt>Email</dt>
        <dd data-testid="cabinet-email">{user?.email}</dd>
      </dl>
      <button type="button" data-testid="logout-button" onClick={() => void handleLogout()}>
        Выйти
      </button>
    </section>
  );
}
