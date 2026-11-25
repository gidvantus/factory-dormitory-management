import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, PAGE_SIZE, listJournal } from '../api/client';
import type { JournalEntry, JournalKind } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { plural } from '../lib/format';

/** Текст для отказа без `detail` (сеть, непредвиденный ответ). */
const LOAD_ERROR = 'Не удалось загрузить журнал';
const MORE_ERROR = 'Не удалось загрузить следующие записи';
const MOSCOW_ZONE = 'Europe/Moscow';
/** Период по умолчанию: последние 7 дней, включая сегодня (как в основном API). */
const DEFAULT_DAYS = 7;

/** Виды для фильтра: подписи совпадают с ячейкой «Вид» в строке. */
const KIND_OPTIONS: ReadonlyArray<{ value: JournalKind | ''; label: string }> = [
  { value: '', label: 'Все действия' },
  { value: 'security', label: 'Безопасность' },
  { value: 'data', label: 'Данные' },
  { value: 'noise', label: 'Служебное' },
];

const KIND_LABELS: Readonly<Record<string, string>> = {
  security: 'Безопасность',
  data: 'Данные',
  noise: 'Служебное',
};

/** Фраза пустого состояния по виду: «…событий по всем компаниям не записано». */
const KIND_PHRASE: Readonly<Record<string, string>> = {
  '': 'событий',
  security: 'событий безопасности',
  data: 'событий по данным',
  noise: 'служебных действий',
};

/** Поля фильтра: даты в `YYYY-MM-DD`, вид - пустой строкой «все». */
interface JournalFilters {
  from: string;
  to: string;
  kind: JournalKind | '';
}

type ErrorKind = 'range' | 'gateway';

type ViewState =
  | { status: 'loading' }
  | {
      status: 'ready';
      items: JournalEntry[];
      total: number;
      nextCursor: string | null;
      filters: JournalFilters;
    }
  | { status: 'error'; kind: ErrorKind; text: string; filters: JournalFilters };

/** Сегодняшняя дата по московскому календарю в `YYYY-MM-DD`. */
function moscowToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Сдвиг календарной даты `YYYY-MM-DD` на число дней, без учёта часового пояса машины. */
function shiftDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Период по умолчанию в поля формы: последние 7 дней по Москве. */
function defaultFilters(now: Date = new Date()): JournalFilters {
  const today = moscowToday(now);
  return { from: shiftDays(today, 1 - DEFAULT_DAYS), to: today, kind: '' };
}

/** `YYYY-MM-DD` → `DD.MM.YYYY`; при непонятном вводе значение печатается как есть. */
function ruDate(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match === null ? day : `${match[3]}.${match[2]}.${match[1]}`;
}

/** Дата записи в московском календаре: два поля ячейки «Когда». */
function momentDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso));
}

