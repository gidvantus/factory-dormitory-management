import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FormEvent } from 'react';

import { ApiError, login } from '../api/client';
import { Screen } from '../components/Screen';

/** Текст для сети и `5xx`: контракт разрешает только эту формулировку. */
const FAILED_TO_LOGIN = 'Не удалось войти. Попробуйте ещё раз';

interface FieldErrors {
  username?: string;
  password?: string;
}

/**
 * Текст ошибки входа.
 *
 * `401` — это контракт: сервер прислал `detail`, и экран обязан показать его
 * дословно, без переписывания («Неверный логин или пароль»). Всё остальное —
 * сеть, `5xx`, неожиданный `422` — не текст для пользователя, поэтому одна
 * честная фраза вместо кода ответа.
 */
function loginErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return error.message;
  }
  return FAILED_TO_LOGIN;
}

/**
 * Экран входа: логин и пароль из конфига.
 *
 * Пустые поля ловятся на клиенте и запрос не отправляют; ответ сервера
 * показывается дословно над кнопкой; на отправке кнопка неактивна и говорит
 * «Вход…», а введённые значения остаются в полях.
 */
export function Login(): JSX.Element {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Отказ сервера касается пары целиком: логин и пароль подсвечиваются оба,
  // потому что сервер намеренно не говорит, что именно неверно.
  const rejectedByServer = error !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const next: FieldErrors = {};
    if (username.trim() === '') next.username = 'Укажите логин';
    if (password === '') next.password = 'Укажите пароль';
    setFieldErrors(next);
    setError(null);
    if (next.username !== undefined || next.password !== undefined) {
      return;
    }

    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (caught) {
      setError(loginErrorText(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      <main className="login">
        <div className="card">
          <div className="card__head">
            <h1 className="card__title">Вход в кабинет оператора</h1>
            <p className="lead">
              Логин и пароль выдаёт администратор. Восстановления пароля здесь нет.
            </p>
          </div>

          <form className="form" noValidate onSubmit={handleSubmit}>
            <div className="field">
              <label className="field__label" htmlFor="operator-username">
                Логин
              </label>
              <input
                className="field__input"
                id="operator-username"
                name="username"
                type="text"
                autoComplete="username"
                placeholder="operator"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                aria-invalid={fieldErrors.username !== undefined || rejectedByServer}
                aria-describedby={
                  fieldErrors.username !== undefined ? 'operator-username-error' : undefined
                }
                data-testid="operator-login-username"
              />
              {fieldErrors.username !== undefined && (
                <p className="field__error" id="operator-username-error">
                  {fieldErrors.username}
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="operator-password">
                Пароль
              </label>
              <input
                className="field__input"
                id="operator-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={fieldErrors.password !== undefined || rejectedByServer}
                aria-describedby={
                  fieldErrors.password !== undefined ? 'operator-password-error' : undefined
                }
                data-testid="operator-login-password"
              />
              {fieldErrors.password !== undefined && (
                <p className="field__error" id="operator-password-error">
                  {fieldErrors.password}
                </p>
              )}
            </div>

            {error !== null && (
              <p className="alert alert--error" role="alert" data-testid="operator-login-error">
                {error}
              </p>
            )}

            <button
              className="btn btn--primary btn--block"
              type="submit"
              disabled={submitting}
              aria-busy={submitting ? true : undefined}
              data-testid="operator-login-submit"
            >
              {submitting ? 'Вход…' : 'Войти'}
            </button>
          </form>
        </div>
      </main>
    </Screen>
  );
}
