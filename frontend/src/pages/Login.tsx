import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import { useSession } from '../auth/SessionProvider';

interface LoginLocationState {
  from?: string;
}

export function Login(): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [requestError, setRequestError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { setUser } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LoginLocationState | null)?.from ?? '/cabinet';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setRequestError('');
    const found: { email?: string; password?: string } = {};
    if (!email.trim()) {
      found.email = 'Укажите email';
    }
    if (!password) {
      found.password = 'Укажите пароль';
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      setUser(await api.login(email.trim(), password));
      setPassword('');
      navigate(from, { replace: true });
    } catch (error) {
      // Сервер не сообщает, что именно неверно, и экран тоже.
      if (error instanceof ApiError && error.status === 401) {
        setRequestError('Неверный email или пароль');
      } else {
        setRequestError('Не удалось войти. Попробуйте ещё раз');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>Вход</h1>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <p>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            data-testid="login-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'login-email-error' : undefined}
          />
        </p>
        {errors.email ? (
          <p id="login-email-error" role="alert" data-testid="login-email-error">
            {errors.email}
          </p>
        ) : null}

        <p>
          <label htmlFor="login-password">Пароль</label>
          <input
            id="login-password"
            name="password"
            type="password"
            data-testid="login-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'login-password-error' : undefined}
          />
        </p>
        {errors.password ? (
          <p id="login-password-error" role="alert" data-testid="login-password-error">
            {errors.password}
          </p>
        ) : null}

        {requestError ? (
          <p role="alert" data-testid="login-error">
            {requestError}
          </p>
        ) : null}

        <button type="submit" data-testid="login-submit" disabled={submitting}>
          Войти
        </button>
      </form>
      <p>
        Нет пароля?{' '}
        <Link to="/register" data-testid="link-to-register">
          Зарегистрироваться
        </Link>
      </p>
    </section>
  );
}
