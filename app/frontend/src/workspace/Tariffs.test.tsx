import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Tariff } from '../api/client';
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
const START: Tariff = {
  id: 1,
  name: 'Старт',
  description: 'До 10 пользователей.',
  amount: '10000.00',
  currency: 'RUB',
  period: 'month',
  unit_label: null,
  position: 1,
  price_label: '10 000 ₽ в месяц',
};
const STANDARD: Tariff = {
  ...START,
  id: 2,
  name: 'Стандарт',
  description: 'До 15 пользователей. Все разделы.',
  amount: '50000.00',
  period: 'half_year',
  price_label: '50 000 ₽ за 6 месяцев',
};
const MAXIMUM: Tariff = {
  ...START,
  id: 3,
  name: 'Максимум',
  description: 'Без ограничений по пользователям.',
  amount: '90000.00',
  period: 'year',
  price_label: '90 000 ₽ в год',
};
const PLANS = [START, STANDARD, MAXIMUM];

function routes(current: Tariff | null = null, catalog = PLANS): MockHandler {
  return (url) => {
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/current')) return { status: 200, body: { tariff: current } };
    if (url.endsWith('/api/tariffs')) return { status: 200, body: catalog };
    return NOT_FOUND;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('раздел «Тарифы» в кабинете', () => {
  it('показывает весь каталог с акцентом на Стандарт и серверными ценами', async () => {
    mockFetch(routes());
    renderApp('/cabinet/tariffs');
    const cards = await screen.findAllByTestId('tariff-card');
    expect(cards).toHaveLength(3);
    expect(screen.getAllByTestId('tariff-name').map((name) => name.textContent)).toEqual([
      'Стандарт',
      'Старт',
      'Максимум',
    ]);
    expect(cards[0]).toHaveAttribute('data-featured', 'true');
    expect(within(cards[0]).getByTestId('tariff-price')).toHaveTextContent(STANDARD.price_label);
    expect(within(cards[0]).getByTestId('tariff-description')).toHaveTextContent(
      STANDARD.description!,
    );
    for (const button of screen.getAllByTestId('tariff-buy')) expect(button).toBeEnabled();
    expect(screen.getByTestId('workspace-nav-tariffs')).toHaveAttribute('href', '/cabinet/tariffs');
    expect(document.title).toBe('Тарифы — Домовой');
  });

  it('помечает купленный тариф и блокирует повторную покупку', async () => {
    const fetchMock = mockFetch(routes(START));
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');
    const owned = await screen.findByTestId('tariff-owned');
    expect(owned.closest('article')).toHaveTextContent('Старт');
    const buttons = screen.getAllByTestId('tariff-buy');
    for (const button of buttons) expect(button).toBeDisabled();
    await user.click(buttons[0]);
    expect(callsTo(fetchMock, '/api/billing/invoices')).toHaveLength(0);
    expect(callsTo(fetchMock, '/api/tariffs/manage')).toHaveLength(0);
  });

  it('сохраняет снятый с продажи тариф организации и его условия', async () => {
    const archived = {
      ...START,
      id: 9,
      name: 'Архивный',
      is_visible: false,
      unit_label: 'За организацию',
    };
    mockFetch(routes(archived));
    renderApp('/cabinet/tariffs');
    const owned = await screen.findByTestId('tariff-owned');
    expect(owned.closest('article')).toHaveTextContent('Архивный');
    expect(owned.closest('article')).toHaveTextContent('За организацию');
    expect(screen.getAllByTestId('tariff-card')).toHaveLength(4);
  });

  it('ждёт проверки текущего тарифа перед показом кнопок покупки', async () => {
    const handler = routes();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/tariffs/current')) return new Promise<Response>(() => {});
        const response = handler(String(input));
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    renderApp('/cabinet/tariffs');
    expect(await screen.findByTestId('tariffs-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('tariff-buy')).not.toBeInTheDocument();
  });

  it.each(['/api/tariffs', '/api/tariffs/current'])(
    'повторяет загрузку после ошибки %s',
    async (endpoint) => {
      let attempts = 0;
      const handler = routes();
      const fetchMock = mockFetch((url, init) => {
        if (url.endsWith(endpoint) && ++attempts === 1)
          return { status: 500, body: { detail: 'Внутренняя ошибка' } };
        return handler(url, init);
      });
      const user = userEvent.setup();
      renderApp('/cabinet/tariffs');
      expect(await screen.findByTestId('tariffs-error')).toHaveTextContent('Внутренняя ошибка');
      expect(screen.queryByTestId('tariff-buy')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Повторить' }));
      expect(await screen.findAllByTestId('tariff-card')).toHaveLength(3);
      expect(callsTo(fetchMock, endpoint)).toHaveLength(2);
    },
  );

  it('показывает пустой каталог', async () => {
    mockFetch(routes(null, []));
    renderApp('/cabinet/tariffs');
    expect(await screen.findByTestId('tariffs-empty')).toHaveTextContent(
      'Тарифы ещё не опубликованы',
    );
    expect(screen.queryByTestId('tariff-buy')).not.toBeInTheDocument();
  });

  it('старый адрес каталога открывает новые карточки', async () => {
    mockFetch(routes());
    renderApp('/cabinet/tariffs/catalog');
    expect(await screen.findAllByTestId('tariff-card')).toHaveLength(3);
    expect(document.title).toBe('Тарифы — Домовой');
  });

  it('выставляет счёт за выбранный тариф и открывает Документы', async () => {
    const handler = routes();
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/billing/invoices'))
        return {
          status: init?.method === 'POST' ? 201 : 200,
          body: init?.method === 'POST' ? { id: 42 } : [],
        };
      return handler(url, init);
    });
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');
    const cards = await screen.findAllByTestId('tariff-card');
    await user.click(within(cards[0]).getByTestId('tariff-buy'));
    expect(await screen.findByTestId('documents-purchase-success')).toBeInTheDocument();
    const post = callsTo(fetchMock, '/api/billing/invoices').filter(
      (call) => (call[1] as RequestInit).method === 'POST',
    );
    expect(post).toHaveLength(1);
    expect(JSON.parse((post[0][1] as RequestInit).body as string)).toEqual({
      tariff_id: STANDARD.id,
    });
  });

  it('показывает отказ покупки и возвращает доступность кнопок', async () => {
    const handler = routes();
    mockFetch((url, init) =>
      url.endsWith('/api/billing/invoices')
        ? { status: 409, body: { detail: 'Тариф организации уже выбран' } }
        : handler(url, init),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');
    const cards = await screen.findAllByTestId('tariff-card');
    await user.click(within(cards[0]).getByTestId('tariff-buy'));
    expect(await screen.findByTestId('tariffs-buy-error')).toHaveTextContent(
      'Тариф организации уже выбран',
    );
    expect(screen.getByTestId('tariffs-page')).toBeInTheDocument();
    for (const button of screen.getAllByTestId('tariff-buy')) expect(button).toBeEnabled();
  });

  it('не разрешает покупку, если не удалось определить организацию', async () => {
    const handler = routes();
    mockFetch((url, init) =>
      url.endsWith('/api/tariffs/current') ? NOT_FOUND : handler(url, init),
    );
    renderApp('/cabinet/tariffs');
    expect(await screen.findByTestId('tariffs-error')).toHaveTextContent('Не найдено');
    expect(screen.queryByTestId('tariff-buy')).not.toBeInTheDocument();
  });
});
