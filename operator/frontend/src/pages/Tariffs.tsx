import { Fragment, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { ApiError, deleteTariff, listTariffs, updateTariff } from '../api/client';
import type { Tariff, TariffPatch, TariffPeriod } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NONE, plural } from '../lib/format';

/** Текст для сети, где `detail` сервера нет вовсе. */
const LOAD_ERROR = 'Не удалось загрузить тарифы';
const SAVE_ERROR = 'Не удалось сохранить тариф';
const DELETE_ERROR = 'Не удалось снять тариф с продажи';
const PUBLISH_ERROR = 'Не удалось вернуть тариф в прайс';

/**
 * Подписи периодов: словарь экрана, коды — из ответа API.
 *
 * Пять значений и их тексты задаёт контракт постановки (`PERIOD_SUFFIXES` в
 * `app/backend/app/pricing.py`): фронт владеет подписями и порядком `select`, а
 * значения (`period`) приходят из API. Цену экран не собирает — печатает
 * готовый `price_label`, чтобы формула цены осталась одна на весь API.
 */
const PERIODS: ReadonlyArray<{ value: TariffPeriod; label: string }> = [
  { value: 'month', label: 'в месяц' },
  { value: 'quarter', label: 'за 3 месяца' },
  { value: 'half_year', label: 'за 6 месяцев' },
  { value: 'year', label: 'в год' },
  { value: 'once', label: 'разово' },
];

/**
 * Поле формы, к которому относится отказ сервера.
 *
 * Основной API отвечает русским текстом (`Контракт половин`), и экран узнаёт
 * поле по самому тексту — списком тех сообщений, которые называет контракт.
 * Приставку `Value error, ` уже снял `client.ts`, а несколько сообщений он
 * склеивает через `; ` — виноватым считается первое. `409` — это всегда
 * занятое название. Незнакомый отказ поля не помечает: выдумывать связь нельзя,
 * а текст ошибки всё равно показан дословно.
 */
type FieldName = 'name' | 'amount' | 'period' | 'members';

const FIELD_MESSAGES: Readonly<Record<FieldName, readonly string[]>> = {
  name: ['Название не может быть пустым', 'Название длиннее 120 символов'],
  amount: ['Цена не может быть отрицательной', 'Слишком большая цена', 'Цена должна быть числом'],
  period: ['Неизвестный период оплаты'],
  members: ['Количество пользователей не может быть отрицательным', 'Слишком много пользователей'],
};

function invalidField(status: number, text: string): FieldName | null {
  if (status === 409) return 'name';
  const first = text.split('; ')[0];
  for (const [field, messages] of Object.entries(FIELD_MESSAGES)) {
    if (messages.includes(first)) return field as FieldName;
  }
  return null;
}

/** Период словами. Неизвестный код печатается как пришёл — выдумывать нечего. */
function periodLabel(period: TariffPeriod): string {
  return PERIODS.find((option) => option.value === period)?.label ?? period;
}

/** Предел мест словами: `null` — «без ограничения», а не «0». */
function membersLabel(maxMembers: number | null): string {
  return maxMembers === null ? 'без ограничения' : String(maxMembers);
}

/** Заголовок со счётчиком: `15 тарифов · 12 в прайсе`. */
function headMeta(items: Tariff[]): string {
  const visible = items.filter((item) => item.is_visible).length;
  return `${items.length} ${plural(items.length, ['тариф', 'тарифа', 'тарифов'])} · ${visible} в прайсе`;
}

/**
 * Текст отказа для экрана.
 *
 * Контракт кабинета: `detail` показывается дословно. Сюда приходят и тексты
 * основного API через прокси («Тариф не найден», «Тариф с таким названием уже
 * есть», сообщения валидаторов), поэтому переписывать их нельзя — исключение
 * только для сети, где текста сервера нет вовсе.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}

/** Поля формы строками: `null` из ответа остаётся пустым полем. */
interface EditForm {
  name: string;
  description: string;
  amount: string;
  period: TariffPeriod;
  members: string;
}

