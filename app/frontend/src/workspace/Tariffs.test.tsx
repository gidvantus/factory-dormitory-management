import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch } from '../test/mockFetch';
import type { MockHandler, MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const PROFILE: MockResponse = {
  status: 200,
  body: {
    email: 'owner@example.com',
    full_name: 'Иванов Иван Иванович',
    created_at: '2026-01-01T00:00:00Z',
    is_active: true,
  },
};

const NOT_FOUND: MockResponse = { status: 404, body: { detail: 'Не найдено' } };

const TARIFF = {
  id: 1,
  name: 'Базовый',
  description: 'Всё основное',
  amount: '5000.00',
  currency: 'RUB',
  period: 'month',
  unit_label: null,
  position: 1,
  is_visible: true,
  price_label: '5 000 ₽ в месяц',
  editable: true,
};

const YEARLY = {
  ...TARIFF,
  id: 2,
  name: 'Годовой',
  amount: '60000.00',
  period: 'year',
  position: 2,
  price_label: '60 000 ₽ в год',
};

/** Обработчик на один маршрут: `null` — «не мой случай, решает `tariffRoutes`». */
type PartialHandler = (url: string, init?: RequestInit) => MockResponse | null;

/** Маршруты кабинета: `/api/me` — активная сессия, прайс для выбора — два тарифа. */
function tariffRoutes(current: MockResponse, extra?: PartialHandler): MockHandler {
  return (url, init) => {
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/current')) return current;
    if (url.endsWith('/api/tariffs')) return { status: 200, body: [TARIFF, YEARLY] };
    return NOT_FOUND;
  };
}

function chosen(tariff: typeof TARIFF | null, editable = true): MockResponse {
  return { status: 200, body: { tariff, editable } };
}

/** Тело запроса по вызову `fetch`. */
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('раздел «Тариф» в кабинете', () => {
  it('показывает тариф организации, а не прайс', async () => {
    mockFetch(tariffRoutes(chosen(TARIFF)));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariff-current')).toBeInTheDocument();
    expect(screen.getByTestId('tariff-current-name')).toHaveTextContent('Базовый');
    expect(screen.getByTestId('tariff-current-price')).toHaveTextContent('5 000 ₽ в месяц');
    expect(screen.getByTestId('tariff-current-description')).toHaveTextContent('Всё основное');
    // Строки прайса с кнопками правки — это другой экран.
    expect(screen.queryByTestId('tariff-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-edit')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-nav-tariffs')).toHaveAttribute('href', '/cabinet/tariffs');
    expect(document.title).toBe('Тариф — Домовой');
  });

  it('ведёт на прайс-лист только того, кому сервер разрешил правку', async () => {
    mockFetch(tariffRoutes(chosen(TARIFF)));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariff-catalog-link')).toHaveAttribute(
      'href',
      '/cabinet/tariffs/catalog',
    );
    expect(screen.getByTestId('tariff-change')).toBeInTheDocument();
  });

  it('показывает загрузку, пока тариф не пришёл', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/tariffs/current')
          ? new Promise<Response>(() => {})
          : new Response(JSON.stringify(PROFILE.body), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-loading')).toBeInTheDocument();
  });

  it('показывает текст ошибки и повторяет запрос', async () => {
    let attempts = 0;
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/api/me')) return PROFILE;
      attempts += 1;
      return attempts === 1
        ? { status: 500, body: { detail: 'Внутренняя ошибка' } }
        : chosen(TARIFF);
    });
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-error')).toHaveTextContent('Внутренняя ошибка');

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByTestId('tariff-current')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(2);
  });

  it('без выбранного тарифа предлагает его выбрать', async () => {
    mockFetch(tariffRoutes(chosen(null)));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-empty')).toHaveTextContent(
      'У организации пока нет тарифа',
    );
    expect(screen.getByTestId('tariff-choose')).toBeInTheDocument();
  });

  it('при editable=false показывает тариф без кнопок правки', async () => {
    mockFetch(tariffRoutes(chosen(TARIFF, false)));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-readonly')).toHaveTextContent(
      'Менять тариф может владелец или администратор организации',
    );
    expect(screen.getByTestId('tariff-current')).toBeInTheDocument();
    expect(screen.queryByTestId('tariff-change')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-choose')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-catalog-link')).not.toBeInTheDocument();
  });

  it('закрывает выбор по «Отмена» без запроса', async () => {
    const fetchMock = mockFetch(tariffRoutes(chosen(null)));
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-choose'));
    await user.click(screen.getByTestId('tariff-cancel'));

    expect(screen.queryByTestId('tariff-modal')).not.toBeInTheDocument();
    expect(
      (callsTo(fetchMock, '/api/tariffs/current')[0][1] as RequestInit).method,
    ).toBeUndefined();
  });
});

describe('выбор тарифа организации', () => {
  it('выбирает тариф из опубликованного прайса', async () => {
    let selected: typeof TARIFF | null = null;
    const fetchMock = mockFetch(
      tariffRoutes(chosen(null), (url, init) => {
        if (url.endsWith('/api/tariffs/current') && init?.method === 'PUT') {
          selected = YEARLY;
          return { status: 200, body: { tariff: YEARLY, editable: true } };
        }
        if (url.endsWith('/api/tariffs/current')) {
          return { status: 200, body: { tariff: selected, editable: true } };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-choose'));
    expect(await screen.findAllByTestId('tariff-option')).toHaveLength(2);

    await user.click(screen.getByRole('radio', { name: /Годовой/ }));
    await user.click(screen.getByTestId('tariff-save'));

    expect(await screen.findByTestId('tariff-current-name')).toHaveTextContent('Годовой');
    await waitFor(() => expect(screen.queryByTestId('tariff-modal')).not.toBeInTheDocument());
    const put = callsTo(fetchMock, '/api/tariffs/current').find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
    );
    expect(bodyOf(put as unknown[])).toEqual({ tariff_id: 2 });
  });

  it('не отправляет пустой выбор', async () => {
    const fetchMock = mockFetch(tariffRoutes(chosen(null)));
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-choose'));
    await screen.findAllByTestId('tariff-option');

    expect(screen.getByTestId('tariff-save')).toBeDisabled();
    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(1);
  });

  it('сообщает, если в прайсе нет опубликованных тарифов', async () => {
    mockFetch(
      tariffRoutes(chosen(null), (url) => {
        if (url.endsWith('/api/tariffs')) return { status: 200, body: [] };
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-choose'));

    expect(await screen.findByTestId('tariff-choice-empty')).toHaveTextContent(
      'В прайсе нет опубликованных тарифов',
    );
  });

  it('показывает отказ сервера в модальном окне', async () => {
    mockFetch(
      tariffRoutes(chosen(null), (url, init) => {
        if (url.endsWith('/api/tariffs/current') && init?.method === 'PUT') {
          return { status: 404, body: { detail: 'Тариф не найден' } };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-choose'));
    await user.click(await screen.findByRole('radio', { name: /Базовый/ }));
    await user.click(screen.getByTestId('tariff-save'));

    expect(await screen.findByTestId('tariff-form-error')).toHaveTextContent('Тариф не найден');
    expect(screen.getByTestId('tariff-modal')).toBeInTheDocument();
  });
});
