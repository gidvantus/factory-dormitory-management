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

const CREATED = {
  ...TARIFF,
  id: 2,
  name: 'Годовой',
  amount: '60000.00',
  period: 'year',
  position: 2,
  price_label: '60 000 ₽ в год',
};

/** Обработчик на один маршрут: `null` — «не мой случай, решает `cabinetRoutes`». */
type PartialHandler = (url: string, init?: RequestInit) => MockResponse | null;

/** Маршруты кабинета: `/api/me` — активная сессия, остальное задаёт тест. */
function cabinetRoutes(manageTariffs: MockResponse, extra?: PartialHandler): MockHandler {
  return (url, init) => {
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/manage')) return manageTariffs;
    return NOT_FOUND;
  };
}

/** Тело запроса по вызову `fetch`. */
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('раздел «Тарифы» в кабинете', () => {
  it('показывает прайс и пункт меню со своим заголовком', async () => {
    mockFetch(cabinetRoutes({ status: 200, body: [TARIFF] }));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariff-row')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-nav-tariffs')).toHaveAttribute('href', '/cabinet/tariffs');
    expect(screen.getByTestId('tariff-row-price')).toHaveTextContent('5 000 ₽ в месяц');
    expect(screen.getByTestId('tariff-visibility')).toHaveTextContent('Опубликован');
    expect(document.title).toBe('Тарифы — Домовой');
  });

  it('показывает загрузку, пока список не пришёл', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/tariffs/manage')
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
        : { status: 200, body: [TARIFF] };
    });
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-error')).toHaveTextContent('Внутренняя ошибка');

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByTestId('tariff-row')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tariffs/manage')).toHaveLength(2);
  });

  it('на пустом прайсе предлагает добавить тариф', async () => {
    mockFetch(cabinetRoutes({ status: 200, body: [] }));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-empty')).toHaveTextContent('Тарифов пока нет');
    expect(screen.getByTestId('tariff-add')).toBeInTheDocument();
  });

  it('при editable=false показывает список без кнопок правки', async () => {
    mockFetch(cabinetRoutes({ status: 200, body: [{ ...TARIFF, editable: false }] }));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-readonly')).toHaveTextContent(
      'Править тарифы может владелец или администратор организации',
    );
    expect(screen.getByTestId('tariff-row')).toBeInTheDocument();
    expect(screen.queryByTestId('tariff-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-toggle-visibility')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-delete')).not.toBeInTheDocument();
  });
});

