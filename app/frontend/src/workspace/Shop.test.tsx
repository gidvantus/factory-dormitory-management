import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch } from '../test/mockFetch';
import type { MockHandler, MockResponse } from '../test/mockFetch';
import { Shop } from './Shop';
import { SolutionsProvider } from './SolutionsProvider';

/** Решение каталога: цена и подпись цены приходят с сервера. */
const SOLUTION = {
  id: 7,
  code: 'telegram_notifications',
  name: 'Уведомления в Telegram',
  description: 'Сообщения о событиях, которые вас касаются',
  amount: '500.00',
  currency: 'RUB',
  period: 'month',
  price_label: '500 ₽ в месяц',
  is_owned: false,
  expires_at: null,
};

/** Счёт за решение: сервер отвечает им на покупку. */
const INVOICE: MockResponse = {
  status: 201,
  body: {
    id: 11,
    number: 'СЧ-2026-11',
    status: 'new',
    status_label: 'Новый',
    item_kind: 'solution',
    amount: '500.00',
    currency: 'RUB',
    amount_label: '500 ₽ в месяц',
    tariff_name: 'Уведомления в Telegram',
    tariff_period: 'month',
    buyer_name: 'ООО «Домовой»',
    buyer_inn: '7701234567',
    buyer_kpp: null,
    buyer_ogrn: null,
    buyer_address: null,
    has_act: false,
    can_manage: true,
    paid_at: null,
    created_at: '2026-01-01T00:00:00Z',
  },
};

const NOT_FOUND: MockResponse = { status: 404, body: { detail: 'Не найдено' } };

/** Магазин без сессии: каталог мокается отдельно, всё остальное — 404. */
function shopRoutes(catalog: MockResponse, purchase: MockResponse = INVOICE): MockHandler {
  return (url, init) => {
    if (url.endsWith('/api/solutions')) return catalog;
    if (url.endsWith('/api/billing/invoices') && init?.method === 'POST') return purchase;
    return NOT_FOUND;
  };
}

/**
 * Магазин целиком: провайдер отдаёт права организации, маршрут документов —
 * цель перехода после покупки.
 */
