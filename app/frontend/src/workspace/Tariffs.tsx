import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../api/client';
import type { Tariff, TariffInput, TariffPeriod } from '../api/client';
import { Modal } from '../components/Modal';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Workspace.module.css';

const PERIOD_OPTIONS: { value: TariffPeriod; label: string }[] = [
  { value: 'month', label: 'В месяц' },
  { value: 'year', label: 'В год' },
  { value: 'once', label: 'Разово' },
];

const LOAD_ERROR = 'Не удалось загрузить тарифы. Проверьте соединение и попробуйте ещё раз.';
const SAVE_ERROR = 'Не удалось сохранить тариф. Проверьте соединение и попробуйте ещё раз.';
const ACTION_ERROR = 'Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.';
const NAME_REQUIRED = 'Укажите название тарифа';
const AMOUNT_REQUIRED = 'Укажите сумму числом';

const READONLY_NOTICE = 'Править тарифы может владелец или администратор организации';

interface FormState {
  name: string;
  description: string;
  amount: string;
  currency: string;
  period: TariffPeriod;
  unitLabel: string;
  isVisible: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  amount: '',
  currency: 'RUB',
  period: 'month',
  unitLabel: '',
  isVisible: true,
};

/**
 * Сумма в состоянии формы — строка, а не число: `amount` приходит из API как
 * «5000.00», и приведение к `number` на каждом нажатии клавиши съедало бы
 * копейки и не давало бы стереть поле до конца. Числом она становится один раз —
 * при отправке.
 */
function formFrom(tariff: Tariff): FormState {
  return {
    name: tariff.name,
    description: tariff.description ?? '',
    amount: tariff.amount,
    currency: tariff.currency,
    period: tariff.period,
    unitLabel: tariff.unit_label ?? '',
    isVisible: tariff.is_visible,
  };
}

/** Сервер объясняет отказ точнее общего текста: 409 про название, 422 про поля. */
function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return fallback;
}

/**
 * Тарифы в кабинете: список прайса и его правка.
 *
 * Роль решает сервер: в ответе каждого тарифа есть `editable`, и при `false`
 * экран показывает список без кнопок правки — второй проверки прав на клиенте
 * нет, иначе она разошлась бы с серверной. Пустой список прав редактировать не
 * запрещает: `editable` приходит в каждой строке, а строк ещё нет.
 */
