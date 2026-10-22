import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JournalEntry } from '../api/client';
import { mockFetch, type MockHandler, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const OWNER = {
  email: 'owner@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
  role: 'owner',
};

const MEMBER = { ...OWNER, email: 'member@example.com', role: 'member' };

const TRIAL_ACTIVE: MockResponse = {
  status: 200,
  body: {
    ends_at: '2026-11-01T00:00:00Z',
    days_left: 12,
    is_active: true,
    locked: false,
    member_limit: 3,
  },
};

const NOT_FOUND: MockResponse = { status: 404, body: { detail: 'Не найдено' } };

/** Запись журнала: 11:32 UTC — это 14:32 по Москве (проверяется в тесте). */
const ENTRY: JournalEntry = {
  id: 1048573,
  created_at: '2026-10-28T11:32:11Z',
  actor_id: 4,
  method: 'PATCH',
  path: '/api/dormitories/4',
  action: 'patch_dormitories',
  action_title: 'Изменить названия или статус архива общежития',
  kind: 'data',
  status: 200,
  duration_ms: 84,
  ip: '10.8.0.14',
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0',
  request_id: '8f21c0d4b7e94a1c',
  path_params: { dormitory_id: '4' },
  request_body: { name: 'Общежитие №2 на Строителей' },
  changes: [
    {
      entity: 'dormitories',
      field: 'name',
      old: 'Общежитие №2',
      new: 'Общежитие №2 на Строителей',
    },
  ],
};

/** Незнакомый код действия: названия у него нет, показывается сам код. */
const UNKNOWN: JournalEntry = {
  ...ENTRY,
  id: 1048572,
  action: 'put_dormitories_hostels_cells',
  action_title: 'put_dormitories_hostels_cells',
  kind: 'noise',
  status: null,
  duration_ms: null,
  changes: null,
};

/** Запись другого набора: приходит на новый фильтр и не должна смешаться со старым. */
const FILTERED: JournalEntry = {
  ...ENTRY,
  id: 1048570,
  action: 'delete_members',
  action_title: 'Удалить сотрудника',
};

/** Запись другой страницы нового набора: догрузка идёт уже по её курсору. */
const SECOND_PAGE: JournalEntry = {
  ...ENTRY,
  id: 1048569,
  action: 'create_members',
  action_title: 'Добавить сотрудника',
};

function page(
  items: JournalEntry[],
  nextCursor: string | null,
  total: number | null,
): MockResponse {
  return { status: 200, body: { items, next_cursor: nextCursor, total } };
}

/**
 * Заглушка API: профиль сессии, пробный период, каталог решений и журнал.
 * `journal` получает адрес запроса — по нему тесты проверяют курсор и фильтры.
 */
function mountJournal(handler: MockHandler): ReturnType<typeof vi.fn> {
  return mockFetch((url, init) => {
    if (url.endsWith('/api/me')) return { status: 200, body: OWNER };
    if (url.endsWith('/api/trial')) return TRIAL_ACTIVE;
    if (url.endsWith('/api/solutions')) return { status: 200, body: { items: [] } };
    return handler(url, init);
  });
}

function rows(): HTMLElement[] {
  return screen.getAllByTestId('journal-row');
}

/** Адреса запросов к журналу вместе с querystring: `callsTo` ищет по хвосту. */
function journalCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/journal'));
}

