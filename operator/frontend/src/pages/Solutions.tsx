import { Fragment, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';

import { ApiError, deleteSolution, listSolutions, updateSolution } from '../api/client';
import type { Solution, SolutionPatch, SolutionPeriod } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NONE, formatDay, plural } from '../lib/format';

/** Текст для сети, где `detail` сервера нет вовсе. */
const LOAD_ERROR = 'Не удалось загрузить решения';
const SAVE_ERROR = 'Не удалось сохранить решение';
const DELETE_ERROR = 'Не удалось снять решение с продажи';
const PUBLISH_ERROR = 'Не удалось вернуть решение в каталог';
/** Своя проверка формы: поле «Порядок» обязано быть целым числом. */
const POSITION_ERROR = 'Порядок — целое число';

/**
 * Подписи периодов: словарь экрана, коды — из ответа API.
 *
 * Пять значений и их тексты задаёт контракт постановки (`TARIFF_PERIODS` в
 * основном API): фронт владеет подписями и порядком `select`, а значения
 * (`period`) приходят из API. Цену экран не собирает — печатает готовый
 * `price_label`, чтобы формула цены осталась одна на весь API.
 */
const PERIODS: ReadonlyArray<{ value: SolutionPeriod; label: string }> = [
  { value: 'month', label: 'в месяц' },
  { value: 'quarter', label: 'за 3 месяца' },
  { value: 'half_year', label: 'за 6 месяцев' },
  { value: 'year', label: 'в год' },
  { value: 'once', label: 'разово' },
];

/** Два состояния строки: `is_visible` в форме — это `select` из двух значений. */
const STATES: ReadonlyArray<{ value: 'true' | 'false'; label: string }> = [
  { value: 'true', label: 'В каталоге' },
  { value: 'false', label: 'Не в каталоге' },
];

/**
 * Поле формы, к которому относится отказ сервера.
 *
 * Основной API отвечает русским текстом (`Контракт половин`), и экран узнаёт
 * поле по самому тексту — списком тех сообщений, которые называет контракт.
 * Приставку `Value error, ` уже снял `client.ts`, а несколько сообщений он
 * склеивает через `; ` — виноватым считается первое. `409` — это всегда занятое
 * название. Незнакомый отказ поля не помечает: выдумывать связь нельзя, а текст
 * ошибки всё равно показан дословно.
 */
type FieldName =
  'name' | 'description' | 'amount' | 'currency' | 'period' | 'position' | 'is_visible';

const FIELD_MESSAGES: Readonly<Record<FieldName, readonly string[]>> = {
  name: ['Название не может быть пустым', 'Название длиннее 120 символов'],
  description: ['Описание должно быть строкой'],
  amount: ['Цена не может быть отрицательной', 'Слишком большая цена', 'Цена должна быть числом'],
  currency: ['Валюта должна состоять из 3 заглавных латинских букв'],
  period: ['Неизвестный период оплаты'],
  position: [
    'Порядок должен быть целым числом',
    'Порядок не может быть отрицательным',
    'Слишком большой порядок',
  ],
  is_visible: ['Состояние должно быть true или false'],
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
function periodLabel(period: SolutionPeriod): string {
  return PERIODS.find((option) => option.value === period)?.label ?? period;
}

/** Заголовок со счётчиком: `3 решения · 2 в каталоге`. */
function headMeta(items: Solution[]): string {
  const visible = items.filter((item) => item.is_visible).length;
  return `${items.length} ${plural(items.length, ['решение', 'решения', 'решений'])} · ${visible} в каталоге`;
}

/**
 * Код решения с переносом по подчёркиванию: `telegram_` / `notifications`.
 *
 * Код — гейт функции, а не текст для чтения: он стоит тихой колонкой и не
 * должен рвать слово посередине, если места мало. `textContent` при этом
 * остаётся целым, поэтому тестировщик сверяет код одной строкой.
 */
function codeWithBreaks(code: string): ReactNode {
  const parts = code.split('_');
  return parts.map((part, index) => (
    <Fragment key={`${index}-${part}`}>
      {part}
      {index < parts.length - 1 && (
        <>
          _
          <wbr />
        </>
      )}
    </Fragment>
  ));
}

/**
 * Текст отказа для экрана.
 *
 * Контракт кабинета: `detail` показывается дословно. Сюда приходят и тексты
 * основного API через прокси («Решение не найдено», «Решение с таким названием
 * уже есть», сообщения валидаторов), поэтому переписывать их нельзя — исключение
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
  currency: string;
  period: SolutionPeriod;
  position: string;
  visible: 'true' | 'false';
}

/** Форма по строке каталога: значения — из последнего ответа сервера. */
function formFrom(item: Solution): EditForm {
  return {
    name: item.name,
    description: item.description ?? '',
    amount: item.amount,
    currency: item.currency,
    period: item.period,
    position: String(item.position),
    visible: item.is_visible ? 'true' : 'false',
  };
}

/**
 * Порядок витрины из поля формы.
 *
 * Отрицательное число уходит на сервер как есть: правило и его русский текст
 * («Порядок не может быть отрицательным») живут в основном API. А вот нечисло
 * отправить нечем — в контракте у `position` целое, и `"3"` строкой дало бы
 * «Порядок должен быть целым числом» на совершенно верный ввод, поэтому такой
 * ввод экран не пропускает и объясняет словами. Пустое поле тоже отказ:
 * у `position` нет значения «без порядка», в отличие от описания.
 */
function positionPayload(text: string): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (trimmed === '' || !/^-?\d+$/.test(trimmed)) {
    return { value: null, error: POSITION_ERROR };
  }
  return { value: Number(trimmed), error: null };
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: Solution[] }
  | { status: 'error'; text: string };

