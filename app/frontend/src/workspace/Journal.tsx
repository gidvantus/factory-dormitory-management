import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { JournalEntry, JournalKind, JournalParams } from '../api/client';
import pageStyles from './Workspace.module.css';
import styles from './Journal.module.css';

const LOAD_ERROR = 'Не удалось загрузить журнал. Проверьте соединение и попробуйте ещё раз.';
const SESSION_ERROR = 'Сессия завершилась. Войдите в аккаунт снова.';
const LOAD_MORE_ERROR = 'Не удалось догрузить записи. Попробуйте ещё раз.';
const FORBIDDEN_TITLE = 'Журнал доступен только владельцу организации';
const FORBIDDEN_HINT =
  'Раздел видят только владельцы организации. Если журнал нужен вам, попросите владельца изменить вашу роль в разделе «Сотрудники».';
const EMPTY_TITLE = 'За выбранный период записей нет';

/** Подписи видов действия: `security`, `data`, `noise` — значения контракта. */
const KIND_LABELS: Record<JournalKind, string> = {
  security: 'Безопасность',
  data: 'Данные',
  noise: 'Служебное',
};

/**
 * Классы тегов вида. «Данные» остаются на существующем `.tag--neutral`,
 * «Безопасность» и «Служебное» — новые модификаторы глобального слоя.
 */
const KIND_CLASSES: Record<JournalKind, string> = {
  security: 'tag tag--security',
  data: 'tag tag--neutral',
  noise: 'tag tag--noise',
};

/**
 * Календарь фильтра — московский, как и на сервере: «правка в 01:30 29.10»
 * обязана попасть в 29.10, а не в 28.10 по UTC. Все форматтеры задают зону
 * явно — иначе тест на другой машине показал бы другую дату.
 */
const JOURNAL_ZONE = 'Europe/Moscow';

/** Длина периода по умолчанию: столько отдаёт сервер, если дат не передали. */
const DEFAULT_PERIOD_DAYS = 7;