/** Форма по строке прайса: значения — из последнего ответа сервера. */
function formFrom(item: Tariff): EditForm {
  return {
    name: item.name,
    description: item.description ?? '',
    amount: item.amount,
    period: item.period,
    members: item.max_members === null ? '' : String(item.max_members),
  };
}

/**
 * Количество пользователей из поля формы.
 *
 * Пустое поле — это `null`, «без ограничения» (контракт). Отрицательное число
 * уходит на сервер как есть: правило и его русский текст живут в основном API.
 * А вот нечисло отправить нечем — тип поля в API целый, и ответ был бы
 * английским, поэтому такой ввод экран не пропускает и объясняет словами.
 */
function membersPayload(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null, error: null };
  if (!/^-?\d+$/.test(trimmed)) {
    return { value: null, error: 'Количество пользователей — целое число или пусто' };
  }
  return { value: Number(trimmed), error: null };
}

type ListState =
  { status: 'loading' } | { status: 'ready'; items: Tariff[] } | { status: 'error'; text: string };

/**
 * Прайс платформы: список, правка полей и снятие с продажи.
 *
 * Данные приходят из кабинета-API (`GET /api/tariffs`), тот читает их в основном
 * API по сервисному токену. Список — плоский, без пагинации: строк в прайсе
 * около пятнадцати, порядок `position, id` держит сервер.
 *
 * Состояния: загрузка («Загружаем тарифы…»), ошибка (`detail` дословно),
 * пустой прайс («Тарифов пока нет»), заполненный список с открытой формой под
 * строкой. Правка разворачивается в той же таблице: модальных окон и отдельных
 * страниц у кабинета нет.
 *
 * Необратимых команд две — «Удалить» и «Опубликовать», — и первая двухшаговая:
 * «Удалить» заменяется парой «Подтвердить» / «Не надо», и только «Подтвердить»
 * отправляет `DELETE`. «Удалить» не удаляет строку: сервер ставит
 * `is_visible = false`, поэтому после `204` экран помечает строку «Не в прайсе»
 * сам — тела с новым состоянием в ответе нет.
 */