describe('правка тарифов', () => {
  it('создаёт тариф через модальное окно', async () => {
    let created = false;
    const fetchMock = mockFetch(
      cabinetRoutes({ status: 200, body: [] }, (url, init) => {
        if (url.endsWith('/api/tariffs/manage')) {
          return { status: 200, body: created ? [CREATED] : [] };
        }
        if (url.endsWith('/api/tariffs') && init?.method === 'POST') {
          created = true;
          return { status: 201, body: CREATED };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-add'));
    expect(screen.getByTestId('tariff-modal')).toBeInTheDocument();
    // Модальное окно само ставит фокус в первое поле формы.
    expect(screen.getByTestId('tariff-form-name')).toHaveFocus();

    await user.type(screen.getByTestId('tariff-form-name'), 'Годовой');
    await user.type(screen.getByTestId('tariff-form-description'), 'На год вперёд');
    await user.type(screen.getByTestId('tariff-form-amount'), '60000');
    await user.selectOptions(screen.getByTestId('tariff-form-period'), 'year');
    await user.type(screen.getByTestId('tariff-form-unit'), 'за одно место');
    await user.click(screen.getByTestId('tariff-save'));

    expect(await screen.findByTestId('tariff-row')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('tariff-modal')).not.toBeInTheDocument());
    const post = callsTo(fetchMock, '/api/tariffs')[0];
    expect(bodyOf(post)).toEqual({
      name: 'Годовой',
      description: 'На год вперёд',
      amount: 60000,
      currency: 'RUB',
      period: 'year',
      unit_label: 'за одно место',
      is_visible: true,
    });
  });

  it('не отправляет форму без названия', async () => {
    const fetchMock = mockFetch(cabinetRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-add'));
    await user.click(screen.getByTestId('tariff-save'));

    expect(screen.getByTestId('tariff-form-error')).toHaveTextContent('Укажите название тарифа');
    expect(callsTo(fetchMock, '/api/tariffs')).toHaveLength(0);
  });

  it('показывает отказ сервера в форме', async () => {
    mockFetch(
      cabinetRoutes({ status: 200, body: [TARIFF] }, (url, init) => {
        if (url.endsWith('/api/tariffs') && init?.method === 'POST') {
          return { status: 409, body: { detail: 'Тариф с таким названием уже есть' } };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-add'));
    await user.type(screen.getByTestId('tariff-form-name'), 'Базовый');
    await user.type(screen.getByTestId('tariff-form-amount'), '100');
    await user.click(screen.getByTestId('tariff-save'));

    expect(await screen.findByTestId('tariff-form-error')).toHaveTextContent(
      'Тариф с таким названием уже есть',
    );
  });

  it('правит сумму существующего тарифа', async () => {
    const fetchMock = mockFetch(
      cabinetRoutes({ status: 200, body: [TARIFF] }, (url, init) => {
        if (url.endsWith('/api/tariffs/1') && init?.method === 'PATCH') {
          return { status: 200, body: { ...TARIFF, amount: '7500.00' } };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-edit'));

    const amount = screen.getByTestId('tariff-form-amount');
    expect(amount).toHaveValue('5000.00');
    await user.clear(amount);
    await user.type(amount, '7500');
    await user.click(screen.getByTestId('tariff-save'));

    await waitFor(() => expect(screen.queryByTestId('tariff-modal')).not.toBeInTheDocument());
    // Форма шлёт все поля целиком: на сервер правка приходит как `PATCH`.
    const patch = callsTo(fetchMock, '/api/tariffs/1')[0];
    expect((patch[1] as RequestInit).method).toBe('PATCH');
    expect(bodyOf(patch)).toMatchObject({ name: 'Базовый', amount: 7500 });
  });

  it('закрывает форму по кнопке «Отмена» без запроса', async () => {
    const fetchMock = mockFetch(cabinetRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-edit'));
    await user.click(screen.getByTestId('tariff-cancel'));

    expect(screen.queryByTestId('tariff-modal')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tariffs/1')).toHaveLength(0);
  });

  it('скрывает тариф кнопкой в строке', async () => {
    const fetchMock = mockFetch(
      cabinetRoutes({ status: 200, body: [TARIFF] }, (url, init) => {
        if (url.endsWith('/api/tariffs/1') && init?.method === 'PATCH') {
          return { status: 200, body: { ...TARIFF, is_visible: false } };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-toggle-visibility'));

    await waitFor(() => expect(callsTo(fetchMock, '/api/tariffs/1')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/api/tariffs/1')[0])).toEqual({ is_visible: false });
  });

  it('удаляет тариф', async () => {
    const fetchMock = mockFetch(
      cabinetRoutes({ status: 200, body: [TARIFF] }, (url, init) => {
        if (url.endsWith('/api/tariffs/1') && init?.method === 'DELETE') {
          return { status: 204 };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-delete'));

    await waitFor(() => expect(callsTo(fetchMock, '/api/tariffs/1')).toHaveLength(1));
    expect((callsTo(fetchMock, '/api/tariffs/1')[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('показывает ошибку действия, если сервер отказал', async () => {
    mockFetch(
      cabinetRoutes({ status: 200, body: [TARIFF] }, (url, init) => {
        if (url.endsWith('/api/tariffs/1') && init?.method === 'DELETE') {
          return { status: 403, body: { detail: 'Недостаточно прав' } };
        }
        return null;
      }),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    await user.click(await screen.findByTestId('tariff-delete'));

    expect(await screen.findByTestId('tariffs-action-error')).toHaveTextContent(
      'Недостаточно прав',
    );
  });
});
