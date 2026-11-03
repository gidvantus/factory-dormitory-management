import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import { ApiError, invoiceFileUrl, listInvoices, updateInvoiceStatus } from '../api/client';
import type { InvoiceItemKind, InvoiceStatus, PlatformInvoice } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NONE, NO_NAME, formatDay, plural } from '../lib/format';

/**
 * Размер страницы. Столько же, сколько кабинет-API отдаёт по умолчанию
 * (`DEFAULT_LIMIT = 50` в `operator/backend/app/api/invoices.py`):
 * «Показать ещё» догружает следующую такую же страницу.
 */
const PAGE_SIZE = 50;

/** Задержка поиска: запрос уходит, когда оператор перестал печатать. */
const SEARCH_DELAY_MS = 300;

/** Текст для сети, где `detail` сервера нет вовсе. */
const LOAD_ERROR = 'Не удалось загрузить счета';
const ACTION_ERROR = 'Не удалось изменить статус счёта';

/**
 * Статусы для фильтра. Подписи — из макета постановки (`mockups/149/`); в
 * строке реестра статус печатается из `status_label` ответа, а не отсюда.
 */
const STATUS_FILTERS: ReadonlyArray<{ value: InvoiceStatus | ''; label: string }> = [
  { value: '', label: 'Все статусы' },
  { value: 'new', label: 'Новый' },
  { value: 'paid', label: 'Оплачен' },
  { value: 'closed', label: 'Закрыт' },
  { value: 'cancelled', label: 'Отменён' },
];

/**
 * Вид предмета словами: оплата тарифа продлевает подписку, оплата решения
 * выдаёт право. Это разное следствие одной кнопки, поэтому вид назван словом.
 * Неизвестное значение показывается как пришло.
 */
const ITEM_KIND_LABELS: Readonly<Record<string, string>> = {
  tariff: 'Тариф',
  solution: 'Решение',
};

type StatusFilter = InvoiceStatus | '';

type ListState =
  | { status: 'loading' }
  | {
      status: 'ready';
      items: PlatformInvoice[];
      total: number;
      /** Применённые фильтры: по ним различаются «пусто» и «ничего не найдено». */
      search: string;
      statusFilter: StatusFilter;
    }
  | { status: 'error'; text: string };

/**
 * Текст отказа для экрана.
 *
 * Контракт кабинета: `detail` показывается дословно. Сюда приходят и тексты
 * основного API через прокси («Счёт не найден», «Так нельзя изменить статус
 * счёта»), поэтому переписывать их нельзя — исключение только для сети, где
 * текста сервера нет вовсе.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}

/** Заголовок со счётчиком: `1 счёт`, `3 счёта`, `12 счетов`. */
function totalLabel(total: number): string {
  return `${total} ${plural(total, ['счёт', 'счёта', 'счетов'])}`;
}

/** Подпись статуса для условия в пустом результате фильтра. */
function statusFilterLabel(value: StatusFilter): string {
  return STATUS_FILTERS.find((option) => option.value === value)?.label ?? value;
}

/**
 * Объяснение пустого результата фильтра: названы ровно те условия, которые
 * оператор поставил, иначе «Ничего не найдено» не отличить от пустой платформы.
 */
function nothingFoundText(search: string, statusFilter: StatusFilter): string {
  const status = statusFilterLabel(statusFilter);
  if (search !== '' && statusFilter !== '') {
    return `По запросу «${search}» в статусе «${status}» счетов нет. Поиск идёт по названию организации и ИНН, регистр не важен.`;
  }
  if (search !== '') {
    return `По запросу «${search}» счетов нет. Поиск идёт по названию организации и ИНН, регистр не важен.`;
  }
  return `В статусе «${status}» счетов нет. Сбросьте фильтр или выберите другой статус.`;
}

/** Предмет счёта: у тарифного и у счёта за решение название лежит в одном поле. */
function itemName(item: PlatformInvoice): string {
  return item.tariff_name ?? NONE;
}

/** Вид предмета словами; неизвестный вид печатается как пришло. */
function itemKindLabel(kind: InvoiceItemKind): string {
  return ITEM_KIND_LABELS[kind] ?? kind;
}