function momentTime(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Тон точки статуса: 2xx–3xx - шалфей, остальное - кирпич, без кода - полая. */
function statusTone(status: number | null): 'ok' | 'fail' | 'none' {
  if (status === null) return 'none';
  return status >= 200 && status < 400 ? 'ok' : 'fail';
}

/**
 * Текст отказа для экрана.
 *
 * Тексты основного API (422 по периоду, 502, 503) показываются дословно: кабинет
 * их не переписывает. Для 422 отдельный вид ошибки: кнопки «Повторить» нет, потому
 * что чинит её оператор, поправив даты.
 */
function classify(error: unknown, filters: JournalFilters): ViewState {
  if (error instanceof ApiError) {
    return {
      status: 'error',
      kind: error.status === 422 ? 'range' : 'gateway',
      text: error.message,
      filters,
    };
  }
  return { status: 'error', kind: 'gateway', text: LOAD_ERROR, filters };
}

/** Фраза для строки журнала: название действия или, при его отсутствии, код. */
function actionCell(entry: JournalEntry): { text: string; unknown: boolean } {
  return { text: entry.action_title, unknown: entry.action_title === entry.action };
}

/** Строка журнала: шесть ячеек по правилам постановки. */
function JournalRow({ entry }: { entry: JournalEntry }): JSX.Element {
  const action = actionCell(entry);
  const tone = statusTone(entry.status);
  const platform = entry.organization_id === null;
  const companyName = platform
    ? 'Платформа'
    : (entry.organization_name ?? `Организация №${entry.organization_id}`);
  const actorName =
    entry.actor_name ?? (entry.actor_id !== null ? `Сотрудник №${entry.actor_id}` : '—');
  const actorNone = entry.actor_name === null && entry.actor_id === null;
  const kindLabel = KIND_LABELS[entry.kind] ?? entry.kind;

  return (
    <>
      <tr className="journal__row" data-testid="operator-journal-row">
        <td className="journal__when" data-testid="operator-journal-when">
          <span className="journal__date">{momentDate(entry.created_at)}</span>
          <span className="journal__time">{momentTime(entry.created_at)}</span>
        </td>
        <td
          className={
            platform
              ? 'journal__company journal__company--platform'
              : entry.organization_name === null
                ? 'journal__company list__name--empty'
                : 'journal__company'
          }
          data-testid="operator-journal-company"
        >
          {companyName}
        </td>
        <td
          className={actorNone ? 'journal__actor journal__actor--none' : 'journal__actor'}
          data-testid="operator-journal-actor"
        >
          {actorName}
        </td>
        <td
          className="journal__action"
          data-unknown={action.unknown ? 'true' : undefined}
          data-testid="operator-journal-action"
        >
          {action.text}
        </td>
        <td
          className={`journal__kind journal__kind--${entry.kind}`}
          data-testid="operator-journal-kind-cell"
        >
          {kindLabel}
        </td>
        <td className="journal__status-cell" data-testid="operator-journal-status">
          <span className="journal__status" data-state={tone}>
            <span className="status-dot" aria-hidden="true" />
            {entry.status ?? '—'}
          </span>
          {entry.duration_ms !== null && (
            <span className="journal__ms"> {entry.duration_ms} мс</span>
          )}
        </td>
      </tr>
      <tr className="details-row">
        <td colSpan={6}>
          <details className="summary-block" data-testid="operator-journal-detail">
            <summary className="summary">
              <svg
                className="summary__chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <span className="summary__closed">Запись журнала</span>
              <span className="summary__open">Скрыть запись</span>
              <span className="summary__id">№ {entry.id}</span>
            </summary>
            <div className="json-wrap">
              <pre className="json" data-testid="operator-journal-json">
                {JSON.stringify(entry, null, 2)}
              </pre>
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

/** Скелет загрузки: три строки в той же таблице с теми же колонками. */
function SkeletonRows(): JSX.Element {
  return (
    <>
      {[0, 1, 2].map((index) => (
        <tr className="skeleton-row" key={index} aria-hidden="true">
          <td>
            <span className="skeleton skeleton--when" />
          </td>
          <td>
            <span className="skeleton skeleton--company" />
          </td>
          <td>
            <span className="skeleton skeleton--actor" />
          </td>
          <td>
            <span className="skeleton skeleton--action" />
          </td>
          <td>
            <span className="skeleton skeleton--kind" />
          </td>
          <td>
            <span className="skeleton skeleton--status" />
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * Журнал действий всех организаций платформы (`GET /api/journal` кабинета).
 *
 * Фильтры (период, вид) и курсор отдаёт основной API; экран только собирает
 * параметры и показывает ответ. Состояния: загрузка, пусто за период, отказ по
 * периоду (422 - `aria-invalid` на датах, без «Повторить»), отказ шлюза (502/503,
 * «Повторить»), лента с «Показать ещё» и отказом догрузки.
 */
export function Journal(): JSX.Element {
  const [form, setForm] = useState<JournalFilters>(() => defaultFilters());
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Номер запроса: ответ на устаревший фильтр не должен затереть свежий.
  const requestId = useRef(0);

  async function load(filters: JournalFilters): Promise<void> {
    const id = ++requestId.current;
    setView({ status: 'loading' });
    setMoreError(null);
    try {
      const page = await listJournal({
        kind: filters.kind,
        date_from: filters.from,
        date_to: filters.to,
        limit: PAGE_SIZE,
      });
      if (requestId.current !== id) return;
      setView({
        status: 'ready',
        items: page.items,
        total: page.total ?? 0,
        nextCursor: page.next_cursor,
        filters,
      });
    } catch (error: unknown) {
      if (requestId.current !== id) return;
      setView(classify(error, filters));
    }
  }

  useEffect(() => {
    void load(defaultFilters());
    // Первая загрузка - по периоду по умолчанию; дальше только по «Применить» и «Повторить».
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void load(form);
  }

  async function handleMore(): Promise<void> {
    if (view.status !== 'ready' || view.nextCursor === null || moreBusy) return;
    const id = requestId.current;
    const { filters, nextCursor } = view;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await listJournal({
        kind: filters.kind,
        date_from: filters.from,
        date_to: filters.to,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (requestId.current !== id) return;
      setView((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: [...current.items, ...page.items],
              // `total` с курсорной страницы - `null`: число остаётся с первой.
              total: page.total ?? current.total,
              nextCursor: page.next_cursor,
            }
          : current,
      );
    } catch (error: unknown) {
      if (requestId.current !== id) return;
      setMoreError(error instanceof ApiError ? error.message : MORE_ERROR);
    } finally {
      setMoreBusy(false);
    }
  }

  const loading = view.status === 'loading';
  const rangeError = view.status === 'error' && view.kind === 'range';
  const invalidDates = rangeError ? true : undefined;
  const shownFilters = view.status === 'ready' || view.status === 'error' ? view.filters : form;
  const caption = `События всех компаний платформы за ${ruDate(shownFilters.from)} — ${ruDate(shownFilters.to)}, время московское`;

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--journal" data-testid="operator-journal">
          <div className="page__head">
            <h1 className="page__title">Журнал</h1>
            <p className="page__meta">Все компании платформы · время московское</p>
          </div>

          <form
            className="filters"
            aria-label="Период и вид записей"
            onSubmit={handleSubmit}
            noValidate
          >
            <div className="field filter--date">
              <label className="field__label" htmlFor="journal-from">
                От
              </label>
              <input
                className="field__input"
                id="journal-from"
                type="date"
                value={form.from}
                disabled={loading}
                aria-invalid={invalidDates}
                onChange={(event) => setForm({ ...form, from: event.target.value })}
                data-testid="operator-journal-from"
              />
            </div>
            <div className="field filter--date">
              <label className="field__label" htmlFor="journal-to">
                До
              </label>
              <input
                className="field__input"
                id="journal-to"
                type="date"
                value={form.to}
                disabled={loading}
                aria-invalid={invalidDates}
                onChange={(event) => setForm({ ...form, to: event.target.value })}
                data-testid="operator-journal-to"
              />
            </div>
            <div className="field filter--kind">
              <label className="field__label" htmlFor="journal-kind">
                Вид действий
              </label>
              <select
                className="field__input filter__select"
                id="journal-kind"
                value={form.kind}
                disabled={loading}
                onChange={(event) =>
                  setForm({ ...form, kind: event.target.value as JournalKind | '' })
                }
                data-testid="operator-journal-kind"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn btn--primary"
              type="submit"
              disabled={loading}
              data-testid="operator-journal-apply"
            >
              Применить
            </button>
          </form>

          {loading && (
            <>
              <p
                className="state"
                role="status"
                aria-live="polite"
                data-testid="operator-journal-loading"
              >
                <span className="spinner" aria-hidden="true" />
                Загружаем журнал…
              </p>
              <div className="list">
                <table className="list__table journal__table">
                  <caption className="visually-hidden">{caption}</caption>
                  <JournalHead />
                  <tbody>
                    <SkeletonRows />
                  </tbody>
                </table>
              </div>
            </>
          )}

          {view.status === 'error' && view.kind === 'range' && (
            <p className="alert alert--error" role="alert" data-testid="operator-journal-error">
              {view.text}
            </p>
          )}

          {view.status === 'error' && view.kind === 'gateway' && (
            <div className="alert-line">
              <p className="alert alert--error" role="alert" data-testid="operator-journal-error">
                {view.text}
              </p>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => void load(view.filters)}
                data-testid="operator-journal-retry"
              >
                Повторить
              </button>
            </div>
          )}

          {view.status === 'ready' && view.items.length === 0 && (
            <div className="empty" data-testid="operator-journal-empty">
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
              <h2>За этот период записей нет</h2>
              <p>
                С {ruDate(view.filters.from)} по {ruDate(view.filters.to)}{' '}
                {KIND_PHRASE[view.filters.kind] ?? 'событий'} по всем компаниям не записано.
                Выберите другой вид действий или расширьте период.
              </p>
            </div>
          )}

          {view.status === 'ready' && view.items.length > 0 && (
            <div className="list">
              <table className="list__table journal__table">
                <caption className="visually-hidden">{caption}</caption>
                <JournalHead />
                <tbody>
                  {view.items.map((entry) => (
                    <JournalRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>

              <div className="list__foot">
                <p className="list__shown" data-testid="operator-journal-count">
                  За этот период — {view.total}{' '}
                  {plural(view.total, ['запись', 'записи', 'записей'])}
                </p>
                {view.nextCursor !== null && (
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={() => void handleMore()}
                    disabled={moreBusy}
                    aria-busy={moreBusy ? true : undefined}
                    data-testid="operator-journal-more"
                  >
                    {moreBusy ? 'Загружаем…' : 'Показать ещё'}
                  </button>
                )}
              </div>
              {moreError !== null && (
                <p
                  className="alert alert--error"
                  role="alert"
                  data-testid="operator-journal-more-error"
                >
                  {moreError}
                </p>
              )}
            </div>
          )}
        </div>
      </main>
    </Screen>
  );
}

/** Шапка таблицы: шесть колонок в порядке макета. */
function JournalHead(): JSX.Element {
  return (
    <thead>
      <tr>
        <th scope="col">Когда</th>
        <th scope="col">Компания</th>
        <th scope="col">Сотрудник</th>
        <th scope="col">Действие</th>
        <th scope="col">Вид</th>
        <th scope="col">Статус</th>
      </tr>
    </thead>
  );
}
