import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { ActivationInfo } from '../api/client';
import { useSession } from '../auth/SessionProvider';

/** Минимальная длина нового пароля — та же, что проверяет сервер. */
export const MIN_PASSWORD_LENGTH = 8;

/** Сколько показываем «кабинет активирован», прежде чем открыть кабинет. */
export const SUCCESS_REDIRECT_MS = 700;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Экран активации кабинета. Без токена объясняет, что делать с письмом,
 * и умеет отправить его повторно; с токеном из письма — просит новый пароль.
 */
export function Activate(): JSX.Element {
  const { token } = useParams<{ token?: string }>();
  return (
    <div className="activate">
      <div className="activate__card">
        {token ? <ActivateToken token={token} /> : <ActivatePending />}
      </div>
    </div>
  );
}

/** Экран «активируйте кабинет по ссылке из письма» — без токена. */
function ActivatePending(): JSX.Element {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [result, setResult] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setResult('');
    if (!EMAIL_PATTERN.test(email.trim())) {
      setFieldError('Укажите email, на который регистрировались');
      return;
    }
    setFieldError('');
    setSubmitting(true);
    try {
      await api.resendActivation(email.trim());
      // Сервер отвечает одинаково и для чужого адреса — так адреса не перебирают.
      setResult('Если такой адрес зарегистрирован, письмо отправлено повторно.');
    } catch {
      setResult('Не удалось отправить письмо. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section data-testid="activate-pending">
      <h1 className="activate__title" tabIndex={-1}>
        Активация кабинета
      </h1>
      <p className="form__lead">
        Активируйте ваш личный кабинет по ссылке из письма, которое ушло при регистрации. Если
        письма нет — проверьте папку «Спам» или отправьте его ещё раз.
      </p>

      <form className="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="activate-email">
            Email
          </label>
          <input
            className="field__input"
            id="activate-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="ivanov@company.ru"
            data-testid="activate-resend-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'activate-email-error' : undefined}
          />
          {fieldError ? (
            <p
              className="field__error"
              id="activate-email-error"
              role="alert"
              data-testid="activate-error"
            >
              {fieldError}
            </p>
          ) : null}
        </div>

        <button
          className="btn btn--primary btn--block"
          type="submit"
          data-testid="resend-activation"
          disabled={submitting}
        >
          Отправить письмо ещё раз
        </button>
      </form>

      {result ? (
        <p className="alert alert--ok" role="status" data-testid="activate-resend-result">
          {result}
        </p>
      ) : null}

      <p className="form__switch">
        <Link to="/login" data-testid="link-to-login">
          Вернуться ко входу
        </Link>
      </p>
    </section>
  );
}

/** Экран с токеном из письма: проверка ссылки и форма нового пароля. */
function ActivateToken({ token }: { token: string }): JSX.Element {
  const { setUser } = useSession();
  const navigate = useNavigate();
  const [info, setInfo] = useState<ActivationInfo | null>(null);
  const [checkError, setCheckError] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .activateInfo(token)
      .then((value) => {
        if (!controller.signal.aborted) setInfo(value);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCheckError(
          error instanceof ApiError ? error.message : 'Не удалось проверить ссылку активации',
        );
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(
      () => navigate('/cabinet', { replace: true }),
      SUCCESS_REDIRECT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [done, navigate]);

  function validate(): string {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
    }
    if (password !== confirmation) {
      return 'Пароли не совпадают';
    }
    return '';
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError('');
    const found = validate();
    if (found) {
      setSubmitError(found);
      return;
    }

    setSubmitting(true);
    try {
      const user = await api.activate(token, password);
      setUser(user);
      setDone(true);
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : 'Не удалось активировать кабинет');
    } finally {
      setSubmitting(false);
    }
  }

  if (checkError) {
    return (
      <section data-testid="activate-page">
        <h1 className="activate__title">Активация кабинета</h1>
        <p className="alert alert--error" role="alert" data-testid="activate-error">
          {checkError}
        </p>
        <p className="form__switch">
          <Link to="/activate" data-testid="link-to-resend">
            Запросить новое письмо
          </Link>
        </p>
      </section>
    );
  }

  if (done) {
    return (
      <p className="alert alert--ok" role="status" data-testid="activate-success">
        Кабинет активирован. Открываем личный кабинет…
      </p>
    );
  }

  if (info === null) {
    return (
      <p className="form__note" role="status" data-testid="activate-checking">
        Проверяем ссылку активации…
      </p>
    );
  }

  return (
    <section data-testid="activate-page">
      <h1 className="activate__title">Новый пароль</h1>
      <p className="form__lead">
        Здравствуйте, <strong data-testid="activate-full-name">{info.full_name}</strong>! Задайте
        пароль для входа в кабинет <span data-testid="activate-email-value">{info.email}</span>.
      </p>

      <form className="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="activate-password">
            Новый пароль
          </label>
          <input
            className="field__input"
            id="activate-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            data-testid="activate-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="activate-password-confirm">
            Повторите пароль
          </label>
          <input
            className="field__input"
            id="activate-password-confirm"
            name="password-confirm"
            type="password"
            autoComplete="new-password"
            data-testid="activate-password-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>

        {submitError ? (
          <p className="alert alert--error" role="alert" data-testid="activate-error">
            {submitError}
          </p>
        ) : null}

        <button
          className="btn btn--primary btn--block"
          type="submit"
          data-testid="activate-submit"
          disabled={submitting}
        >
          Сохранить пароль и войти
        </button>
      </form>
    </section>
  );
}