/**
 * Каталог решений магазина улучшений: список, правка полей и порядок витрины.
 *
 * Данные приходят из кабинета-API (`GET /api/solutions`), тот читает их в
 * основном API по сервисному токену. Список — плоский, без пагинации: строк
 * каталога единицы, порядок `position, id` держит сервер, и экран его не
 * пересортировывает — это и есть предмет согласования половин постановки:
 * порядок строк здесь равен порядку карточек в магазине клиента.
 *
 * Состояния: загрузка («Загружаем решения…»), ошибка (`detail` дословно и
 * «Повторить»), пустой каталог («Решений пока нет»), заполненный список с
 * открытой формой под строкой. Правка разворачивается в той же таблице:
 * модальных окон и отдельных страниц у кабинета нет.
 *
 * Создания строки нет намеренно: за новой строкой в коде нет платной функции, а
 * `code` — гейт права и `UNIQUE` в таблице, поэтому он только показывается.
 *
 * Необратимых команд две — «Удалить» и «Опубликовать», — и первая двухшаговая:
 * «Удалить» заменяется парой «Подтвердить» / «Не надо», и только «Подтвердить»
 * отправляет `DELETE`. «Удалить» не удаляет строку: сервер ставит
 * `is_visible = false`, поэтому после `204` экран помечает строку «Не в
 * каталоге» сам — тела с новым состоянием в ответе нет.
 */
