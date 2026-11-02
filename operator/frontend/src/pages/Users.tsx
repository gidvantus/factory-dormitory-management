import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChangeEvent } from 'react';

import { ApiError, listUsers } from '../api/client';
import type { PlatformUser } from '../api/client';
import { ActivationFlag } from '../components/ActivationFlag';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NONE, plural, roleLabel } from '../lib/format';

/**
 * Размер страницы. Столько же, сколько кабинет-API отдаёт по умолчанию
 * (`DEFAULT_LIMIT = 50` в `operator/backend/app/api/users.py`):
 * «Показать ещё» догружает следующую такую же страницу.
 */
const PAGE_SIZE = 50;

/**
 * Задержка поиска: запрос уходит, когда оператор перестал печатать.
 *
 * Без неё на каждую букву уходил бы запрос в основной API, а список мигал бы
 * состояниями загрузки; 300 мс — последняя пауза между нажатиями.
 */
const SEARCH_DELAY_MS = 300;

/** Текст для сети и неожиданного отказа: `detail` сервера важнее общего текста. */
const LOAD_ERROR = 'Не удалось загрузить пользователей';

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: PlatformUser[]; total: number; query: string }
  | { status: 'error'; text: string };

/**
 * Текст отказа для экрана.
 *
 * Контракт кабинета: `detail` показывается дословно. Сюда приходят и тексты
 * основного API через прокси («Основной API недоступен», «Основной API не принял
 * сервисный токен»), поэтому переписывать их нельзя — исключение только для
 * сети, где текста сервера нет вовсе.
 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return LOAD_ERROR;
}

/** Заголовок со счётчиком: `61 пользователь`, `2 пользователя`, `12 пользователей`. */
function totalLabel(total: number): string {
  return `${total} ${plural(total, ['пользователь', 'пользователя', 'пользователей'])}`;
}

/**
 * Список учётных записей платформы.
 *
 * Данные приходят из кабинета-API (`GET /api/users`), тот читает их в основном
 * API по сервисному токену. Поиск — необязательный `search`: подстрока по ФИО
 * или email без учёта регистра, правило живёт в основном API.
 *
 * Состояния: загрузка, ошибка (текст `detail` дословно), пустая база
 * («Пользователей пока нет»), пустой результат поиска («Ничего не найдено»),
 * заполненный список с «Показать ещё». Кнопка видна, пока показано меньше `total`.
 */
export function Users(): JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  // Номер запроса: ответ на устаревший поиск не должен затирать свежий.
  const requestId = useRef(0);

  useEffect(() => {
    const query = search.trim();
    const id = ++requestId.current;
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      listUsers({ limit: PAGE_SIZE, offset: 0, search: query }).then(
        (page) => {
          if (requestId.current !== id) return;
          setState({ status: 'ready', items: page.items, total: page.total, query });
        },
        (error: unknown) => {
          if (requestId.current !== id) return;
          setState({ status: 'error', text: errorMessage(error) });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  async function handleMore(): Promise<void> {
    if (state.status !== 'ready' || loadingMore) return;
    const id = requestId.current;
    const offset = state.items.length;
    setLoadingMore(true);
    try {
      const page = await listUsers({ limit: PAGE_SIZE, offset, search: state.query });
      if (requestId.current !== id) return;
      setState((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              items: [...current.items, ...page.items],
              total: page.total,
              query: current.query,
            }
          : current,
      );
    } catch (error: unknown) {
      if (requestId.current !== id) return;
      setState({ status: 'error', text: errorMessage(error) });
    } finally {
      setLoadingMore(false);
    }
  }

  function handleOpen(id: number): void {
    navigate(`/users/${id}`);
  }

  const query = search.trim();

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--list">
          <div className="page__head">
            <h1 className="page__title">Пользователи</h1>
            {state.status === 'ready' && state.total > 0 && (
              <p className="page__meta">{totalLabel(state.total)}</p>
            )}
          </div>

          <div className="toolbar">
            <div className="search">
              <label className="visually-hidden" htmlFor="users-search">
                Поиск по ФИО или email
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
                id="users-search"
                type="search"
                value={search}
                placeholder="ФИО или email"
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
                data-testid="operator-users-search"
              />
            </div>
          </div>

          {state.status === 'loading' && (
            <div className="state" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              Загружаем пользователей…
            </div>
          )}

          {state.status === 'error' && (
            <p className="alert alert--error" role="alert" data-testid="operator-users-error">
              {state.text}
            </p>
          )}

          {state.status === 'ready' && state.items.length === 0 && query === '' && (
            <div className="empty" data-testid="operator-users-empty">
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
                  <circle cx="9" cy="8" r="3.4" />
                  <path d="M3.5 20c0-3.2 2.5-5.4 5.5-5.4s5.5 2.2 5.5 5.4M16.5 5.5h4M18.5 3.5v4" />
                </svg>
              </span>
              <h2>Пользователей пока нет</h2>
              <p>
                Здесь появятся учётные записи людей, зарегистрированных на платформе, — вместе с
                организацией и ролью.
              </p>
            </div>
          )}

          {state.status === 'ready' && state.items.length === 0 && query !== '' && (
            <div className="empty empty--compact" data-testid="operator-users-empty">
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
              <p>По запросу «{query}» никого нет. Поиск идёт по ФИО и email, регистр не важен.</p>
            </div>
          )}

          {state.status === 'ready' && state.items.length > 0 && (
            <div className="list" data-testid="operator-users">
              <table className="list__table">
                <caption className="visually-hidden">
                  Учётные записи платформы: номер, ФИО, email, организация, роль, состояние
                  активации
                </caption>
                <thead>
                  <tr>
                    <th scope="col">ФИО</th>
                    <th scope="col">Email</th>
                    <th scope="col">Организация</th>
                    <th scope="col">Роль</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">
                      <span className="visually-hidden">Действие</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => (
                    <tr key={item.id} data-testid="operator-user-row">
                      <td className="list__name-cell">
                        <span className="user__id">№ {item.id}</span>
                        <span className="user__name">{item.full_name}</span>
                      </td>
                      <td className="user__email">{item.email}</td>
                      <td
                        className={item.organization_name === null ? 'user__org none' : 'user__org'}
                      >
                        <span className="cell__label">Организация:</span>
                        {item.organization_name ?? NONE}
                      </td>
                      <td className={item.role === null ? 'user__role none' : 'user__role'}>
                        <span className="cell__label">Роль:</span>
                        {roleLabel(item.role)}
                      </td>
                      <td className="list__state">
                        <ActivationFlag active={item.is_active} />
                      </td>
                      <td className="list__action">
                        <button
                          className="btn btn--ghost btn--compact"
                          type="button"
                          onClick={() => handleOpen(item.id)}
                          data-testid="operator-user-open"
                        >
                          Открыть
                        </button>
                      </td>
                    </tr>
                  ))}
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
                    data-testid="operator-users-more"
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
