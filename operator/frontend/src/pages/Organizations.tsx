import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MouseEvent } from 'react';

import { ApiError, listOrganizations } from '../api/client';
import type { OrganizationListItem } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import { NO_NAME, formatDay, plural } from '../lib/format';

/**
 * Размер страницы. Столько же, сколько кабинет-API отдаёт по умолчанию
 * (`DEFAULT_LIMIT = 50` в `operator/backend/app/api/organizations.py`):
 * «Показать ещё» догружает следующую такую же страницу.
 */
const PAGE_SIZE = 50;

/** Текст для сети и неожиданного отказа: `detail` сервера важнее общего текста. */
const LOAD_ERROR = 'Не удалось загрузить организации';

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: OrganizationListItem[]; total: number }
  | { status: 'error'; text: string };

/**
 * Текст отказа для экрана.
 *
 * Контракт кабинета: `detail` показывается дословно. Сюда приходят и тексты
 * основного API через прокси («Основной API недоступен», «Кабинет не настроен:
 * не задан OPERATOR_SERVICE_TOKEN»), поэтому переписывать их нельзя — исключение
 * только для сети, где текста сервера нет вовсе.
 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return LOAD_ERROR;
}

/** Заголовок со счётчиком: `61 организация`, `2 организации`, `12 организаций`. */
function totalLabel(total: number): string {
  return `${total} ${plural(total, ['организация', 'организации', 'организаций'])}`;
}

/**
 * Список организаций платформы.
 *
 * Данные приходят из кабинета-API (`GET /api/organizations`), тот читает их в
 * основном API по сервисному токену. Постраничная выдача — единственный способ
 * выбрать не всё сразу: поиска и фильтров постановка не предусматривает.
 *
 * Состояния: загрузка, ошибка (текст `detail` дословно), пусто, заполненный
 * список с «Показать ещё». Кнопка видна, пока показано меньше `total`.
 */
export function Organizations(): JSX.Element {
  const navigate = useNavigate();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    listOrganizations(PAGE_SIZE, 0).then(
      (page) => {
        if (active) setState({ status: 'ready', items: page.items, total: page.total });
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', text: errorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function handleMore(): Promise<void> {
    if (state.status !== 'ready' || loadingMore) return;
    const offset = state.items.length;
    setLoadingMore(true);
    try {
      const page = await listOrganizations(PAGE_SIZE, offset);
      setState((current) =>
        current.status === 'ready'
          ? { status: 'ready', items: [...current.items, ...page.items], total: page.total }
          : current,
      );
    } catch (error: unknown) {
      setState({ status: 'error', text: errorMessage(error) });
    } finally {
      setLoadingMore(false);
    }
  }

  function handleOpen(event: MouseEvent<HTMLButtonElement>, id: number): void {
    event.preventDefault();
    navigate(`/organizations/${id}`);
  }

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page">
          <div className="page__head">
            <h1 className="page__title">Организации</h1>
            {state.status === 'ready' && <p className="page__meta">{totalLabel(state.total)}</p>}
          </div>

          {state.status === 'loading' && (
            <p className="state" role="status">
              <span className="spinner" aria-hidden="true" />
              Загружаем организации…
            </p>
          )}

          {state.status === 'error' && (
            <p
              className="alert alert--error"
              role="alert"
              data-testid="operator-organizations-error"
            >
              {state.text}
            </p>
          )}

          {state.status === 'ready' && state.items.length === 0 && (
            <div className="empty" data-testid="operator-organizations-empty">
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
                  <path d="M4 20V7l8-3 8 3v13M4 20h16M9 20v-5h6v5M9 11h.01M15 11h.01" />
                </svg>
              </span>
              <h2>Организаций пока нет</h2>
              <p>Здесь появятся организации, зарегистрированные на платформе.</p>
            </div>
          )}

          {state.status === 'ready' && state.items.length > 0 && (
            <div className="list" data-testid="operator-organizations">
              <table className="list__table">
                <caption className="visually-hidden">
                  Организации платформы: номер, название, ИНН, дата создания
                </caption>
                <thead>
                  <tr>
                    <th scope="col">№</th>
                    <th scope="col">Название</th>
                    <th scope="col">ИНН</th>
                    <th scope="col">Создана</th>
                    <th scope="col">
                      <span className="visually-hidden">Действие</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => (
                    <tr key={item.id} data-testid="operator-organization-row">
                      <td className="list__id">
                        <span className="cell__label">№</span>
                        {item.id}
                      </td>
                      <td
                        className={
                          item.name === null ? 'list__name list__name--empty' : 'list__name'
                        }
                      >
                        {item.name ?? NO_NAME}
                      </td>
                      <td className="list__inn">
                        <span className="cell__label">ИНН</span>
                        {item.inn ?? '—'}
                      </td>
                      <td className="list__date">
                        <span className="cell__label">создана</span>
                        {formatDay(item.created_at)}
                      </td>
                      <td className="list__action">
                        <button
                          className="btn btn--ghost btn--compact"
                          type="button"
                          onClick={(event) => handleOpen(event, item.id)}
                          data-testid="operator-organization-open"
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
                    data-testid="operator-organizations-more"
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
