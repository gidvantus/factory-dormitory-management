import { useNavigate } from 'react-router-dom';

import { useSession } from '../auth/SessionProvider';

interface SiteActionsProps {
  /** Открыть вход. По умолчанию — переход на `/login`, где окно открывает главная. */
  onLogin?: () => void;
  /** Открыть регистрацию. По умолчанию — переход на `/register`. */
  onRegister?: () => void;
}

/**
 * Кнопки шапки публичных страниц: анониму — вход и регистрация, вошедшему —
 * личный кабинет. Состояние берётся из сессии, а не из пропса «авторизован»,
 * поэтому шапка одинаково ведёт себя на главной и на странице тарифов.
 *
 * Страница сама решает, что делает нажатие: главная уводит на `/login`, где
 * окно входа открывается по адресу, а `/pricing` показывает окно у себя.
 */
export function SiteActions({ onLogin, onRegister }: SiteActionsProps): JSX.Element {
  const { status } = useSession();
  const navigate = useNavigate();

  if (status === 'authenticated') {
    return (
      <button
        className="btn btn--ink btn--sm"
        type="button"
        data-testid="nav-cabinet"
        onClick={() => navigate('/cabinet')}
      >
        Личный кабинет
      </button>
    );
  }

  return (
    <>
      <button
        className="btn btn--outline btn--sm"
        type="button"
        data-testid="nav-login"
        onClick={onLogin ?? (() => navigate('/login'))}
      >
        Войти
      </button>
      <button
        className="btn btn--primary btn--sm"
        type="button"
        data-testid="nav-register"
        onClick={onRegister ?? (() => navigate('/register'))}
      >
        Регистрация
      </button>
    </>
  );
}