export function Tariffs(): JSX.Element {
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Tariff | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .manageTariffs(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setTariffs(items);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(actionErrorMessage(error, LOAD_ERROR));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  // Список прав: у непустого прайса его задаёт сервер, у пустого прав нет ни у
  // кого — показываем кнопку, а откажет сервер, если роли не хватает.
  const canEdit = tariffs.every((tariff) => tariff.editable);

  function reload(): void {
    setAttempt((value) => value + 1);
  }

  function openCreate(): void {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setFormOpen(true);
  }

  function openEdit(tariff: Tariff): void {
    setEditing(tariff);
    setForm(formFrom(tariff));
    setFormError('');
    setFormOpen(true);
  }

  function closeForm(): void {
    setFormOpen(false);
    setEditing(null);
    setFormError('');
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;

    const name = form.name.trim();
    if (!name) {
      setFormError(NAME_REQUIRED);
      nameRef.current?.focus();
      return;
    }
    const amount = Number(form.amount.trim().replace(',', '.'));
    if (!form.amount.trim() || Number.isNaN(amount)) {
      setFormError(AMOUNT_REQUIRED);
      amountRef.current?.focus();
      return;
    }

    const payload: TariffInput = {
      name,
      description: form.description.trim() || null,
      amount,
      currency: form.currency.trim().toUpperCase(),
      period: form.period,
      unit_label: form.unitLabel.trim() || null,
      is_visible: form.isVisible,
    };

    setSaving(true);
    setFormError('');
    setActionError('');
    try {
      if (editing) {
        await api.updateTariff(editing.id, payload);
      } else {
        await api.createTariff(payload);
      }
      closeForm();
      reload();
    } catch (error: unknown) {
      setFormError(actionErrorMessage(error, SAVE_ERROR));
    } finally {
      setSaving(false);
    }
  }

  async function toggleVisibility(tariff: Tariff): Promise<void> {
    setActionError('');
    try {
      await api.updateTariff(tariff.id, { is_visible: !tariff.is_visible });
      reload();
    } catch (error: unknown) {
      setActionError(actionErrorMessage(error, ACTION_ERROR));
    }
  }

  async function remove(tariff: Tariff): Promise<void> {
    setActionError('');
    try {
      await api.deleteTariff(tariff.id);
      reload();
    } catch (error: unknown) {
      setActionError(actionErrorMessage(error, ACTION_ERROR));
    }
  }

  return (
    <section aria-labelledby="tariffs-title" data-testid="tariffs-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="tariffs-title" tabIndex={-1}>
            Тарифы
          </h1>
          <p className={styles.subtitle}>Прайс публичной страницы</p>
        </div>
        {status === 'ready' && canEdit && (
          <button
            className="btn btn--primary btn--sm"
            type="button"
            ref={addRef}
            data-testid="tariff-add"
            onClick={openCreate}
          >
            <span aria-hidden="true">＋</span> Добавить тариф
          </button>
        )}
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="tariffs-loading">
          Загружаем тарифы…
        </p>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="tariffs-error">
          <p>{loadError}</p>
          <button type="button" onClick={reload}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && !canEdit && (
        <p className={styles['tariffs-readonly']} data-testid="tariffs-readonly">
          {READONLY_NOTICE}
        </p>
      )}

      {actionError && (
        <div
          className={styles['organization-error']}
          role="alert"
          data-testid="tariffs-action-error"
        >
          <p>{actionError}</p>
        </div>
      )}

      {status === 'ready' && tariffs.length === 0 && (
        <div className={styles['empty-state']} data-testid="tariffs-empty">
          <span className={styles['empty-state-icon']}>
            <WorkspaceIcon name="chart" />
          </span>
          <h2>Тарифов пока нет</h2>
          <p>
            {canEdit
              ? 'Добавьте первый тариф — он появится на публичной странице.'
              : 'Список появится, когда владелец добавит тарифы.'}
          </p>
        </div>
      )}

      {status === 'ready' && tariffs.length > 0 && (
        <section
          className={styles['table-card']}
          aria-labelledby="tariffs-table-title"
          data-testid="tariffs-table"
        >
          <div className={styles['table-heading']}>
            <h2 id="tariffs-table-title">Прайс</h2>
            <p className={styles['table-meta']} data-testid="tariffs-count">
              {tariffs.length} шт.
            </p>
          </div>
          <div className={styles['table-scroll']}>
            <table className={styles['tariffs-table']}>
              <caption className="visually-hidden">Тарифы</caption>
              <thead>
                <tr>
                  <th scope="col">Видимость</th>
                  <th scope="col">Название</th>
                  <th scope="col">Цена</th>
                  <th scope="col">Действия</th>
                </tr>
              </thead>
              <tbody>
                {tariffs.map((tariff) => (
                  <tr key={tariff.id} data-testid="tariff-row">
                    <td>
                      <span
                        className={`${styles.tag} ${
                          tariff.is_visible ? styles['tag--ok'] : styles['tag--wait']
                        }`}
                        data-testid="tariff-visibility"
                        data-visible={String(tariff.is_visible)}
                      >
                        {tariff.is_visible ? 'Опубликован' : 'Скрыт'}
                      </span>
                    </td>
                    <td data-testid="tariff-row-name">
                      <span className={styles.person}>{tariff.name}</span>
                      {tariff.description ? (
                        <p className={styles['muted-cell']} data-testid="tariff-row-description">
                          {tariff.description}
                        </p>
                      ) : null}
                    </td>
                    <td className={styles['muted-cell']} data-testid="tariff-row-price">
                      {tariff.price_label}
                    </td>
                    <td>
                      {canEdit ? (
                        <div className={styles['row-actions']}>
                          <button
                            type="button"
                            data-testid="tariff-edit"
                            onClick={() => openEdit(tariff)}
                          >
                            Изменить
                          </button>
                          <button
                            type="button"
                            data-testid="tariff-toggle-visibility"
                            onClick={() => void toggleVisibility(tariff)}
                          >
                            {tariff.is_visible ? 'Скрыть' : 'Показать'}
                          </button>
                          <button
                            className={styles.danger}
                            type="button"
                            data-testid="tariff-delete"
                            onClick={() => void remove(tariff)}
                          >
                            Удалить
                          </button>
                        </div>
                      ) : (
                        <span className={styles['muted-cell']}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {formOpen && (
        <Modal
          title={editing ? 'Изменить тариф' : 'Новый тариф'}
          testId="tariff-modal"
          onClose={closeForm}
          closeDisabled={saving}
        >
          <form
            className={styles['organization-form']}
            noValidate
            aria-busy={saving}
            onSubmit={(event) => void save(event)}
          >
            <div className="field">
              <label className="field__label" htmlFor="tariff-name">
                Название
              </label>
              <input
                className="field__input"
                id="tariff-name"
                data-testid="tariff-form-name"
                ref={nameRef}
                value={form.name}
                maxLength={120}
                disabled={saving}
                placeholder="Например, Базовый"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tariff-description">
                Описание
              </label>
              <textarea
                className="field__input"
                id="tariff-description"
                data-testid="tariff-form-description"
                value={form.description}
                rows={3}
                maxLength={2000}
                disabled={saving}
                placeholder="Что входит в тариф"
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tariff-amount">
                Сумма
              </label>
              <input
                className="field__input"
                id="tariff-amount"
                data-testid="tariff-form-amount"
                ref={amountRef}
                value={form.amount}
                inputMode="decimal"
                disabled={saving}
                placeholder="5000.00"
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tariff-currency">
                Валюта
              </label>
              <input
                className="field__input"
                id="tariff-currency"
                data-testid="tariff-form-currency"
                value={form.currency}
                maxLength={3}
                disabled={saving}
                placeholder="RUB"
                onChange={(event) => setForm({ ...form, currency: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tariff-period">
                Период
              </label>
              <select
                className="field__input"
                id="tariff-period"
                data-testid="tariff-form-period"
                value={form.period}
                disabled={saving}
                onChange={(event) =>
                  setForm({ ...form, period: event.target.value as TariffPeriod })
                }
              >
                {PERIOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="tariff-unit">
                За что
              </label>
              <input
                className="field__input"
                id="tariff-unit"
                data-testid="tariff-form-unit"
                value={form.unitLabel}
                maxLength={40}
                disabled={saving}
                placeholder="за одно место"
                onChange={(event) => setForm({ ...form, unitLabel: event.target.value })}
              />
            </div>

            <label className={styles['tariff-visible']} htmlFor="tariff-visible">
              <input
                id="tariff-visible"
                data-testid="tariff-form-visible"
                type="checkbox"
                checked={form.isVisible}
                disabled={saving}
                onChange={(event) => setForm({ ...form, isVisible: event.target.checked })}
              />
              Показывать на странице тарифов
            </label>

            {formError && (
              <p className="alert alert--error" role="alert" data-testid="tariff-form-error">
                {formError}
              </p>
            )}

            <div className={styles['form-actions']}>
              <button
                className="btn btn--primary"
                type="submit"
                disabled={saving}
                data-testid="tariff-save"
              >
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
              <button
                className="btn btn--outline"
                type="button"
                disabled={saving}
                data-testid="tariff-cancel"
                onClick={closeForm}
              >
                Отмена
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