/** `en-CA` печатает дату как `YYYY-MM-DD` — формат `input type="date"` и параметра. */
const ISO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: JOURNAL_ZONE });
const DAY_LABEL = new Intl.DateTimeFormat('ru-RU', {
  timeZone: JOURNAL_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const TIME_LABEL = new Intl.DateTimeFormat('ru-RU', {
  timeZone: JOURNAL_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

type ViewStatus = 'loading' | 'ready' | 'error' | 'forbidden';

/** Сегодняшний день в московском календаре — граница периода по умолчанию. */
function todayMoscow(): string {
  return ISO_DAY.format(new Date());
}

/** Сдвиг дня `YYYY-MM-DD` на `days` суток без перехода на местное время. */
function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** `2026-10-28` → `28.10.2026`: значение поля периода в человеческом виде. */
function dayLabel(day: string): string {
  const [year, month, date] = day.split('-');
  return `${date}.${month}.${year}`;
}

/** Момент записи из ответа (`…Z`) в московские дату и время. */
function momentLabel(createdAt: string, format: Intl.DateTimeFormat): string {
  const moment = new Date(createdAt);
  return Number.isNaN(moment.getTime()) ? '—' : format.format(moment);
}

/** `“За этот период — 3 записи”`: число склоняется, иначе подпись читается криво. */
function countLabel(total: number): string {
  const mod10 = total % 10;
  const mod100 = total % 100;
  if (mod10 === 1 && mod100 !== 11) return `За этот период — ${total} запись`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return `За этот период — ${total} записи`;
  return `За этот период — ${total} записей`;
}

/** Тон точки статуса: 2xx — успех, 4xx/5xx — ошибка, пусто — нейтрально. */
function statusTone(status: number | null): 'ok' | 'error' | 'none' {
  if (status === null) return 'none';
  return status >= 200 && status < 400 ? 'ok' : 'error';
}

/**
 * Сырая запись для раскрытия. Порядок ключей — то, что читают сначала: сама
 * запись и её изменения; служебные `ip`, `user_agent` и `request_id` уходят вниз
 * под прокрутку. Курсор и прочие детали сервера сюда не попадают: показываем
 * ровно то, что пришло в записи.
 */
function journalJson(entry: JournalEntry): string {
  return JSON.stringify(
    {
      id: entry.id,
      created_at: entry.created_at,
      changes: entry.changes,
      action: entry.action,
      action_title: entry.action_title,
      kind: entry.kind,
      status: entry.status,
      duration_ms: entry.duration_ms,
      path: entry.path,
      path_params: entry.path_params,
      request_body: entry.request_body,
      actor_id: entry.actor_id,
      method: entry.method,
      ip: entry.ip,
      user_agent: entry.user_agent,
      request_id: entry.request_id,
    },
    null,
    2,
  );
}

/** Применённые фильтры. Пустая строка даты — серверное умолчание периода. */
interface AppliedFilters {
  from: string;
  to: string;
  kind: JournalKind | '';
}

function queryParams(filters: AppliedFilters, cursor?: string): JournalParams {
  return {
    kind: filters.kind,
    date_from: filters.from || undefined,
    date_to: filters.to || undefined,
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * Раздел «Журнал действий» кабинета владельца организации.
 *
 * Читает `GET /api/journal` и только читает: сам просмотр не оставляет строку в
 * журнале. Роль проверять на клиенте раньше ответа не нужно — сервер отвечает
 * `403` всем, кроме владельца, а экран показывает это состояние вместо ленты.
 * Поэтому прямой заход `/cabinet/journal` у `member` тоже даёт понятное
 * объяснение, а не пустую таблицу.
 *
 * Состояний четыре: загрузка (скелет в той же таблице), ошибка загрузки,
 * пусто и «только владельцу». Фильтры остаются на месте во всех состояниях,
 * кроме отказа: там их не к чему применять.
 */
export function Journal(): JSX.Element {
  const [period] = useState(() => {
    const to = todayMoscow();
    return { from: shiftDay(to, -(DEFAULT_PERIOD_DAYS - 1)), to };
  });
  const [fromInput, setFromInput] = useState(period.from);
  const [toInput, setToInput] = useState(period.to);
  const [kindInput, setKindInput] = useState<JournalKind | ''>('');
  const [filters, setFilters] = useState<AppliedFilters>({
    from: period.from,
    to: period.to,
    kind: '',
  });
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(LOAD_ERROR);
  const [moreError, setMoreError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Запрос «Показать ещё» в полёте: смена фильтра обязана его отменить. */
  const moreRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setEntries([]);
    setTotal(null);
    setNextCursor(null);
    setMoreError('');
    // Догрузка предыдущего набора на новой ленте уже не актуальна.
    setLoadingMore(false);
    void api
      .journal(queryParams(filters), controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        const items = Array.isArray(page?.items) ? page.items : [];
        setEntries(items);
        setNextCursor(page?.next_cursor ?? null);
        // `total` приходит только с первой страницей; до ответа показывать
        // нечего, поэтому считаем по факту.
        setTotal(page?.total ?? items.length);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // 422 — ошибка ввода в фильтре (период длиннее 90 дней и т.п.):
        // показываем серверный текст, «Повторить» здесь не поможет.
        if (error instanceof ApiError && error.status === 422) {
          setLoadError(error.message);
          setStatus('error');
          return;
        }
        // 403 — роль не владелец, 404 — пользователь без организации. Оба
        // отказа приводят к одному состоянию: журнала для него нет.
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setStatus('forbidden');
          return;
        }
        setLoadError(
          error instanceof ApiError && error.status === 401 ? SESSION_ERROR : LOAD_ERROR,
        );
        setStatus('error');
      });
    return () => {
      controller.abort();
      // Поздний ответ «Показать ещё» не должен дописать строки старого набора
      // в новую ленту и подменить её курсор.
      moreRef.current?.abort();
      moreRef.current = null;
    };
  }, [filters, attempt]);

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFilters({ from: fromInput, to: toInput, kind: kindInput });
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    const controller = new AbortController();
    moreRef.current?.abort();
    moreRef.current = controller;
    setLoadingMore(true);
    setMoreError('');
    try {
      const page = await api.journal(queryParams(filters, nextCursor), controller.signal);
      if (controller.signal.aborted) return;
      setEntries((current) => [...current, ...(Array.isArray(page?.items) ? page.items : [])]);
      setNextCursor(page?.next_cursor ?? null);
    } catch {
      // Отмену показывать нечем: фильтр сменился, лента перезагружается сама.
      if (controller.signal.aborted) return;
      // Уже загруженные записи остаются: сбой догрузки не должен стирать ленту.
      setMoreError(LOAD_MORE_ERROR);
    } finally {
      // Состояние догрузки снимает только актуальный запрос: отменённый оставляет
      // его новому набору, а эффект уже сбросил `loadingMore` на старте.
      if (moreRef.current === controller) {
        moreRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  const loading = status === 'loading';
  const showFilters = status !== 'forbidden';

  return (
    <section aria-labelledby="journal-title" data-testid="journal-page">
      <div className="page-head">
        <div>
          <p className={pageStyles.eyebrow}>Рабочее пространство</p>
          <h1 id="journal-title" tabIndex={-1}>
            Журнал действий
          </h1>
          <p className={pageStyles.subtitle}>
            Что делали вы и сотрудники организации за выбранный период
          </p>
        </div>
      </div>

      {showFilters && (
        <form
          className={`toolbar ${styles.filters}`}
          aria-label="Период и вид записей"
          onSubmit={applyFilters}
          noValidate
        >
          <div className={styles.filterFields}>
            <label className={styles.filterField} htmlFor="journal-from">
              От
              <input
                id="journal-from"
                data-testid="journal-from"
                type="date"
                value={fromInput}
                max={toInput || undefined}
                onChange={(event) => setFromInput(event.target.value)}
              />
            </label>
            <label className={styles.filterField} htmlFor="journal-to">
              До
              <input
                id="journal-to"
                data-testid="journal-to"
                type="date"
                value={toInput}
                min={fromInput || undefined}
                onChange={(event) => setToInput(event.target.value)}
              />
            </label>
            <label
              className={`${styles.filterField} ${styles.filterFieldKind}`}
              htmlFor="journal-kind"
            >
              Вид
              <select
                id="journal-kind"
                data-testid="journal-kind"
                value={kindInput}
                onChange={(event) => setKindInput(event.target.value as JournalKind | '')}
              >
                <option value="">Все действия</option>
                <option value="security">Безопасность</option>
                <option value="data">Данные</option>
                <option value="noise">Служебное</option>
              </select>
            </label>
          </div>
          {/* На время загрузки фильтры заблокированы: применять нечего, а второй
              запрос поверх первого дал бы гонку ответов. */}
          <button className="btn btn--primary btn--compact" type="submit" disabled={loading}>
            Применить
          </button>
        </form>
      )}

      {status === 'forbidden' && (
        <div className={styles.emptyState} data-testid="journal-forbidden">
          <span className={styles.emptyIcon} data-tone="locked" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="10" width="16" height="11" rx="3" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
            </svg>
          </span>
          <h2>{FORBIDDEN_TITLE}</h2>
          <p>{FORBIDDEN_HINT}</p>
          <Link className="btn btn--ghost btn--compact" to="/cabinet">
            Вернуться в обзор
          </Link>
        </div>
      )}

      {loading && (
        <>
          <p className={pageStyles['view-note']} role="status" data-testid="journal-loading">
            Загружаем журнал…
          </p>
          <section className="panel" aria-label="Записи журнала загружаются">
            <div className={pageStyles['table-scroll']}>
              <table className={`data-table ${styles.table}`}>
                <thead>
                  <tr>
                    <th scope="col">Когда</th>
                    <th scope="col">Действие</th>
                    <th scope="col">Вид</th>
                    <th scope="col">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {[0, 1, 2].map((row) => (
                    <tr className={`${styles.row} ${styles.skeletonRow}`} key={row}>
                      <td>
                        <span className={`${styles.skeleton} ${styles.skeletonWhen}`} />
                      </td>
                      <td>
                        <span className={`${styles.skeleton} ${styles.skeletonAction}`} />
                      </td>
                      <td>
                        <span className={`${styles.skeleton} ${styles.skeletonKind}`} />
                      </td>
                      <td>
                        <span className={`${styles.skeleton} ${styles.skeletonStatus}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {status === 'error' && (
        <div className={pageStyles['organization-error']} role="alert" data-testid="journal-error">
          <p>{loadError}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && entries.length === 0 && (
        <div className={styles.emptyState} data-testid="journal-empty">
          <span className={styles.emptyIcon} aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 4h14a1 1 0 0 1 1 1v15l-3-2-3 2-3-2-3 2V5a1 1 0 0 1 1-1Z" />
              <path d="M9 9h6M9 13h4" />
            </svg>
          </span>
          <h2>{EMPTY_TITLE}</h2>
          <p>
            {filters.from && filters.to
              ? `За ${dayLabel(filters.from)} — ${dayLabel(filters.to)} действий в организации не записано. Выберите другой период или вид действия в фильтрах выше.`
              : 'Действий в организации не записано. Выберите другой период или вид действия в фильтрах выше.'}
          </p>
        </div>
      )}

      {status === 'ready' && entries.length > 0 && (
        <section className="panel" aria-labelledby="journal-list-title" data-testid="journal-table">
          <h2 className="visually-hidden" id="journal-list-title">
            Записи журнала
          </h2>
          <div className={pageStyles['table-scroll']}>
            <table className={`data-table ${styles.table}`}>
              <caption className="visually-hidden">Записи журнала действий организации</caption>
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Действие</th>
                  <th scope="col">Вид</th>
                  <th scope="col">Статус</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <Fragment key={entry.id}>
                    <tr className={styles.row} data-testid="journal-row">
                      <td className={styles.when}>
                        <span className={styles.date}>
                          {momentLabel(entry.created_at, DAY_LABEL)}
                        </span>
                        <span className={styles.time}>
                          {momentLabel(entry.created_at, TIME_LABEL)}
                        </span>
                      </td>
                      {/* Незнакомый код действия показываем кодом: придуманного
                          названия у него нет, а журнал обязан говорить правду. */}
                      <td
                        className={styles.action}
                        data-unknown={entry.action_title === entry.action ? 'true' : undefined}
                      >
                        {entry.action_title}
                      </td>
                      <td className={styles.kind}>
                        <span className={KIND_CLASSES[entry.kind] ?? 'tag tag--neutral'}>
                          {KIND_LABELS[entry.kind] ?? entry.kind}
                        </span>
                      </td>
                      <td className={styles.status}>
                        <span className={styles.statusValue} data-state={statusTone(entry.status)}>
                          <span className={styles.statusDot} />
                          {entry.status ?? '—'}
                          {entry.duration_ms !== null ? (
                            <span className={styles.statusMs}>{entry.duration_ms} мс</span>
                          ) : (
                            entry.status !== null && <span className={styles.statusMs}>—</span>
                          )}
                        </span>
                      </td>
                    </tr>
                    <tr className={styles.details}>
                      <td colSpan={4} data-testid="journal-detail">
                        {/* Нативный `<details>`: раскрытие работает с клавиатуры и
                            без скриптов, а лента остаётся на виду — модалки нет. */}
                        <details className={styles.summaryBlock}>
                          <summary className={styles.summary}>
                            <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
                              <path d="m9 5 7 7-7 7" />
                            </svg>
                            <span className={styles.summaryClosed}>Запись журнала</span>
                            <span className={styles.summaryOpen}>Скрыть запись</span>
                            <span className={styles.entryId}>№ {entry.id}</span>
                          </summary>
                          <div className={styles.jsonWrap}>
                            <pre className={styles.json} data-testid="journal-json">
                              {journalJson(entry)}
                            </pre>
                          </div>
                        </details>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.foot}>
            {nextCursor ? (
              <button
                className="btn btn--ghost btn--compact"
                type="button"
                data-testid="journal-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                aria-busy={loadingMore || undefined}
              >
                {loadingMore ? 'Загружаем…' : 'Показать ещё'}
              </button>
            ) : (
              <span />
            )}
            <p className={styles.count} data-testid="journal-count">
              {total !== null ? countLabel(total) : ''}
            </p>
          </div>
          {moreError && (
            <p className={styles.moreError} role="alert" data-testid="journal-more-error">
              {moreError}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
