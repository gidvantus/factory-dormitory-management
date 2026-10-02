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

export function Register(): JSX.Element {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [requestError, setRequestError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [copied, setCopied] = useState(false);

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

  async function copyPassword(): Promise<void> {
    if (!result) {
      return;
    }
    try {
      await navigator.clipboard?.writeText(result.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (result) {
    return (
      <section>
        <h1>Регистрация завершена</h1>
        <p data-testid="register-success">
          Пользователь <strong data-testid="register-result-email">{result.email}</strong> создан.
        </p>
        <p data-testid="password-warning" role="alert">
          <strong>Сохраните пароль сейчас.</strong> Он показывается один раз и больше не будет
          доступен ни на этом сайте, ни по почте.
        </p>
        <p data-testid="generated-password" aria-label="Сгенерированный пароль">
          {result.password}
        </p>
        <button type="button" data-testid="copy-password" onClick={() => void copyPassword()}>
          Скопировать пароль
        </button>
        {copied ? <p data-testid="password-copied">Пароль скопирован</p> : null}
        <p>
          <Link to="/login" data-testid="link-to-login">
            Войти с этим паролем
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Регистрация</h1>
      <p>Пароль придумает сервер и покажет его один раз после регистрации.</p>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <p>
          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
            name="email"
            type="email"
            data-testid="register-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'register-email-error' : undefined}
          />
        </p>
        {errors.email ? (
          <p id="register-email-error" role="alert" data-testid="register-email-error">
            {errors.email}
          </p>
        ) : null}

        <p>
          <label htmlFor="register-full-name">ФИО</label>
          <input
            id="register-full-name"
            name="full_name"
            type="text"
            data-testid="register-full-name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            aria-invalid={errors.fullName ? true : undefined}
            aria-describedby={errors.fullName ? 'register-full-name-error' : undefined}
          />
        </p>
        {errors.fullName ? (
          <p id="register-full-name-error" role="alert" data-testid="register-full-name-error">
            {errors.fullName}
          </p>
        ) : null}

        {requestError ? (
          <p role="alert" data-testid="register-error">
            {requestError}
          </p>
        ) : null}

        <button type="submit" data-testid="register-submit" disabled={submitting}>
          Зарегистрироваться
        </button>
      </form>
      <p>
        Уже есть пароль?{' '}
        <Link to="/login" data-testid="link-to-login">
          Войти
        </Link>
      </p>
    </section>
  );
}
