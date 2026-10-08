import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client';

/** Тот же шаблон адреса, что на экране активации: проверка до запроса. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Экран запроса письма для восстановления пароля.
 *
 * Ссылка из письма ведёт на `/activate/:token` — экран смены пароля общий
 * с активацией кабинета, отдельной формы здесь нет.
 */
export function ForgotPassword(): JSX.Element {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSent(false);
    setFailed(false);
    if (!EMAIL_PATTERN.test(email.trim())) {
      setFieldError('Укажите email, на который регистрировались');
      return;
    }
    setFieldError('');
    setSubmitting(true);
    try {
      await api.requestPasswordRecovery(email.trim());
      setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="activate">
      <div className="activate__card">
        <section data-testid="forgot-password">
          <h1 className="activate__title" tabIndex={-1}>
            Восстановление пароля
          </h1>
          <p className="form__lead">
            Укажите email, на который регистрировались. Мы отправим ссылку для смены пароля — она
            действует ограниченное время и срабатывает один раз.
          </p>

          <form className="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
            <div className="field">
              <label className="field__label" htmlFor="forgot-password-email">
                Email
              </label>
              <input
                className="field__input"
                id="forgot-password-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="ivanov@company.ru"
                data-testid="forgot-password-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'forgot-password-email-error' : undefined}
              />
              {fieldError ? (
                <p
                  className="field__error"
                  id="forgot-password-email-error"
                  role="alert"
                  data-testid="forgot-password-error"
                >
                  {fieldError}
                </p>
              ) : null}
            </div>

            <button
              className="btn btn--primary btn--block"
              type="submit"
              data-testid="forgot-password-submit"
              disabled={submitting}
            >
              Отправить ссылку
            </button>
          </form>

          {sent ? (
            <p className="alert alert--ok" role="status" data-testid="forgot-password-result">
              Если такой адрес зарегистрирован, письмо отправлено. Проверьте папку «Спам».
            </p>
          ) : null}

          {failed ? (
            <p className="alert alert--error" role="alert" data-testid="forgot-password-result">
              Не удалось отправить письмо. Попробуйте ещё раз.
            </p>
          ) : null}

          <p className="form__switch">
            <Link to="/login" data-testid="link-to-login">
              Вернуться ко входу
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
