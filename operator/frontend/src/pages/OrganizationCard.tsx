import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChangeEvent, FormEvent } from 'react';

import { ApiError, getOrganization, updateOrganization } from '../api/client';
import type { OrganizationDetails, OrganizationUpdate } from '../api/client';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NO_NAME, formatDayLong, plural } from '../lib/format';

/** Текст для сети и неожиданного отказа: `detail` сервера важнее общего текста. */
const LOAD_ERROR = 'Не удалось загрузить организацию';
const SAVE_ERROR = 'Не удалось сохранить изменения';

type CardState =
  | { status: 'loading' }
  | { status: 'missing'; text: string }
  | { status: 'error'; text: string }
  | { status: 'ready'; data: OrganizationDetails };

/** Поля формы правки — все пять, что правятся руками. */
interface FormValues {
  name: string;
  inn: string;
  kpp: string;
  ogrn: string;
  address: string;
}

const EMPTY_FORM: FormValues = { name: '', inn: '', kpp: '', ogrn: '', address: '' };

function fromDetails(data: OrganizationDetails): FormValues {
  return {
    name: data.name ?? '',
    inn: data.inn ?? '',
    kpp: data.kpp ?? '',
    ogrn: data.ogrn ?? '',
    address: data.address ?? '',
  };
}

/**
 * Тело правки: уходят все пять полей, как требует контракт.
 *
 * Пустой реквизит отправляется как `null` — это и есть очистка поля. Название
 * уходит как набрано: правило «название не может быть пустым» живёт в основном
 * API, и кабинет обязан показать его отказ дословно, а не проверять сам.
 */
