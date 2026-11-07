import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChangeEvent, FormEvent } from 'react';

import { ApiError, getUser, impersonateUser, updateUser } from '../api/client';
import type { PlatformUser } from '../api/client';
import { ActivationFlag } from '../components/ActivationFlag';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NONE, formatDayLong, roleLabel } from '../lib/format';
import { openLink } from '../lib/navigate';

/** Текст для сети и неожиданного отказа: `detail` сервера важнее общего текста. */
const LOAD_ERROR = 'Не удалось загрузить пользователя';
const SAVE_ERROR = 'Не удалось сохранить изменения';
const IMPERSONATE_ERROR = 'Не удалось получить ссылку входа';

/** `id` поля ФИО и текста отказа: связка `label`/`htmlFor` и `aria-describedby`. */
const FULL_NAME_ID = 'user-full-name';
const FULL_NAME_ERROR_ID = 'user-full-name-error';

type CardState =
  | { status: 'loading' }
  | { status: 'missing'; text: string }
  | { status: 'error'; text: string }
  | { status: 'ready'; data: PlatformUser };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}

/**
 * Строки, которые только читаются: email, организация, роль, состояние.
 *
 * `flush` — вариант внутри формы правки: там выписка стоит без собственных
 * отступов, их задаёт форма (`form--edit`).
 */
function DetailsList({
  data,
  flush = false,
}: {
  data: PlatformUser;
  flush?: boolean;
}): JSX.Element {
  return (
    <dl className={flush ? 'req req--flush' : 'req'}>
      <div className="req__row">
        <dt className="req__key">Email</dt>
        <dd className="req__val" data-testid="operator-user-email">
          {data.email}
        </dd>
      </div>
      <div className="req__row">
        <dt className="req__key">Организация</dt>
        <dd
          className={data.organization_name === null ? 'req__val none' : 'req__val'}
          data-testid="operator-user-organization"
        >
          {data.organization_name ?? NONE}
        </dd>
      </div>
      <div className="req__row">
        <dt className="req__key">Роль</dt>
        <dd
          className={data.role === null ? 'req__val none' : 'req__val'}
          data-testid="operator-user-role"
        >
          {roleLabel(data.role)}
        </dd>
      </div>
      <div className="req__row">
        <dt className="req__key">Состояние</dt>
        <dd className="req__val" data-testid="operator-user-active">
          <ActivationFlag active={data.is_active} />
        </dd>
      </div>
    </dl>
  );
}

/**
 * Карточка учётной записи: реквизиты только для чтения и правка ФИО на месте.
 *
 * Данные — из кабинета-API (`GET/PATCH /api/users/{id}`), тот ходит в основной
 * API по сервисному токену. Экраны: загрузка; `404` — «Пользователь не найден»
 * и ссылка «К списку»; ошибка загрузки; просмотр; правка.
 *
 * Правится единственное поле — ФИО. Email (он же логин), организация, роль и
 * признак активации остаются текстом: ручек для них нет. Отказ (`422` пустое
 * ФИО) показывается дословно, введённое значение остаётся в поле, фокус — на
 * тексте отказа внутри формы. «Отмена» возвращает значение последнего ответа
 * сервера — черновик никуда не сохраняется.
 *
 * В шапке карточки есть второе действие — «Войти под пользователем». Кабинет
 * только просит ссылку у основного API и переходит по готовому `url` из ответа:
 * адреса сайта он не знает, cookie сайта ставит сам сайт. Отказ приходит тем же
 * `detail`, что и у остальных экранов, и показывается над панелью; в режиме
 * правки действия нет — там карточка про ФИО.
 */
