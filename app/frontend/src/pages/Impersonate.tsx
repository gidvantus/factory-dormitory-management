import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import { useSession } from '../auth/SessionProvider';

/** Текст для сети и неожиданного отказа: `detail` сервера важнее общего текста. */
const LOGIN_ERROR = 'Не удалось войти. Попробуйте ещё раз';

/**
 * Страница ссылки входа под пользователем (`/su/:token`).
 *
 * Ссылку выпускает основной API для кабинета оператора, и адрес ведёт сюда:
 * cookie сессии (`crm_session`) ставит ответ `POST /api/auth/impersonate` на
 * этом же origin, поэтому страница только предъявляет токен из адреса и уводит
 * в кабинет. Адрес с токеном в истории не остаётся — переход `replace`: ссылка
 * живёт две минуты, и возврат «назад» на неё бессмысленен и небезопасен.
 *
 * Маршрут стоит вне `RequireAuth`: до запроса посетитель анонимен, а
 * `SessionProvider` уже смонтирован выше маршрутов, поэтому `setUser` доступен
 * сразу, и его стартовый `refresh()` (он вернёт `anonymous`) страницу не ломает.
 *
 * Отказ показывается текстом сервера дословно и ссылкой «На главную»: из этой
 * страницы некуда идти, кроме главной.
 */
export function Impersonate(): JSX.Element {
  const { token = '' } = useParams<{ token?: string }>();
  const { setUser } = useSession();
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (token === '') {
      setError(LOGIN_ERROR);
      return;
    }
    let active = true;
    api.impersonate(token).then(
      (profile) => {
        if (!active) return;
        // Профиль в сессии — из ответа ручки; роль дочитает `SessionProvider`.
        setUser(profile);
        setDone(true);
      },
      (failure: unknown) => {
        if (!active) return;
        setError(failure instanceof ApiError ? failure.message : LOGIN_ERROR);
      },
    );
    return () => {
      active = false;
    };
  }, [token, setUser]);

  if (error !== '') {
    return (
      <div className="activate">
        <div className="activate__card">
          <section className="activate__panel" data-testid="impersonate-page">
            <h1 className="activate__title">Вход в кабинет</h1>
            <p className="alert alert--error" role="alert" data-testid="impersonate-error">
              {error}
            </p>
            <p className="form__switch">
              <Link to="/" data-testid="impersonate-home">
                На главную
              </Link>
            </p>
          </section>
        </div>
      </div>
    );
  }

  if (done) {
    return <Navigate to="/cabinet" replace />;
  }

  return (
    <div className="activate">
      <div className="activate__card">
        <p className="form__note" role="status" data-testid="impersonate-loading">
          Входим в кабинет…
        </p>
      </div>
    </div>
  );
}