/**
 * Реестр счетов всех организаций платформы.
 *
 * Данные приходят из кабинета-API (`GET /api/invoices`), тот читает их в
 * основном API по сервисному токену. Фильтры уходят параметрами: `status` и
 * `search` — подстрока названия организации или ИНН без учёта регистра, правило
 * живёт в основном API.
 *
 * Состояния: загрузка, ошибка (текст `detail` дословно), пустая платформа
 * («Счетов пока нет»), пустой результат фильтра («Ничего не найдено»),
 * заполненный список с «Показать ещё». Кнопка видна, пока показано меньше `total`.
 *
 * Оплата и отмена необратимы, поэтому обе команды двухшаговые: первая кнопка
 * заменяется парой «Подтвердить» / «Не надо», и только «Подтвердить» отправляет
 * `PATCH`. Отказ действия — `detail` в `role="alert"` над реестром; список и
 * фильтры при этом не перезагружаются.
 */
export function Invoices(): JSX.Element {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  // Какая команда ждёт подтверждения в строке: `paid` или `cancelled`.
  const [confirming, setConfirming] = useState<Record<number, InvoiceStatus>>({});
  // Строки, по которым сейчас идёт запрос: их кнопки неактивны и помечены
  // `aria-busy`. Набор, а не одна строка: соседние строки не блокируют друг
  // друга, и вторая оплата не теряется, пока идёт первая (кадр 3 макета).
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  // Ссылки на документ строки — куда вернуть фокус после «Подтвердить».
  const rowLinks = useRef<Record<number, HTMLAnchorElement | null>>({});
  // Строка, которой фокус нужен после ближайшей перерисовки: кнопка
  // «Подтвердить» исчезает из DOM до ответа, и без этого фокус уехал бы на `body`.
  const focusAfterRender = useRef<number | null>(null);
  // Номер запроса: ответ на устаревший поиск не должен затирать свежий.
  const requestId = useRef(0);
  // Первая загрузка идёт сразу: пауза нужна поиску, а не открытию раздела.
  const firstLoad = useRef(true);
  // Запрос зависит от того, что реально уйдёт на сервер, а не от набранного:
  // пробел в конце значения подстроку не меняет, и повторять запрос не за чем.
  const query = search.trim();

  useEffect(() => {
    const id = ++requestId.current;
    setState({ status: 'loading' });
    // Строки переезжают — подтверждение, начатое в старой выборке, к новой не
    // относится; отказ прошлого действия к новому фильтру тоже.
    setConfirming({});
    setActionError(null);
    const delay = firstLoad.current ? 0 : SEARCH_DELAY_MS;
    firstLoad.current = false;
    const timer = setTimeout(() => {
      listInvoices({ limit: PAGE_SIZE, offset: 0, status: statusFilter, search: query }).then(
        (page) => {
          if (requestId.current !== id) return;
          setState({
            status: 'ready',
            items: page.items,
            total: page.total,
            search: query,
            statusFilter,
          });
        },
        (error: unknown) => {
          if (requestId.current !== id) return;
          setState({ status: 'error', text: errorMessage(error, LOAD_ERROR) });
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [query, statusFilter]);

  /**
   * Возврат фокуса в строку после «Подтвердить».
   *
   * Пара подтверждения снимается до запроса, поэтому нажатая кнопка исчезает из
   * DOM и фокус уехал бы на `body` — следующий Tab начал бы обход таблицы
   * сначала. Ссылка «Скачать счёт» не исчезает ни при успехе, ни при `409`,
   * поэтому фокус ставится на неё.
   */
  useEffect(() => {
    const id = focusAfterRender.current;
    if (id === null) return;
    focusAfterRender.current = null;
    rowLinks.current[id]?.focus();
  });

  async function handleMore(): Promise<void> {
    if (state.status !== 'ready' || loadingMore) return;
    const id = requestId.current;
    const offset = state.items.length;
    setLoadingMore(true);
    try {
      const page = await listInvoices({
        limit: PAGE_SIZE,
        offset,
        status: state.statusFilter,
        search: state.search,
      });
      if (requestId.current !== id) return;
      setState((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              items: [...current.items, ...page.items],
              total: page.total,
              search: current.search,
              statusFilter: current.statusFilter,
            }
          : current,
      );
    } catch (error: unknown) {
      if (requestId.current !== id) return;
      setState({ status: 'error', text: errorMessage(error, LOAD_ERROR) });
    } finally {
      setLoadingMore(false);
    }
  }

  /** Первый шаг: команда только спрашивает подтверждение, запроса ещё нет. */
  function askStatus(item: PlatformInvoice, status: InvoiceStatus): void {
    setActionError(null);
    setConfirming((current) => ({ ...current, [item.id]: status }));
  }

  /** Отказ от подтверждения: строка возвращается в прежний вид. */
  function declineStatus(id: number): void {
    setConfirming((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  /**
   * Второй шаг: единственное место, откуда уходит `PATCH`.
   *
   * Пара подтверждения снимается сразу, а кнопки этой строки на время запроса
   * неактивны с `aria-busy`: повторное нажатие не отправит вторую команду.
   * Занятость считается по строке, а не по экрану, — соседние строки остаются
   * живыми, и вторая команда не теряется, пока идёт первая.
   * Успех заменяет строку ответом сервера (`status_label` — оттуда дословно),
   * фильтры и страница остаются на месте; отказ — текст `detail` над реестром.
   */
  async function confirmStatus(item: PlatformInvoice): Promise<void> {
    const next = confirming[item.id];
    if (next === undefined || busyIds.has(item.id)) return;
    setBusyIds((current) => new Set(current).add(item.id));
    setActionError(null);
    // Кнопка, которая сейчас в фокусе, исчезнет на следующей перерисовке.
    focusAfterRender.current = item.id;
    declineStatus(item.id);
    try {
      const updated = await updateInvoiceStatus(item.id, next);
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: current.items.map((row) => (row.id === updated.id ? updated : row)),
            }
          : current,
      );
    } catch (error: unknown) {
      setActionError(errorMessage(error, ACTION_ERROR));
    } finally {
      setBusyIds((current) => {
        const rest = new Set(current);
        rest.delete(item.id);
        return rest;
      });
    }
  }

  function handleReset(): void {
    setSearch('');
    setStatusFilter('');
    setActionError(null);
  }

  const filtered = state.status === 'ready' && (state.search !== '' || state.statusFilter !== '');

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--invoices">
          <div className="page__head">
            <h1 className="page__title">Счета</h1>
            {state.status === 'ready' && state.total > 0 && (
              <p className="page__meta">{totalLabel(state.total)}</p>
            )}
          </div>

          <div className="toolbar">
            <div className="search">
              <label className="visually-hidden" htmlFor="invoices-search">
                Поиск по названию или ИНН
              </label>
              <svg
                className="search__icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
              <input
                className="field__input"
                id="invoices-search"
                type="search"
                value={search}
                placeholder="Название или ИНН"
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
                data-testid="operator-invoices-search"
              />
            </div>
            <div className="select">
              <label className="visually-hidden" htmlFor="invoices-status">
                Статус счёта
              </label>
              <select
                className="field__input select__input"
                id="invoices-status"
                value={statusFilter}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setStatusFilter(event.target.value as StatusFilter)
                }
                data-testid="operator-invoices-status"
              >
                {STATUS_FILTERS.map((option) => (
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
            <button
              className="btn btn--ghost btn--compact"
              type="button"
              onClick={handleReset}
              data-testid="operator-invoices-reset"
            >
              Сбросить
            </button>
          </div>

          {actionError !== null && (
            <p
              className="alert alert--error"
              role="alert"
              data-testid="operator-invoices-action-error"
            >
              {actionError}
            </p>
          )}

          {state.status === 'loading' && (
            <div
              className="state"
              role="status"
              aria-live="polite"
              data-testid="operator-invoices-loading"
            >
              <span className="spinner" aria-hidden="true" />
              Загружаем счета…
            </div>
          )}

          {state.status === 'error' && (
            <p className="alert alert--error" role="alert" data-testid="operator-invoices-error">
              {state.text}
            </p>
          )}

          {state.status === 'ready' && state.items.length === 0 && !filtered && (
            <div className="empty" data-testid="operator-invoices-empty">
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
                  <path d="M5.5 3.5h9l4 4v13h-13z" />
                  <path d="M14.5 3.5v4h4M8.5 12h6M8.5 15.5h4" />
                </svg>
              </span>
              <h2>Счетов пока нет</h2>
              <p>
                Счета выставляют организации из своих кабинетов — за тариф или решение магазина. Как
                только появится первый счёт, он будет здесь: оплата, отмена и документы в одной
                строке.
              </p>
            </div>
          )}

          {state.status === 'ready' && state.items.length === 0 && filtered && (
            <div className="empty empty--compact" data-testid="operator-invoices-empty">
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
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="m16 16 4.5 4.5" />
                </svg>
              </span>
              <h2>Ничего не найдено</h2>
              <p>{nothingFoundText(state.search, state.statusFilter)}</p>
            </div>
          )}

          {state.status === 'ready' && state.items.length > 0 && (
            <div className="list" data-testid="operator-invoices">
              <table className="list__table">
                <caption className="visually-hidden">
                  Счета организаций: номер и дата, организация, предмет, сумма, статус, действия
                </caption>
                <thead>
                  <tr>
                    <th scope="col">№ счёта</th>
                    <th scope="col">Организация</th>
                    <th scope="col">Предмет</th>
                    <th scope="col">Сумма</th>
                    <th scope="col">Статус</th>
                    <th scope="col">
                      <span className="visually-hidden">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => {
                    const pending = confirming[item.id];
                    const busy = busyIds.has(item.id);
                    // Статусные кнопки есть только у нового счёта: из `paid`
                    // дорога одна — в `closed`, а «Закрыть» в кабинете нет.
                    const canChange = item.status === 'new';
                    return (
                      <tr key={item.id} data-testid="operator-invoice-row">
                        <td className="list__num-cell">
                          <span className="invoice__number" data-testid="operator-invoice-number">
                            {item.number}
                          </span>
                          <span className="invoice__date" data-testid="operator-invoice-date">
                            {formatDay(item.created_at)}
                          </span>
                        </td>
                        <td className="list__org">
                          <span
                            className="invoice__org"
                            data-testid="operator-invoice-organization"
                          >
                            {item.organization_name ?? NO_NAME}
                          </span>
                        </td>
                        <td className="list__item">
                          <span className="invoice__kind">{itemKindLabel(item.item_kind)}</span>
                          <span className="invoice__item" data-testid="operator-invoice-item">
                            {itemName(item)}
                          </span>
                        </td>
                        <td className="list__amount">
                          <span
                            className={
                              canChange ? 'invoice__amount invoice__amount--due' : 'invoice__amount'
                            }
                            data-testid="operator-invoice-amount"
                          >
                            {item.amount_label}
                          </span>
                        </td>
                        <td className="list__status">
                          <span
                            className={`invoice__status invoice__status--${item.status}`}
                            data-testid="operator-invoice-status"
                          >
                            <span
                              className={`status-dot status-dot--${item.status}`}
                              aria-hidden="true"
                            />
                            {item.status_label}
                          </span>
                        </td>
                        <td className="list__action">
                          <div className="row-actions">
                            <div className="row-actions__docs">
                              <a
                                className="doc-link"
                                href={invoiceFileUrl(item.id, 'invoice')}
                                ref={(node) => {
                                  rowLinks.current[item.id] = node;
                                }}
                                data-testid="operator-invoice-download"
                              >
                                Скачать счёт
                              </a>
                              {item.has_act && (
                                <a
                                  className="doc-link"
                                  href={invoiceFileUrl(item.id, 'act')}
                                  data-testid="operator-invoice-act"
                                >
                                  Скачать акт
                                </a>
                              )}
                            </div>
                            {canChange && (
                              <div className="row-actions__acts">
                                {pending === undefined ? (
                                  <>
                                    <button
                                      className="btn btn--ghost btn--compact btn--danger"
                                      type="button"
                                      onClick={() => askStatus(item, 'cancelled')}
                                      disabled={busy}
                                      aria-busy={busy ? true : undefined}
                                      data-testid="operator-invoice-cancel"
                                    >
                                      Отменить
                                    </button>
                                    <button
                                      className="btn btn--primary btn--compact"
                                      type="button"
                                      onClick={() => askStatus(item, 'paid')}
                                      disabled={busy}
                                      aria-busy={busy ? true : undefined}
                                      data-testid="operator-invoice-pay"
                                    >
                                      Оплатить
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      className="btn btn--primary btn--compact"
                                      type="button"
                                      onClick={() => void confirmStatus(item)}
                                      disabled={busy}
                                      aria-busy={busy ? true : undefined}
                                      data-testid="operator-invoice-confirm"
                                    >
                                      Подтвердить
                                    </button>
                                    <button
                                      className="btn btn--ghost btn--compact"
                                      type="button"
                                      onClick={() => declineStatus(item.id)}
                                      disabled={busy}
                                      aria-busy={busy ? true : undefined}
                                      data-testid="operator-invoice-confirm-decline"
                                    >
                                      Не надо
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="list__foot">
                <p className="list__shown">
                  Показано {state.items.length} из {state.total}
                </p>
                {state.items.length < state.total && (
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={handleMore}
                    disabled={loadingMore}
                    aria-busy={loadingMore ? true : undefined}
                    data-testid="operator-invoices-more"
                  >
                    Показать ещё
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </Screen>
  );
}