export function UserCard(): JSX.Element {
  const params = useParams();
  const id = Number(params.id);
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [impersonateError, setImpersonateError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const impersonateErrorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (Number.isNaN(id)) {
      setState({ status: 'missing', text: 'Пользователь не найден' });
      return;
    }
    let active = true;
    getUser(id).then(
      (data) => {
        if (active) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: 'missing', text: error.message });
          return;
        }
        setState({ status: 'error', text: errorMessage(error, LOAD_ERROR) });
      },
    );
    return () => {
      active = false;
    };
  }, [id]);

  // После отказа фокус — на тексте отказа внутри формы: кнопка на время запроса
  // неактивна, и браузер снимает с неё фокус, а требование постановки — «фокус
  // остаётся в форме».
  useEffect(() => {
    if (saveError !== null) errorRef.current?.focus();
  }, [saveError]);

  // У отказа «Войти под пользователем» своё место — над панелью, и фокус
  // переходит на него: кнопка на время запроса неактивна, а просить повторить
  // вслепую нельзя — оператор должен прочитать `detail` основного API.
  useEffect(() => {
    if (impersonateError !== null) impersonateErrorRef.current?.focus();
  }, [impersonateError]);

  function handleEdit(): void {
    if (state.status !== 'ready') return;
    setFullName(state.data.full_name);
    setSaveError(null);
    setEditing(true);
  }

  function handleCancel(): void {
    if (state.status === 'ready') setFullName(state.data.full_name);
    setSaveError(null);
    setEditing(false);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state.status !== 'ready' || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Отправляется только ФИО: остальные поля учётной записи не правятся.
      const updated = await updateUser(state.data.id, { full_name: fullName });
      setState({ status: 'ready', data: updated });
      setFullName(updated.full_name);
      setEditing(false);
    } catch (error: unknown) {
      setSaveError(errorMessage(error, SAVE_ERROR));
    } finally {
      setSaving(false);
    }
  }

  async function handleImpersonate(): Promise<void> {
    if (state.status !== 'ready' || opening) return;
    setOpening(true);
    setImpersonateError(null);
    try {
      const link = await impersonateUser(state.data.id);
      // Переход на другой origin, а не `fetch`: cookie `crm_session` ставит сам
      // сайт, и ставит её только обычный переход по адресу из ответа.
      openLink(link.url);
    } catch (error: unknown) {
      setImpersonateError(errorMessage(error, IMPERSONATE_ERROR));
    } finally {
      setOpening(false);
    }
  }

  const title = `Пользователь №${Number.isNaN(id) ? params.id : id}`;

  if (state.status === 'loading') {
    return (
      <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
        <main className="screen__main">
          <div className="page page--card">
            <p className="page__back">
              <Link className="link" to="/users" data-testid="operator-user-back">
                К списку
              </Link>
            </p>
            <div className="page__head">
              <h1 className="page__title">Пользователь</h1>
            </div>
            <div className="state" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              Загружаем пользователя…
            </div>
          </div>
        </main>
      </Screen>
    );
  }

  if (state.status === 'missing') {
    return (
      <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
        <main className="screen__main">
          <div className="page page--card">
            <div className="page__head">
              <h1 className="page__title">{title}</h1>
            </div>
            <div className="empty">
              <span className="empty__icon" aria-hidden="true">
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5M12 16h.01" />
                </svg>
              </span>
              <h2>{state.text}</h2>
              <p>В адресе неверный номер или учётная запись удалена.</p>
              <Link className="link" to="/users" data-testid="operator-user-back">
                К списку
              </Link>
            </div>
          </div>
        </main>
      </Screen>
    );
  }

  if (state.status === 'error') {
    return (
      <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
        <main className="screen__main">
          <div className="page page--card">
            <div className="page__head">
              <h1 className="page__title">{title}</h1>
            </div>
            <p className="alert alert--error" role="alert" data-testid="operator-user-error">
              {state.text}
            </p>
            <p className="page__back">
              <Link className="link" to="/users" data-testid="operator-user-back">
                К списку
              </Link>
            </p>
          </div>
        </main>
      </Screen>
    );
  }

  const data = state.data;

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--card" data-testid="operator-user-card">
          <p className="page__back">
            <Link className="link" to="/users" data-testid="operator-user-back">
              К списку
            </Link>
          </p>

          <div className="page__head page__head--card">
            <div className="page__head-main">
              <h1
                className="page__title"
                data-testid={editing ? undefined : 'operator-user-full-name'}
              >
                {data.full_name}
              </h1>
              <p className="page__meta">
                {editing ? title : `${title} · создан ${formatDayLong(data.created_at)}`}
              </p>
            </div>
            {!editing && (
              <div className="form__actions">
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => void handleImpersonate()}
                  disabled={opening || !data.is_active}
                  aria-busy={opening ? true : undefined}
                  title={data.is_active ? undefined : 'Кабинет не активирован'}
                  data-testid="operator-user-impersonate"
                >
                  {opening ? 'Открываем…' : 'Войти под пользователем'}
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={handleEdit}
                  data-testid="operator-user-edit"
                >
                  Редактировать
                </button>
              </div>
            )}
          </div>

          {impersonateError !== null && (
            <p
              className="alert alert--error"
              role="alert"
              tabIndex={-1}
              ref={impersonateErrorRef}
              data-testid="operator-user-impersonate-error"
            >
              {impersonateError}
            </p>
          )}

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Учётная запись</h2>
            </div>

            {editing ? (
              <form className="form form--edit" noValidate onSubmit={handleSave}>
                <div className="field">
                  <label className="field__label" htmlFor={FULL_NAME_ID}>
                    ФИО
                  </label>
                  <input
                    className="field__input"
                    id={FULL_NAME_ID}
                    name="full_name"
                    type="text"
                    value={fullName}
                    aria-invalid={saveError !== null ? true : undefined}
                    aria-describedby={saveError !== null ? FULL_NAME_ERROR_ID : undefined}
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setFullName(event.target.value)
                    }
                    data-testid="operator-user-full-name"
                  />
                  <p className="field__hint">Email, организацию и роль изменить нельзя.</p>
                </div>

                <DetailsList data={data} flush />

                {saveError !== null && (
                  <p
                    className="alert alert--error"
                    id={FULL_NAME_ERROR_ID}
                    role="alert"
                    tabIndex={-1}
                    ref={errorRef}
                    data-testid="operator-user-error"
                  >
                    {saveError}
                  </p>
                )}

                <div className="form__actions">
                  <button
                    className="btn btn--primary"
                    type="submit"
                    disabled={saving}
                    aria-busy={saving ? true : undefined}
                    data-testid="operator-user-save"
                  >
                    {saving ? 'Сохраняем…' : 'Сохранить'}
                  </button>
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={handleCancel}
                    data-testid="operator-user-cancel"
                  >
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <>
                <DetailsList data={data} />
                <p className="panel__note">
                  Правится только ФИО. Email — это логин учётной записи, организация и роль в
                  кабинете не меняются.
                </p>
              </>
            )}
          </div>
        </div>
      </main>
    </Screen>
  );
}