export function Solutions(): JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  // Номер попытки загрузки: «Повторить» после отказа просто увеличивает его.
  const [attempt, setAttempt] = useState(0);
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
  // Отказ собственной проверки формы (нечисловой порядок).
  const [positionError, setPositionError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  // Строка, которой фокус нужен после ближайшей перерисовки: нажатая кнопка
  // исчезает из DOM до ответа, и без этого фокус уехал бы на `body`.
  const focusAfterRender = useRef<number | null>(null);
  const rowActions = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    listSolutions().then(
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
  }, [attempt]);

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
      ?.querySelector<HTMLButtonElement>('[data-testid="operator-solution-edit"]')
      ?.focus();
  });

  function clearActionError(): void {
    setActionError(null);
    setErrorField(null);
  }

  function handleEdit(item: Solution): void {
    clearActionError();
    setPositionError(null);
    setConfirmingId(null);
    setEditingId(item.id);
    setForm(formFrom(item));
  }

  function handleCancel(): void {
    clearActionError();
    setPositionError(null);
    setEditingId(null);
    setForm(null);
  }

  /** Правка текстового поля формы: у `period` и состояния свои обработчики. */
  function handleChange(
    field: 'name' | 'description' | 'amount' | 'currency' | 'position',
    value: string,
  ): void {
    setForm((current) => (current === null ? current : { ...current, [field]: value }));
  }

  /** Период выбирается из пяти значений контракта, а не набирается руками. */
  function handlePeriod(value: SolutionPeriod): void {
    setForm((current) => (current === null ? current : { ...current, period: value }));
  }

  /** Состояние — два значения контракта: `true` в каталоге, `false` снято. */
  function handleVisible(value: 'true' | 'false'): void {
    setForm((current) => (current === null ? current : { ...current, visible: value }));
  }

  /** Замена строки ответом сервера: `price_label` уже пересчитан им. */
  function replaceRow(updated: Solution): void {
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
   * Отправляются все семь полей — так требует контракт: пустое описание уходит
   * как `null`. Порядок строки список не пересортировывает: место строки в
   * реестре — это ответ сервера на следующий `GET`, а не догадка клиента.
   * Отказ сервера форму не сбрасывает: введённое остаётся, текст `detail`
   * показывается дословно над списком, виноватое поле помечается `aria-invalid`.
   */
  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (form === null || editingId === null || saving) return;
    const position = positionPayload(form.position);
    if (position.error !== null || position.value === null) {
      setPositionError(position.error ?? POSITION_ERROR);
      setErrorField('position');
      return;
    }
    setPositionError(null);
    clearActionError();
    setSaving(true);
    const payload: SolutionPatch = {
      name: form.name,
      description: form.description.trim() === '' ? null : form.description,
      amount: form.amount,
      currency: form.currency,
      period: form.period,
      position: position.value,
      is_visible: form.visible === 'true',
    };
    try {
      const updated = await updateSolution(editingId, payload);
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
    setPositionError(null);
    setConfirmingId(id);
  }

  /** Отказ от подтверждения: строка возвращается в прежний вид. */
  function declineDelete(): void {
    setConfirmingId(null);
  }

  /**
   * Второй шаг удаления: единственное место, откуда уходит `DELETE`.
   *
   * Ответ — `204` без тела, поэтому новое состояние строки экран ставит сам:
   * строка остаётся на месте и становится «Не в каталоге», а «Опубликовать»
   * возвращает её в каталог. Повторное нажатие во время запроса невозможно:
   * кнопки строки неактивны и помечены `aria-busy`.
   */
  async function confirmDelete(item: Solution): Promise<void> {
    if (busyIds.has(item.id)) return;
    clearActionError();
    setConfirmingId(null);
    setBusyIds((current) => new Set(current).add(item.id));
    try {
      await deleteSolution(item.id);
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
   * Возврат в каталог: `PATCH` с единственным полем `is_visible: true`.
   *
   * Ответ — строка целиком, и она заменяет прежнюю: пересчитанный `price_label`
   * и настоящее состояние приходят от сервера, а не угадываются на клиенте.
   */
  async function handlePublish(item: Solution): Promise<void> {
    if (busyIds.has(item.id)) return;
    clearActionError();
    setBusyIds((current) => new Set(current).add(item.id));
    try {
      const updated = await updateSolution(item.id, { is_visible: true });
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
        <div className="page page--solutions">
          <div className="page__head">
            <h1 className="page__title">Решения</h1>
            {state.status === 'ready' && items.length > 0 && (
              <p className="page__meta" data-testid="operator-solutions-count">
                {headMeta(items)}
              </p>
            )}
          </div>

          {actionError !== null && (
            <p
              className="alert alert--error"
              id="solution-error"
              role="alert"
              data-testid="operator-solution-error"
            >
              {actionError}
            </p>
          )}

          {state.status === 'loading' && (
            <div
              className="state"
              role="status"
              aria-live="polite"
              data-testid="operator-solutions-loading"
            >
              <span className="spinner" aria-hidden="true" />
              Загружаем решения…
            </div>
          )}

          {state.status === 'error' && (
            <div className="alert-line" data-testid="operator-solutions-error">
              <p className="alert alert--error" role="alert">
                {state.text}
              </p>
              <button
                className="btn btn--ghost btn--compact"
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
                data-testid="operator-solutions-retry"
              >
                Повторить
              </button>
            </div>
          )}

          {state.status === 'ready' && items.length === 0 && (
            <div className="empty" data-testid="operator-solutions-empty">
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
              <h2>Решений пока нет</h2>
              <p>
                Строки каталога приходят из миграций базы: завести решение из кабинета нельзя. Если
                решения должны быть, проверьте, что миграции применены.
              </p>
            </div>
          )}

          {state.status === 'ready' && items.length > 0 && (
            <div className="list" data-testid="operator-solutions">
              <table className="list__table">
                <caption className="visually-hidden">
                  Каталог решений: порядок витрины, название, код, описание, цена, период,
                  состояние, даты создания и изменения, действия
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Порядок</th>
                    <th scope="col">Название</th>
                    <th scope="col">Код</th>
                    <th scope="col">Описание</th>
                    <th scope="col">Цена</th>
                    <th scope="col">Период</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">Создано</th>
                    <th scope="col">Изменено</th>
                    <th scope="col">
                      <span className="visually-hidden">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const editing = editingId === item.id;
                    // Пока идёт правка этой строки, её кнопки заперты: контракт
                    // требует неактивные кнопки строки на время отправки формы.
                    const busy = busyIds.has(item.id) || (saving && editing);
                    const confirming = confirmingId === item.id;
                    return (
                      <Fragment key={item.id}>
                        <tr
                          className={[
                            'solution',
                            item.is_visible ? null : 'solution--hidden',
                            editing ? 'solution--open' : null,
                          ]
                            .filter((value): value is string => value !== null)
                            .join(' ')}
                          data-testid="operator-solution-row"
                        >
                          <td
                            className="solution__position"
                            data-testid="operator-solution-position"
                          >
                            <span className="cell__label">Порядок:</span>
                            {item.position}
                          </td>
                          <td className="solution__name-cell">
                            <span className="solution__name" data-testid="operator-solution-name">
                              {item.name}
                            </span>
                          </td>
                          <td className="solution__code" data-testid="operator-solution-code">
                            <span className="cell__label">Код:</span>
                            {codeWithBreaks(item.code)}
                          </td>
                          <td
                            className="solution__description"
                            data-testid="operator-solution-description"
                          >
                            <span className="cell__label">Описание:</span>
                            {item.description ?? NONE}
                          </td>
                          <td className="solution__price" data-testid="operator-solution-price">
                            <span className="cell__label">Цена:</span>
                            {item.price_label}
                          </td>
                          <td className="solution__period" data-testid="operator-solution-period">
                            <span className="cell__label">Период:</span>
                            {periodLabel(item.period)}
                          </td>
                          <td className="solution__state-cell">
                            <span
                              className={item.is_visible ? 'flag' : 'flag flag--off'}
                              data-testid="operator-solution-state"
                            >
                              <span className="flag__dot" aria-hidden="true" />
                              {item.is_visible ? 'В каталоге' : 'Не в каталоге'}
                            </span>
                          </td>
                          <td
                            className="solution__date solution__created-cell"
                            data-testid="operator-solution-created"
                          >
                            <span className="cell__label">Создано:</span>
                            {formatDay(item.created_at)}
                          </td>
                          <td
                            className="solution__date solution__updated-cell"
                            data-testid="operator-solution-updated"
                          >
                            <span className="cell__label">Изменено:</span>
                            {formatDay(item.updated_at)}
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
                                      data-testid="operator-solution-delete-confirm"
                                    >
                                      Подтвердить
                                    </button>
                                    <button
                                      className="btn btn--ghost btn--compact"
                                      type="button"
                                      onClick={declineDelete}
                                      disabled={busy}
                                      data-testid="operator-solution-delete-decline"
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
                                    data-testid="operator-solution-delete"
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
                                  data-testid="operator-solution-publish"
                                >
                                  Опубликовать
                                </button>
                              )}
                              <button
                                className="btn btn--ghost btn--compact"
                                type="button"
                                aria-expanded={editing}
                                aria-controls={editing ? `solution-form-${item.id}` : undefined}
                                onClick={() => (editing ? handleCancel() : handleEdit(item))}
                                disabled={busy}
                                data-testid="operator-solution-edit"
                              >
                                Изменить
                              </button>
                            </div>
                          </td>
                        </tr>

                        {editing && form !== null && (
                          <tr className="edit-row">
                            <td colSpan={10}>
                              <form
                                className="form form--row"
                                id={`solution-form-${item.id}`}
                                noValidate
                                onSubmit={(event) => void handleSave(event)}
                              >
                                <div className="form__grid">
                                  <div className="field field--name">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-name`}
                                    >
                                      Название
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`solution-${item.id}-name`}
                                      ref={nameInput}
                                      type="text"
                                      maxLength={120}
                                      value={form.name}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('name', event.target.value)
                                      }
                                      aria-invalid={errorField === 'name' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'name' ? 'solution-error' : undefined
                                      }
                                      data-testid="operator-solution-name-input"
                                    />
                                  </div>
                                  <div className="field field--position">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-position`}
                                    >
                                      Порядок
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`solution-${item.id}-position`}
                                      type="text"
                                      inputMode="numeric"
                                      value={form.position}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('position', event.target.value)
                                      }
                                      aria-invalid={errorField === 'position' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'position'
                                          ? positionError !== null
                                            ? `solution-${item.id}-position-error`
                                            : 'solution-error'
                                          : undefined
                                      }
                                      data-testid="operator-solution-position-input"
                                    />
                                    {positionError !== null ? (
                                      <p
                                        className="field__error"
                                        id={`solution-${item.id}-position-error`}
                                      >
                                        {positionError}
                                      </p>
                                    ) : (
                                      <p className="field__hint">
                                        Меньше — выше в магазине. При равных значениях выше та
                                        строка, что создана раньше.
                                      </p>
                                    )}
                                  </div>
                                  <div className="field field--description">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-description`}
                                    >
                                      Описание
                                    </label>
                                    <textarea
                                      className="field__input field__input--area"
                                      id={`solution-${item.id}-description`}
                                      rows={2}
                                      value={form.description}
                                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                                        handleChange('description', event.target.value)
                                      }
                                      aria-invalid={errorField === 'description' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'description' ? 'solution-error' : undefined
                                      }
                                      data-testid="operator-solution-description-input"
                                    />
                                  </div>
                                  <div className="field field--state">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-visible`}
                                    >
                                      Состояние
                                    </label>
                                    <div className="select">
                                      <select
                                        className="field__input select__input"
                                        id={`solution-${item.id}-visible`}
                                        value={form.visible}
                                        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                          handleVisible(event.target.value as 'true' | 'false')
                                        }
                                        aria-invalid={
                                          errorField === 'is_visible' ? true : undefined
                                        }
                                        aria-describedby={
                                          errorField === 'is_visible' ? 'solution-error' : undefined
                                        }
                                        data-testid="operator-solution-visible-input"
                                      >
                                        {STATES.map((option) => (
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
                                  <div className="field field--amount">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-amount`}
                                    >
                                      Цена
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`solution-${item.id}-amount`}
                                      type="text"
                                      inputMode="decimal"
                                      value={form.amount}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('amount', event.target.value)
                                      }
                                      aria-invalid={errorField === 'amount' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'amount' ? 'solution-error' : undefined
                                      }
                                      data-testid="operator-solution-amount-input"
                                    />
                                    <p className="field__hint">Число, копейки через точку</p>
                                  </div>
                                  <div className="field field--currency">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-currency`}
                                    >
                                      Валюта
                                    </label>
                                    <input
                                      className="field__input"
                                      id={`solution-${item.id}-currency`}
                                      type="text"
                                      maxLength={3}
                                      value={form.currency}
                                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                        handleChange('currency', event.target.value)
                                      }
                                      aria-invalid={errorField === 'currency' ? true : undefined}
                                      aria-describedby={
                                        errorField === 'currency' ? 'solution-error' : undefined
                                      }
                                      data-testid="operator-solution-currency-input"
                                    />
                                    <p className="field__hint">Три заглавные латинские буквы</p>
                                  </div>
                                  <div className="field field--period">
                                    <label
                                      className="field__label"
                                      htmlFor={`solution-${item.id}-period`}
                                    >
                                      Период
                                    </label>
                                    <div className="select">
                                      <select
                                        className="field__input select__input"
                                        id={`solution-${item.id}-period`}
                                        value={form.period}
                                        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                          handlePeriod(event.target.value as SolutionPeriod)
                                        }
                                        aria-invalid={errorField === 'period' ? true : undefined}
                                        aria-describedby={
                                          errorField === 'period' ? 'solution-error' : undefined
                                        }
                                        data-testid="operator-solution-period-input"
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
                                </div>
                                <div className="form__actions">
                                  <button
                                    className="btn btn--primary"
                                    type="submit"
                                    disabled={saving}
                                    aria-busy={saving ? true : undefined}
                                    data-testid="operator-solution-save"
                                  >
                                    {saving ? 'Сохраняем…' : 'Сохранить'}
                                  </button>
                                  <button
                                    className="btn btn--ghost"
                                    type="button"
                                    onClick={handleCancel}
                                    disabled={saving}
                                    data-testid="operator-solution-cancel"
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
                Порядок витрины — это порядок строк: сверху вниз по значению «Порядок», при равных
                значениях выше та строка, что создана раньше. «Удалить» снимает решение с продажи:
                карточка уходит из магазина, и у организации с действующим правом пропадает пункт
                меню, хотя платная функция на сервере продолжает работать.
              </p>
            </div>
          )}
        </div>
      </main>
    </Screen>
  );
}