function jsonResponse({ status, body }: MockResponse): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Даёт отработать уже разрешённому позднему ответу: разбор тела и коммит
 * состояния идут микрозадачами, поэтому «ничего не случилось» проверяем
 * после тика макрозадач.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('раздел «Журнал» в кабинете', () => {
  it('владелец видит пункт меню, ленту действий и число записей за период', async () => {
    mountJournal((url) => {
      if (url.includes('/api/journal')) return page([ENTRY, UNKNOWN], 'cursor-1', 132);
      return NOT_FOUND;
    });
    renderApp('/cabinet/journal');

    await waitFor(() => expect(rows()).toHaveLength(2));

    expect(screen.getByTestId('workspace-nav-journal')).toHaveAttribute('href', '/cabinet/journal');
    expect(screen.getByTestId('workspace-nav-journal')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Журнал действий' })).toBeInTheDocument();

    const [dated, unknown] = rows();
    // Время показывается московское: 11:32 UTC — это 14:32.
    expect(dated).toHaveTextContent('28.10.2026');
    expect(dated).toHaveTextContent('14:32');
    expect(within(dated).getByText('Изменить названия или статус архива общежития')).toBeVisible();
    expect(within(dated).getByText('Данные')).toBeInTheDocument();
    expect(dated).toHaveTextContent('200');
    expect(dated).toHaveTextContent('84 мс');

    // Неизвестный код — сам код, моноширинно, без придуманного названия.
    expect(unknown).toHaveTextContent('put_dormitories_hostels_cells');
    expect(within(unknown).getByText('Служебное')).toBeInTheDocument();
    expect(within(unknown).getByText('put_dormitories_hostels_cells')).toHaveAttribute(
      'data-unknown',
      'true',
    );
    // Пустые `status` и `duration_ms` — один прочерк, без второго.
    expect(unknown).toHaveTextContent('—');

    expect(screen.getByTestId('journal-count')).toHaveTextContent('За этот период — 132 записи');
  });

  it('раскрытие строки показывает сырую запись с изменениями', async () => {
    mountJournal((url) => {
      if (url.includes('/api/journal')) return page([ENTRY], null, 1);
      return NOT_FOUND;
    });
    const user = userEvent.setup();
    renderApp('/cabinet/journal');

    await waitFor(() => expect(rows()).toHaveLength(1));

    const detail = screen.getByTestId('journal-detail');
    const summary = within(detail).getByText('Запись журнала');
    await user.click(summary);

    const json = within(detail).getByTestId('journal-json');
    expect(json).toHaveTextContent('"id": 1048573');
    expect(json).toHaveTextContent('"field": "name"');
    expect(json).toHaveTextContent(
      '"action_title": "Изменить названия или статус архива общежития"',
    );
    // Раскрытие — нативный `<details>`: он открылся, а не просто показал текст.
    expect(json.closest('details')).toHaveAttribute('open');
  });

  it('пустой ответ показывает приглашение выбрать другой период', async () => {
    mountJournal((url) => {
      if (url.includes('/api/journal')) return page([], null, 0);
      return NOT_FOUND;
    });
    renderApp('/cabinet/journal');

    const empty = await screen.findByTestId('journal-empty');
    expect(empty).toHaveTextContent('За выбранный период записей нет');
    expect(empty).toHaveTextContent('Выберите другой период или вид действия');
    expect(screen.queryAllByTestId('journal-row')).toHaveLength(0);
    // «Показать ещё» при пустом ответе не показывается.
    expect(screen.queryByTestId('journal-more')).not.toBeInTheDocument();
  });

  it('«Показать ещё» дописывает вторую страницу по курсору', async () => {
    const fetchMock = mountJournal((url) => {
      if (!url.includes('/api/journal')) return NOT_FOUND;
      if (url.includes('cursor=cursor-1')) return page([UNKNOWN], null, null);
      return page([ENTRY], 'cursor-1', 2);
    });
    const user = userEvent.setup();
    renderApp('/cabinet/journal');

    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByTestId('journal-more'));

    await waitFor(() => expect(rows()).toHaveLength(2));
    // Вторая страница запрошена по курсору первой, а не заново с начала.
    expect(journalCalls(fetchMock).some((url) => url.includes('cursor=cursor-1'))).toBe(true);
    // Число записей за период приходит с первой страницей и не пропадает.
    expect(screen.getByTestId('journal-count')).toHaveTextContent('За этот период — 2 записи');
    expect(screen.queryByTestId('journal-more')).not.toBeInTheDocument();
  });

  it('фильтр по виду уходит в запрос, а не фильтрует ленту на клиенте', async () => {
    const fetchMock = mountJournal((url) => {
      if (url.includes('/api/journal')) return page([ENTRY], null, 1);
      return NOT_FOUND;
    });
    const user = userEvent.setup();
    renderApp('/cabinet/journal');

    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.selectOptions(await screen.findByTestId('journal-kind'), 'noise');
    await user.click(screen.getByRole('button', { name: 'Применить' }));

    await waitFor(() => {
      const filtered = journalCalls(fetchMock).some((raw) => {
        const url = new URL(raw, 'http://localhost');
        return url.searchParams.get('kind') === 'noise';
      });
      expect(filtered).toBe(true);
    });
    // Период передаётся явно: поле «От» и «До» заполнено, а не пустое.
    const lastUrl = new URL(journalCalls(fetchMock).at(-1) ?? '', 'http://localhost');
    expect(lastUrl.searchParams.get('date_from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lastUrl.searchParams.get('date_to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('422 фильтра показывает текст сервера, а не «проверьте соединение»', async () => {
    mountJournal((url) => {
      if (url.includes('/api/journal')) {
        return {
          status: 422,
          body: { detail: 'Слишком длинный период: журнал отдаётся не больше чем за 90 дней' },
        };
      }
      return NOT_FOUND;
    });
    renderApp('/cabinet/journal');

    const error = await screen.findByTestId('journal-error');
    expect(error).toHaveTextContent(
      'Слишком длинный период: журнал отдаётся не больше чем за 90 дней',
    );
    // Обвинение сети — ложь: 422 пришёл от сервера про период, а не про связь.
    expect(error).not.toHaveTextContent('Проверьте соединение');
    expect(screen.queryByTestId('journal-row')).not.toBeInTheDocument();
  });

  it('смена фильтра отменяет догрузку и не смешивает записи старого набора', async () => {
    let releaseMore = (): void => undefined;
    const moreGate = new Promise<void>((resolve) => {
      releaseMore = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/me')) return jsonResponse({ status: 200, body: OWNER });
      if (url.endsWith('/api/trial')) return jsonResponse(TRIAL_ACTIVE);
      if (url.endsWith('/api/solutions')) return jsonResponse({ status: 200, body: { items: [] } });
      if (!url.includes('/api/journal')) return jsonResponse(NOT_FOUND);
      // Следующая страница нового набора: только она и должна грузиться дальше.
      if (url.includes('cursor=cursor-9')) return jsonResponse(page([SECOND_PAGE], null, null));
      // Вторая страница старого набора висит, пока тест её не отпустит.
      if (url.includes('cursor=cursor-1')) {
        await moreGate;
        return jsonResponse(page([UNKNOWN], 'cursor-2', null));
      }
      // Новый фильтр — новый набор с собственным курсором.
      if (url.includes('kind=noise')) return jsonResponse(page([FILTERED], 'cursor-9', 1));
      return jsonResponse(page([ENTRY], 'cursor-1', 2));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderApp('/cabinet/journal');

    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByTestId('journal-more'));
    await waitFor(() =>
      expect(screen.getByTestId('journal-more')).toHaveAttribute('aria-busy', 'true'),
    );

    // Фильтр меняется, не дожидаясь ответа по курсору.
    await user.selectOptions(screen.getByTestId('journal-kind'), 'noise');
    await user.click(screen.getByRole('button', { name: 'Применить' }));
    expect(await screen.findByText('Удалить сотрудника')).toBeVisible();
    expect(rows()).toHaveLength(1);

    // Поздний ответ старого набора приходит уже после смены фильтра.
    releaseMore();
    await settle();

    // Строки старого набора не дописались, курсор остался курсором нового.
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText('put_dormitories_hostels_cells')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-more-error')).not.toBeInTheDocument();
    const more = screen.getByTestId('journal-more');
    expect(more).toHaveTextContent('Показать ещё');
    expect(more).not.toHaveAttribute('aria-busy');

    // Следующая догрузка идёт по курсору нового набора, а не старого.
    await user.click(more);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(journalCalls(fetchMock).some((url) => url.includes('cursor=cursor-9'))).toBe(true);
    expect(journalCalls(fetchMock).filter((url) => url.includes('cursor=cursor-2'))).toHaveLength(
      0,
    );
  });

  it('сбой загрузки показывает текст и кнопку «Повторить», которая перезапрашивает ленту', async () => {
    let attempt = 0;
    mountJournal((url) => {
      if (!url.includes('/api/journal')) return NOT_FOUND;
      attempt += 1;
      return attempt === 1 ? { status: 500, body: { detail: 'Ошибка' } } : page([ENTRY], null, 1);
    });
    const user = userEvent.setup();
    renderApp('/cabinet/journal');

    const error = await screen.findByTestId('journal-error');
    expect(error).toHaveTextContent('Не удалось загрузить журнал');
    await user.click(within(error).getByRole('button', { name: 'Повторить' }));

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId('journal-error')).not.toBeInTheDocument();
  });

  it('не владельцу прямой заход показывает «только владельцу» без фильтров и без пункта меню', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/me')) return { status: 200, body: MEMBER };
      if (url.endsWith('/api/trial')) return TRIAL_ACTIVE;
      if (url.endsWith('/api/solutions')) return { status: 200, body: { items: [] } };
      if (url.includes('/api/journal')) {
        return { status: 403, body: { detail: 'Недостаточно прав' } };
      }
      return NOT_FOUND;
    });
    renderApp('/cabinet/journal');

    const forbidden = await screen.findByTestId('journal-forbidden');
    expect(forbidden).toHaveTextContent('Журнал доступен только владельцу организации');
    expect(within(forbidden).getByRole('link', { name: 'Вернуться в обзор' })).toHaveAttribute(
      'href',
      '/cabinet',
    );
    // Пункт меню есть только у владельца, и применять фильтры не к чему.
    expect(screen.queryByTestId('workspace-nav-journal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-from')).not.toBeInTheDocument();
  });

  it('показывает загрузку, пока журнал не ответил', async () => {
    // Ответ журнала придерживается вручную: иначе состояние загрузки успело бы
    // смениться готовностью до первой проверки.
    let releaseJournal = (): void => undefined;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/me')) return jsonResponse({ status: 200, body: OWNER });
        if (url.endsWith('/api/trial')) return jsonResponse(TRIAL_ACTIVE);
        if (url.endsWith('/api/solutions'))
          return jsonResponse({ status: 200, body: { items: [] } });
        if (url.includes('/api/journal')) {
          await journalGate;
          return jsonResponse(page([ENTRY], null, 1));
        }
        return jsonResponse(NOT_FOUND);
      }),
    );
    renderApp('/cabinet/journal');

    expect(await screen.findByTestId('journal-loading')).toHaveTextContent('Загружаем журнал…');
    expect(screen.getByRole('button', { name: 'Применить' })).toBeDisabled();

    releaseJournal();
    await waitFor(() => expect(rows()).toHaveLength(1));
  });
});
