import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { RegisterResult } from '../api/client';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  fullName?: string;
}

/** Форма регистрации. Живёт внутри модального окна на главной странице. */
export function Register(): JSX.Element {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [requestError, setRequestError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (!email.trim()) {
      found.email = 'Укажите email';
    } else if (!EMAIL_PATTERN.test(email.trim())) {
      found.email = 'Похоже, это не email';
    }
    if (!fullName.trim()) {
      found.fullName = 'Укажите ФИО';
    }
    return found;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setRequestError('');
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      setResult(await api.register(email.trim(), fullName.trim()));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setRequestError('Пользователь с таким email уже зарегистрирован');
      } else {
        setRequestError('Не удалось зарегистрировать. Попробуйте ещё раз');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="form" data-testid="register-success-screen">
        <p className="alert alert--ok" data-testid="register-success">
          Пользователь <strong data-testid="register-result-email">{result.email}</strong> создан.
        </p>

        <p className="form__lead" data-testid="register-mail-notice">
          Мы отправили письмо для активации кабинета. Откройте ссылку из письма и задайте пароль —
          пароль придумываете вы, сервер его не показывает.
        </p>

        {result.activation_email_sent ? null : (
          <p className="alert alert--warning" data-testid="register-mail-warning" role="alert">
            Письмо отправить не удалось: почтовый сервер ещё не настроен. Запросите письмо ещё раз
            на экране активации.
          </p>
        )}

        <Link className="btn btn--primary btn--block" to="/activate" data-testid="link-to-activate">
          Перейти к активации кабинета
        </Link>

        <p className="form__switch">
          <Link to="/login" data-testid="link-to-login">
            Вернуться ко входу
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <p className="form__lead">
        Укажите почту и ФИО — мы отправим письмо со ссылкой активации. Пароль вы зададите сами по
        этой ссылке.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="register-email">
          Email
        </label>
        <input
          className="field__input"
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="ivanov@company.ru"
          data-testid="register-email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? 'register-email-error' : undefined}
        />
        {errors.email ? (
          <p
            className="field__error"
            id="register-email-error"
            role="alert"
            data-testid="register-email-error"
          >
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor="register-full-name">
          ФИО
        </label>
        <input
          className="field__input"
          id="register-full-name"
          name="full_name"
          type="text"
          autoComplete="name"
          placeholder="Иванов Иван Иванович"
          data-testid="register-full-name"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          aria-invalid={errors.fullName ? true : undefined}
          aria-describedby={errors.fullName ? 'register-full-name-error' : undefined}
        />
        {errors.fullName ? (
          <p
            className="field__error"
            id="register-full-name-error"
            role="alert"
            data-testid="register-full-name-error"
          >
            {errors.fullName}
          </p>
        ) : null}
      </div>

      {requestError ? (
        <p className="alert alert--error" role="alert" data-testid="register-error">
          {requestError}
        </p>
      ) : null}

      <button
        className="btn btn--primary btn--block"
        type="submit"
        data-testid="register-submit"
        disabled={submitting}
      >
        Зарегистрироваться
      </button>

      <p className="form__switch">
        Уже есть пароль?{' '}
        <Link to="/login" data-testid="link-to-login">
          Войти
        </Link>
      </p>
    </form>
  );
}