export function Tariffs(): JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  // Строка с развёрнутой формой: одновременно открыта не больше одной.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  // Строка, где «Удалить» ждёт подтверждения. Пока ждёт — запрос не уходит.
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  // Строки, по которым сейчас идёт запрос: их кнопки неактивны и с `aria-busy`.
  // Набор, а не одна строка: соседние строки не блокируют друг друга, и вторая
  // команда не теряется, пока идёт первая.
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  // Поле, которое сервер назвал виноватым: на нём `aria-invalid`.
  const [errorField, setErrorField] = useState<FieldName | null>(null);
  // Отказ собственной проверки формы (нечисловое количество пользователей).
  const [membersError, setMembersError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  // Строка, которой фокус нужен после ближайшей перерисовки: нажатая кнопка
  // исчезает из DOM до ответа, и без этого фокус уехал бы на `body`.
  const focusAfterRender = useRef<number | null>(null);
  const rowActions = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    listTariffs().then(
      (items) => {
        if (active) setState({ status: 'ready', items });
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', text: errorMessage(error, LOAD_ERROR) });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // Форма только что раскрылась — фокус в первое поле: с клавиатуры оператор
  // продолжает печатать, а не ищет форму заново.
  useEffect(() => {
    if (editingId !== null) nameInput.current?.focus();
  }, [editingId]);

  /**
   * Возврат фокуса в строку после исчезнувшей кнопки.
   *
   * Нажатая «Подтвердить» (и «Сохранить» закрывшейся формы) исчезает из DOM, и
   * фокус уехал бы на `body` — следующий Tab начал бы обход таблицы сначала.
   * Ставим его на «Изменить» этой строки: она есть у любой строки и остаётся
   * доступной, когда запрос закончился. Поэтому фокус просится в `finally`
   * запроса, а не до него: на время запроса кнопки строки неактивны.
   */
  useEffect(() => {
    const id = focusAfterRender.current;
    if (id === null) return;
    focusAfterRender.current = null;
    rowActions.current[id]
      ?.querySelector<HTMLButtonElement>('[data-testid="operator-tariff-edit"]')
      ?.focus();
  });

  function clearActionError(): void {
    setActionError(null);
    setErrorField(null);
  }

  function handleEdit(item: Tariff): void {
    clearActionError();
    setMembersError(null);
    setConfirmingId(null);
    setEditingId(item.id);
    setForm(formFrom(item));
  }

  function handleCancel(): void {
    clearActionError();
    setMembersError(null);
    // Нажатая «Отмена» исчезает из DOM вместе с формой: без возврата фокуса
    // следующий Tab начал бы обход таблицы сначала.
    focusAfterRender.current = editingId;
    setEditingId(null);
    setForm(null);
  }

  /** Правка текстового поля формы: `period` приходит не строкой, у него свой обработчик. */
  function handleChange(field: 'name' | 'description' | 'amount' | 'members', value: string): void {
    setForm((current) => (current === null ? current : { ...current, [field]: value }));
  }

  /** Период выбирается из пяти значений контракта, а не набирается руками. */
  function handlePeriod(value: TariffPeriod): void {
    setForm((current) => (current === null ? current : { ...current, period: value }));
  }

  /** Замена строки ответом сервера: `price_label` уже пересчитан им. */
  function replaceRow(updated: Tariff): void {
    setState((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            items: current.items.map((row) => (row.id === updated.id ? updated : row)),
          }
        : current,
    );
  }

  /**
   * Сохранение правки: единственное место, откуда уходит `PATCH` формы.
   *
   * Отправляются все пять полей — так требует контракт: пустое описание и
   * пустое количество пользователей уходят как `null`. Отказ сервера форму не
   * сбрасывает: введённое остаётся, текст `detail` показывается дословно над
   * списком, виноватое поле помечается `aria-invalid`.
   */
  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (form === null || editingId === null || saving) return;
    const members = membersPayload(form.members);
    if (members.error !== null) {
      setMembersError(members.error);
      setErrorField('members');
      return;
    }
    setMembersError(null);
    clearActionError();
    setSaving(true);
    const payload: TariffPatch = {
      name: form.name,
      description: form.description.trim() === '' ? null : form.description,
      amount: form.amount,
      period: form.period,
      max_members: members.value,
    };
    try {
      const updated = await updateTariff(editingId, payload);
      replaceRow(updated);
      // Форма закрылась — фокус возвращается в строку, а не на `body`.
      focusAfterRender.current = editingId;
      setEditingId(null);
      setForm(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, SAVE_ERROR));
      setErrorField(error instanceof ApiError ? invalidField(error.status, error.message) : null);
    } finally {
      setSaving(false);
    }
  }

  /** Первый шаг удаления: команда только спрашивает подтверждение, запроса ещё нет. */
  function askDelete(id: number): void {
    clearActionError();
    setMembersError(null);
    setConfirmingId(id);
  }

  /** Отказ от подтверждения: строка возвращается в прежний вид. */
  function declineDelete(id: number): void {
    // «Не надо» исчезает из DOM так же, как «Подтвердить»: фокус — обратно в строку.
    focusAfterRender.current = id;
    setConfirmingId(null);
  }

  /**
   * Второй шаг удаления: единственное место, откуда уходит `DELETE`.
   *
   * Ответ — `204` без тела, поэтому новое состояние строки экран ставит сам:
   * строка остаётся на месте и становится «Не в прайсе», а «Опубликовать»
   * возвращает её в прайс. Повторное нажатие во время запроса невозможно:
   * кнопки строки неактивны и помечены `aria-busy`.
   */
  async function confirmDelete(item: Tariff): Promise<void> {
    if (busyIds.has(item.id)) return;
    clearActionError();
    setConfirmingId(null);
    setBusyIds((current) => new Set(current).add(item.id));
    try {
      await deleteTariff(item.id);
      setState((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              items: current.items.map((row) =>
                row.id === item.id ? { ...row, is_visible: false } : row,
              ),
            }
          : current,
      );
    } catch (error: unknown) {
      setActionError(errorMessage(error, DELETE_ERROR));
    } finally {
      // Кнопки строки снова доступны — самое время вернуть в неё фокус.
      focusAfterRender.current = item.id;
      setBusyIds((current) => {
        const rest = new Set(current);
        rest.delete(item.id);
        return rest;
      });
    }
  }

  /**
   * Возврат в прайс: `PATCH` с единственным полем `is_visible: true`.
   *
   * Ответ — строка целиком, и она заменяет прежнюю: пересчитанный `price_label`
   * и настоящее состояние приходят от сервера, а не угадываются на клиенте.
   */
  async function handlePublish(item: Tariff): Promise<void> {
    if (busyIds.has(item.id)) return;
    clearActionError();
    setBusyIds((current) => new Set(current).add(item.id));
    try {
      const updated = await updateTariff(item.id, { is_visible: true });
      replaceRow(updated);
    } catch (error: unknown) {
      setActionError(errorMessage(error, PUBLISH_ERROR));
    } finally {
      setBusyIds((current) => {
        const rest = new Set(current);
        rest.delete(item.id);
        return rest;
      });
    }
  }

  const items = state.status === 'ready' ? state.items : [];

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--tariffs">
          <div className="page__head">
            <h1 className="page__title">Тарифы</h1>
            {items.length > 0 && (
              <p className="page__meta" data-testid="operator-tariffs-count">
                {headMeta(items)}
              </p>
            )}
          </div>

          {actionError !== null && (
            <p
              className="alert alert--error"
              id="tariff-error"
              role="alert"
              data-testid="operator-tariff-error"
            >
              {actionError}
            </p>
          )}

          {state.status === 'loading' && (
            <div
              className="state"
              role="status"
              aria-live="polite"
              data-testid="operator-tariffs-loading"
            >
              <span className="spinner" aria-hidden="true" />
              Загружаем тарифы…
            </div>
          )}

          {state.status === 'error' && (
            <p className="alert alert--error" role="alert" data-testid="operator-tariffs-error">
              {state.text}
            </p>
          )}

          {state.status === 'ready' && items.length === 0 && (
            <div className="empty" data-testid="operator-tariffs-empty">
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
                  <path d="M10.5 4.5H5.5a1 1 0 0 0-1 1v5l9 9 5-5z" />
                  <circle cx="8.3" cy="8.3" r="1.1" />
                </svg>
              </span>
              <h2>Тарифов пока нет</h2>
              <p>
                Строки прайса приходят из миграции базы: завести тариф из кабинета нельзя. Если
                прайс должен быть, проверьте, что миграции применены.
              </p>
            </div>
          )}

          {state.status === 'ready' && items.length > 0 && (
            <div className="list" data-testid="operator-tariffs">
              <table className="list__table">
                <caption className="visually-hidden">
                  Прайс: название, описание, цена, период, количество пользователей, состояние и
                  действия
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Название</th>
                    <th scope="col">Описание</th>
                    <th scope="col">Цена</th>
                    <th scope="col">Период</th>
                    <th scope="col">Пользователей</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">
                      <span className="visually-hidden">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const editing = editingId === item.id;
                    const busy = busyIds.has(item.id);
                    const confirming = confirmingId === item.id;
                    return (
                      <Fragment key={item.id}>
                        <tr
                          className={[
                            'tariff',
                            item.is_visible ? null : 'tariff--hidden',
                            editing ? 'tariff--open' : null,
                          ]
                            .filter((value): value is string => value !== null)
                            .join(' ')}
                          data-testid="operator-tariff-row"
                        >
                          <td className="tariff__name-cell">
                            <span className="tariff__name" data-testid="operator-tariff-name">
                              {item.name}
                            </span>
                          </td>
                          <td
                            className="tariff__description"
                            data-testid="operator-tariff-description"
                          >
                            <span className="cell__label">Описание:</span>
                            {item.description ?? NONE}
                          </td>
                          <td className="tariff__price" data-testid="operator-tariff-price">
                            <span className="cell__label">Цена:</span>
                            {item.price_label}
                          </td>
                          <td className="tariff__period" data-testid="operator-tariff-period">
                            <span className="cell__label">Период:</span>
                            {periodLabel(item.period)}
                          </td>
                          <td
                            className={
                              item.max_members === null
                                ? 'tariff__members tariff__members--none'
                                : 'tariff__members'
                            }
                            data-testid="operator-tariff-members"
                          >
                            <span className="cell__label">Пользователей:</span>
                            {membersLabel(item.max_members)}
                          </td>
                          <td className="tariff__state">
                            <span
                              className={item.is_visible ? 'flag' : 'flag flag--off'}
                              data-testid="operator-tariff-state"
                            >
                              <span className="flag__dot" aria-hidden="true" />
                              {item.is_visible ? 'В прайсе' : 'Не в прайсе'}
                            </span>
                          </td>
                          <td className="list__action">
                            <div
                              className="row-actions"
                              ref={(node) => {
                                rowActions.current[item.id] = node;
                              }}
                            >
                              {item.is_visible ? (
                                confirming ? (
                                  <>
                                    <button
                                      className="btn btn--danger btn--compact"
                                      type="button"
                                      onClick={() => void confirmDelete(item)}
                                      disabled={busy}
                                      aria-busy={busy ? true : undefined}
                                      data-testid="operator-tariff-delete-confirm"
                                    >
                                      Подтвердить
                                    </button>
                                    <button
                                      className="btn btn--ghost btn--compact"
                                      type="button"
                                      onClick={() => declineDelete(item.id)}
                                      disabled={busy}
                                      data-testid="operator-tariff-delete-decline"
                                    >
                                      Не надо
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="btn btn--ghost btn--compact btn--danger"
                                    type="button"
                                    onClick={() => askDelete(item.id)}
                                    disabled={busy}
                                    aria-busy={busy ? true : undefined}
                                    data-testid="operator-tariff-delete"
                                  >
                                    Удалить
                                  </button>
                                )
                              ) : (
                                <button
                                  className="btn btn--primary btn--compact"
                                  type="button"
                                  onClick={() => void handlePublish(item)}
                                  disabled={busy}
                                  aria-busy={busy ? true : undefined}
                                  data-testid="operator-tariff-publish"
                                >
                                  Опубликовать
                                </button>
                              )}
                              <button
                                className="btn btn--ghost btn--compact"
                                type="button"
                                aria-expanded={editing}
                                aria-controls={editing ? `tariff-form-${item.id}` : undefined}
                                onClick={() => (editing ? handleCancel() : handleEdit(item))}
                                disabled={busy}
                                data-testid="operator-tariff-edit"
                              >
                                Изменить
                              </button>
                            </div>
                          </td>
                        </tr>

                        {editing && form !== null && (
                          <tr className="edit-row">
                            <td colSpan={7}>
                              <form
                                className="form form--row"
                                id={`tariff-form-${item.id}`}
                                noValidate
                                onSubmit={(event) => void handleSave(event)}
                              >
                                <div className="form__grid">
                                  <div className="field field--name">
                                    <label
                                      className="field__label"
                                      htmlFor={`tariff-${item.id}-name`}
                                    >
                                      Название
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`tariff-${item.id}-name`}
                                      ref={nameInput}
                                      type="text"
                                      maxLength={120}
                                      value={form.name}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('name', event.target.value)
                                      }
                                      aria-invalid={errorField === 'name' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'name' ? 'tariff-error' : undefined
                                      }
                                      data-testid="operator-tariff-name-input"
                                    />
                                  </div>
                                  <div className="field field--amount">
                                    <label
                                      className="field__label"
                                      htmlFor={`tariff-${item.id}-amount`}
                                    >
                                      Цена
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`tariff-${item.id}-amount`}
                                      type="text"
                                      inputMode="decimal"
                                      value={form.amount}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('amount', event.target.value)
                                      }
                                      aria-invalid={errorField === 'amount' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'amount' ? 'tariff-error' : undefined
                                      }
                                      data-testid="operator-tariff-amount-input"
                                    />
                                    <p className="field__hint">В рублях, копейки через точку</p>
                                  </div>
                                  <div className="field field--period">
                                    <label
                                      className="field__label"
                                      htmlFor={`tariff-${item.id}-period`}
                                    >
                                      Период
                                    </label>
                                    <div className="select">
                                      <select
                                        className="field__input select__input"
                                        id={`tariff-${item.id}-period`}
                                        value={form.period}
                                        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                          handlePeriod(event.target.value as TariffPeriod)
                                        }
                                        aria-invalid={errorField === 'period' ? true : undefined}
                                        aria-describedby={
                                          errorField === 'period' ? 'tariff-error' : undefined
                                        }
                                        data-testid="operator-tariff-period-input"
                                      >
                                        {PERIODS.map((option) => (
                                          <option key={option.value} value={option.value}>
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                      <svg
                                        className="select__icon"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                      >
                                        <path d="m6 9 6 6 6-6" />
                                      </svg>
                                    </div>
                                  </div>
                                  <div className="field field--description">
                                    <label
                                      className="field__label"
                                      htmlFor={`tariff-${item.id}-description`}
                                    >
                                      Описание
                                    </label>
                                    <textarea
                                      className="field__input field__input--area"
                                      id={`tariff-${item.id}-description`}
                                      rows={2}
                                      value={form.description}
                                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                                        handleChange('description', event.target.value)
                                      }
                                      data-testid="operator-tariff-description-input"
                                    />
                                  </div>
                                  <div className="field field--members">
                                    <label
                                      className="field__label"
                                      htmlFor={`tariff-${item.id}-members`}
                                    >
                                      Пользователей
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`tariff-${item.id}-members`}
                                      type="text"
                                      inputMode="numeric"
                                      value={form.members}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('members', event.target.value)
                                      }
                                      aria-invalid={errorField === 'members' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'members'
                                          ? membersError !== null
                                            ? `tariff-${item.id}-members-error`
                                            : 'tariff-error'
                                          : undefined
                                      }
                                      data-testid="operator-tariff-members-input"
                                    />
                                    {membersError !== null ? (
                                      <p
                                        className="field__error"
                                        id={`tariff-${item.id}-members-error`}
                                      >
                                        {membersError}
                                      </p>
                                    ) : (
                                      <p className="field__hint">Пусто — без ограничения</p>
                                    )}
                                  </div>
                                </div>
                                <div className="form__actions">
                                  <button
                                    className="btn btn--primary"
                                    type="submit"
                                    disabled={saving}
                                    aria-busy={saving ? true : undefined}
                                    data-testid="operator-tariff-save"
                                  >
                                    {saving ? 'Сохраняем…' : 'Сохранить'}
                                  </button>
                                  <button
                                    className="btn btn--ghost"
                                    type="button"
                                    onClick={handleCancel}
                                    disabled={saving}
                                    data-testid="operator-tariff-cancel"
                                  >
                                    Отмена
                                  </button>
                                </div>
                              </form>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>

              <p className="list__note">
                «Удалить» снимает тариф с продажи: строка остаётся в прайсе, у организаций с этим
                тарифом подписка доживает оплаченный период, выставленные счета не меняются.
              </p>
            </div>
          )}
        </div>
      </main>
    </Screen>
  );
}