function renderShop(handler: MockHandler): ReturnType<typeof mockFetch> {
  const fetchMock = mockFetch(handler);
  render(
    <MemoryRouter initialEntries={['/cabinet/shop']}>
      <SolutionsProvider>
        <Routes>
          <Route path="/cabinet/shop" element={<Shop />} />
          <Route path="/cabinet/documents" element={<p>Страница документов</p>} />
          <Route path="/cabinet/notifications" element={<p>Настройки уведомлений</p>} />
        </Routes>
      </SolutionsProvider>
    </MemoryRouter>,
  );
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('магазин улучшений', () => {
  it('показывает карточку решения с ценой и описанием от сервера', async () => {
    renderShop(shopRoutes({ status: 200, body: { items: [SOLUTION] } }));

    const card = await screen.findByTestId('solution-card');
    expect(within(card).getByTestId('solution-name')).toHaveTextContent('Уведомления в Telegram');
    // Цену собирает сервер: страница показывает `price_label` как есть.
    expect(within(card).getByTestId('solution-price')).toHaveTextContent('500 ₽ в месяц');
    expect(within(card).getByTestId('solution-description')).toHaveTextContent(
      'Сообщения о событиях, которые вас касаются',
    );
    expect(within(card).getByTestId('solution-buy')).toBeInTheDocument();
    expect(within(card).getByTestId('solution-telegram-example')).toHaveTextContent(
      'Пример уведомления',
    );
    expect(
      within(card).queryByRole('link', { name: 'Настроить уведомления' }),
    ).not.toBeInTheDocument();
    // Права нет — метки «Подключено» и срока быть не должно.
    expect(screen.queryByTestId('solution-owned')).not.toBeInTheDocument();
    expect(screen.queryByTestId('solution-expiry')).not.toBeInTheDocument();
  });

  it('показывает загрузку, пока каталог не ответил', () => {
    renderShop(shopRoutes({ status: 200, body: { items: [SOLUTION] } }));

    expect(screen.getByTestId('shop-loading')).toBeInTheDocument();
  });

  it('объясняет пустой каталог', async () => {
    renderShop(shopRoutes({ status: 200, body: { items: [] } }));

    expect(await screen.findByTestId('shop-empty')).toHaveTextContent(
      'Решения ещё не опубликованы',
    );
    expect(screen.queryByTestId('solution-card')).not.toBeInTheDocument();
  });

  it('на ошибке каталога показывает повтор, который перечитывает список', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const fetchMock = renderShop((url) => {
      if (url.endsWith('/api/solutions')) {
        attempt += 1;
        return attempt === 1
          ? { status: 500, body: { detail: 'Ошибка' } }
          : { status: 200, body: { items: [SOLUTION] } };
      }
      return NOT_FOUND;
    });

    expect(await screen.findByTestId('shop-error')).toBeInTheDocument();

    await user.click(screen.getByTestId('shop-retry'));

    expect(await screen.findByTestId('solution-card')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/solutions')).toHaveLength(2);
  });

  it('заводит счёт за решение и уводит в «Документы»', async () => {
    const user = userEvent.setup();
    const fetchMock = renderShop(shopRoutes({ status: 200, body: { items: [SOLUTION] } }));

    await user.click(await screen.findByTestId('solution-buy'));

    expect(await screen.findByText('Страница документов')).toBeInTheDocument();
    const calls = callsTo(fetchMock, '/api/billing/invoices');
    expect(calls).toHaveLength(1);
    // В теле — именно предмет-решение: счёт за тариф выставляется другой ручкой.
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({ solution_id: 7 });
  });

  it('показывает отказ сервера на покупке и не уводит со страницы', async () => {
    const user = userEvent.setup();
    renderShop(
      shopRoutes(
        { status: 200, body: { items: [SOLUTION] } },
        { status: 409, body: { detail: 'Заполните название и ИНН организации' } },
      ),
    );

    await user.click(await screen.findByTestId('solution-buy'));

    expect(await screen.findByTestId('shop-buy-error')).toHaveTextContent(
      'Заполните название и ИНН организации',
    );
    expect(screen.getByTestId('shop-page')).toBeInTheDocument();
    expect(screen.queryByText('Страница документов')).not.toBeInTheDocument();
  });

  it('помечает подключённое решение сроком и оставляет кнопку для продления', async () => {
    const user = userEvent.setup();
    const fetchMock = renderShop(
      shopRoutes({
        status: 200,
        body: {
          items: [{ ...SOLUTION, is_owned: true, expires_at: '2026-11-14T10:00:00Z' }],
        },
      }),
    );

    const card = await screen.findByTestId('solution-card');
    expect(card).toHaveAttribute('data-owned', 'true');
    expect(within(card).getByTestId('solution-owned')).toHaveTextContent('Подключено');
    expect(within(card).getByTestId('solution-expiry')).toHaveTextContent('Действует до');
    // Кнопка покупки остаётся доступной: вторая покупка — это продление.
    expect(within(card).getByTestId('solution-buy')).toBeEnabled();
    expect(within(card).getByTestId('solution-buy')).toHaveAccessibleName(
      `Продлить: ${SOLUTION.name}`,
    );
    await user.click(within(card).getByTestId('solution-buy'));
    expect(await screen.findByText('Страница документов')).toBeInTheDocument();
    const calls = callsTo(fetchMock, '/api/billing/invoices');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({
      solution_id: SOLUTION.id,
    });
  });

  it('пишет «Действует бессрочно», когда срока у права нет', async () => {
    renderShop(
      shopRoutes({
        status: 200,
        body: { items: [{ ...SOLUTION, is_owned: true, expires_at: null }] },
      }),
    );

    expect(await screen.findByTestId('solution-expiry')).toHaveTextContent('Действует бессрочно');
  });

  it('открывает настройки подключённого Telegram без покупки и отправки сообщений', async () => {
    const user = userEvent.setup();
    const fetchMock = renderShop(
      shopRoutes({
        status: 200,
        body: { items: [{ ...SOLUTION, is_owned: true }] },
      }),
    );
    const link = await screen.findByRole('link', { name: 'Настроить уведомления' });
    expect(link).toHaveAttribute('href', '/cabinet/notifications');
    await user.click(link);
    expect(await screen.findByText('Настройки уведомлений')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/billing/invoices')).toHaveLength(0);
    expect(fetchMock.mock.calls.every((call) => !(call[1] as RequestInit)?.method)).toBe(true);
  });

  it('показывает другие решения с их ценой и ID без чужих возможностей Telegram', async () => {
    const other = {
      ...SOLUTION,
      id: 91,
      code: 'additional_solution',
      name: 'Дополнительное решение',
      description: 'Описание другого решения из каталога.',
      price_label: '1 250 ₽ в год',
      period: 'year',
    };
    const user = userEvent.setup();
    const fetchMock = renderShop(shopRoutes({ status: 200, body: { items: [SOLUTION, other] } }));
    const cards = await screen.findAllByTestId('solution-card');
    const second = within(cards[1]);
    expect(second.getByTestId('solution-name')).toHaveTextContent(other.name);
    expect(second.getByTestId('solution-description')).toHaveTextContent(other.description);
    expect(second.getByTestId('solution-price')).toHaveTextContent(other.price_label);
    expect(second.queryByTestId('solution-telegram-example')).not.toBeInTheDocument();
    expect(second.queryByText('Выбор нужных уведомлений')).not.toBeInTheDocument();
    expect(second.queryByRole('link')).not.toBeInTheDocument();
    await user.click(second.getByTestId('solution-buy'));
    expect(await screen.findByText('Страница документов')).toBeInTheDocument();
    const calls = callsTo(fetchMock, '/api/billing/invoices');
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({
      solution_id: other.id,
    });
  });
});
