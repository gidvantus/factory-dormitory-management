import { useEffect, useRef, useState } from 'react';
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

/** Ошибка под формой: текст для оператора и признак «отказ именно по паре». */
interface LoginError {
  text: string;
  /**
   * Подсвечивать оба поля как неверные. true только у отказа по паре (`401`):
   * при недоступном сервере введённые значения не виноваты, и красить их
   * кирпичом — сигнал «ваш логин или пароль неверны» вместо «повторите».
   */
  pairRejected: boolean;
}

/**
 * Разбор отказа входа.
 *
 * `401` — это контракт: сервер прислал `detail`, и экран обязан показать его
 * дословно, без переписывания («Неверный логин или пароль»). Такой отказ
 * относится к паре целиком: сервер намеренно не говорит, что именно неверно.
 * Всё остальное — сеть, `5xx`, неожиданный `422` — невиновность введённых
 * данных: текст общий, поля остаются обычными.
 */
function describeLoginError(error: unknown): LoginError {
  if (error instanceof ApiError && error.status === 401) {
    return { text: error.message, pairRejected: true };
  }
  return { text: FAILED_TO_LOGIN, pairRejected: false };
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
  const [error, setError] = useState<LoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  // Только отказ по паре (401) красит поля: сеть и 5xx оставляют их обычными.
  const rejectedPair = error?.pairRejected === true;

  // После отказа фокус возвращается в форму — на сам алерт.
  //
  // Кнопка на время запроса получает `disabled`; браузер снимает фокус с
  // отключённого элемента и уводит его на <body>, поэтому при отправке мышью
  // (или Tab → Enter на кнопке) Tab после ошибки начинал обход страницы с
  // шапки, а требование постановки — «фокус после ошибки остаётся в форме».
  // Алерт внутри формы и с `tabIndex={-1}`: он же объявляется скринридером.
  useEffect(() => {
    if (error === null) return;
    errorRef.current?.focus();
  }, [error]);

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
      setError(describeLoginError(caught));
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
                aria-invalid={fieldErrors.username !== undefined || rejectedPair}
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
                aria-invalid={fieldErrors.password !== undefined || rejectedPair}
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
              <p
                className="alert alert--error"
                role="alert"
                tabIndex={-1}
                ref={errorRef}
                data-testid="operator-login-error"
              >
                {error.text}
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