function toPayload(values: FormValues): OrganizationUpdate {
  const requisite = (value: string): string | null => (value.trim() === '' ? null : value);
  return {
    name: values.name,
    inn: requisite(values.inn),
    kpp: requisite(values.kpp),
    ogrn: requisite(values.ogrn),
    address: requisite(values.address),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}

/**
 * Карточка организации: реквизиты, счётчики и правка на месте.
 *
 * Данные — из кабинета-API (`GET/PATCH /api/organizations/{id}`), тот ходит в
 * основной API по сервисному токену. Экраны: загрузка; `404` — «Организация не
 * найдена» и ссылка «К списку»; ошибка загрузки; просмотр; правка.
 *
 * Правка отправляет все пять полей. Отказ (`409` занятый ИНН, `422` пустое
 * название или формат ИНН) показывается дословно, введённые значения остаются в
 * полях, фокус возвращается в форму. «Отмена» возвращает значения последнего
 * ответа сервера — черновик никуда не сохраняется.
 */
export function OrganizationCard(): JSX.Element {
  const params = useParams();
  const id = Number(params.id);
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (Number.isNaN(id)) {
      setState({ status: 'missing', text: 'Организация не найдена' });
      return;
    }
    let active = true;
    getOrganization(id).then(
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

  // После отказа фокус — на алерте: кнопка на время запроса неактивна, и браузер
  // снимает с неё фокус, а требование постановки — «фокус остаётся в форме».
  useEffect(() => {
    if (saveError !== null) errorRef.current?.focus();
  }, [saveError]);

  function handleEdit(): void {
    if (state.status !== 'ready') return;
    setForm(fromDetails(state.data));
    setSaveError(null);
    setEditing(true);
  }

  function handleCancel(): void {
    if (state.status === 'ready') setForm(fromDetails(state.data));
    setSaveError(null);
    setEditing(false);
  }

  function handleChange(field: keyof FormValues, value: string): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state.status !== 'ready' || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateOrganization(state.data.id, toPayload(form));
      setState({ status: 'ready', data: updated });
      setForm(fromDetails(updated));
      setEditing(false);
    } catch (error: unknown) {
      setSaveError(errorMessage(error, SAVE_ERROR));
    } finally {
      setSaving(false);
    }
  }

  const title = `Организация №${Number.isNaN(id) ? params.id : id}`;

  if (state.status === 'loading') {
    return (
      <Screen right={<OperatorTopBar />}>
        <main className="screen__main">
          <div className="page page--card">
            <p className="page__back">
              <Link className="link" to="/" data-testid="operator-organization-back">
                К списку
              </Link>
            </p>
            <div className="page__head">
              <h1 className="page__title">Организация</h1>
            </div>
            <p className="state" role="status">
              <span className="spinner" aria-hidden="true" />
              Загружаем организацию…
            </p>
          </div>
        </main>
      </Screen>
    );
  }

  if (state.status === 'missing') {
    return (
      <Screen right={<OperatorTopBar />}>
        <main className="screen__main">
          <div className="page">
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
              <p>В адресе неверный номер или организация удалена.</p>
              <Link className="link" to="/" data-testid="operator-organization-back">
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
      <Screen right={<OperatorTopBar />}>
        <main className="screen__main">
          <div className="page">
            <div className="page__head">
              <h1 className="page__title">{title}</h1>
            </div>
            <p
              className="alert alert--error"
              role="alert"
              data-testid="operator-organization-error"
            >
              {state.text}
            </p>
            <p className="page__back">
              <Link className="link" to="/" data-testid="operator-organization-back">
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
    <Screen right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--card" data-testid="operator-organization-card">
          <p className="page__back">
            <Link className="link" to="/" data-testid="operator-organization-back">
              К списку
            </Link>
          </p>

          <div className="page__head page__head--card">
            <div className="page__head-main">
              <h1
                className="page__title"
                data-testid={editing ? undefined : 'operator-organization-name'}
              >
                {data.name ?? NO_NAME}
              </h1>
              <p className="page__meta">
                {editing ? title : `${title} · создана ${formatDayLong(data.created_at)}`}
              </p>
            </div>
            {!editing && (
              <button
                className="btn btn--ghost"
                type="button"
                onClick={handleEdit}
                data-testid="operator-organization-edit"
              >
                Редактировать
              </button>
            )}
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Реквизиты</h2>
            </div>

            {editing ? (
              <form className="form form--panel" noValidate onSubmit={handleSave}>
                <div className="form__grid">
                  <div className="field field--wide">
                    <label className="field__label" htmlFor="organization-name">
                      Название
                    </label>
                    <input
                      className="field__input"
                      id="organization-name"
                      name="name"
                      type="text"
                      value={form.name}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        handleChange('name', event.target.value)
                      }
                      data-testid="operator-organization-name"
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="organization-inn">
                      ИНН
                    </label>
                    <input
                      className="field__input"
                      id="organization-inn"
                      name="inn"
                      type="text"
                      inputMode="numeric"
                      value={form.inn}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        handleChange('inn', event.target.value)
                      }
                      data-testid="operator-organization-inn"
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="organization-kpp">
                      КПП
                    </label>
                    <input
                      className="field__input"
                      id="organization-kpp"
                      name="kpp"
                      type="text"
                      value={form.kpp}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        handleChange('kpp', event.target.value)
                      }
                      data-testid="operator-organization-kpp"
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="organization-ogrn">
                      ОГРН
                    </label>
                    <input
                      className="field__input"
                      id="organization-ogrn"
                      name="ogrn"
                      type="text"
                      value={form.ogrn}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        handleChange('ogrn', event.target.value)
                      }
                      data-testid="operator-organization-ogrn"
                    />
                  </div>
                  <div className="field field--wide">
                    <label className="field__label" htmlFor="organization-address">
                      Адрес
                    </label>
                    <textarea
                      className="field__input field__input--area"
                      id="organization-address"
                      name="address"
                      rows={2}
                      value={form.address}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                        handleChange('address', event.target.value)
                      }
                      data-testid="operator-organization-address"
                    />
                  </div>
                </div>

                {saveError !== null && (
                  <p
                    className="alert alert--error"
                    role="alert"
                    tabIndex={-1}
                    ref={errorRef}
                    data-testid="operator-organization-error"
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
                    data-testid="operator-organization-save"
                  >
                    {saving ? 'Сохраняем…' : 'Сохранить'}
                  </button>
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={handleCancel}
                    data-testid="operator-organization-cancel"
                  >
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <>
                <dl className="req">
                  <div className="req__row">
                    <dt className="req__key">Название</dt>
                    <dd className="req__val">{data.name ?? NO_NAME}</dd>
                  </div>
                  <div className="req__row">
                    <dt className="req__key">ИНН</dt>
                    <dd className="req__val" data-testid="operator-organization-inn">
                      {data.inn ?? '—'}
                    </dd>
                  </div>
                  <div className="req__row">
                    <dt className="req__key">КПП</dt>
                    <dd className="req__val" data-testid="operator-organization-kpp">
                      {data.kpp ?? '—'}
                    </dd>
                  </div>
                  <div className="req__row">
                    <dt className="req__key">ОГРН</dt>
                    <dd className="req__val" data-testid="operator-organization-ogrn">
                      {data.ogrn ?? '—'}
                    </dd>
                  </div>
                  <div className="req__row">
                    <dt className="req__key">Адрес</dt>
                    <dd className="req__val" data-testid="operator-organization-address">
                      {data.address ?? '—'}
                    </dd>
                  </div>
                </dl>
                <div className="counts">
                  <div className="counts__item">
                    <span className="counts__value">{data.members_count}</span>
                    <span className="counts__label">
                      {plural(data.members_count, ['участник', 'участника', 'участников'])}
                    </span>
                  </div>
                  <div className="counts__item">
                    <span className="counts__value">{data.dormitories_count}</span>
                    <span className="counts__label">
                      {plural(data.dormitories_count, ['общежитие', 'общежития', 'общежитий'])}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </Screen>
  );
}
