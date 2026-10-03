import { useNavigate } from 'react-router-dom';

import { SiteHeader } from '../components/SiteHeader';
import { useSession } from '../auth/SessionProvider';

/** Личный кабинет: только ФИО и email, которые пользователь вводил сам. */
export function Cabinet(): JSX.Element {
  const { user, logout } = useSession();
  const navigate = useNavigate();

  async function handleLogout(): Promise<void> {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app" data-testid="cabinet-page">
      <SiteHeader />
      <main className="container cabinet">
        <section className="card cabinet__card">
          <p className="eyebrow">Личный кабинет</p>
          <h1 className="cabinet__title">Ваши данные</h1>

          <dl className="profile">
            <div className="profile__row">
              <dt>ФИО</dt>
              <dd data-testid="cabinet-full-name">{user?.full_name}</dd>
            </div>
            <div className="profile__row">
              <dt>Email</dt>
              <dd data-testid="cabinet-email">{user?.email}</dd>
            </div>
          </dl>

          <p className="form__note">
            Пароль выдал сервер при регистрации. В открытом виде он нигде не хранится и повторно не
            показывается.
          </p>

          <div className="cabinet__actions">
            <button
              className="btn btn--outline"
              type="button"
              data-testid="logout-button"
              onClick={() => void handleLogout()}
            >
              Выйти
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
