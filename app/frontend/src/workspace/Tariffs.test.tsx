import { screen, within } from '@testing-library/react';
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
};

/** Маршруты кабинета: `/api/me` — активная сессия, тариф приходит только на чтение. */
function tariffRoutes(current: MockResponse): MockHandler {
  return (url) => {
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/current')) return current;
    if (url.endsWith('/api/tariffs')) return { status: 200, body: [TARIFF] };
    return NOT_FOUND;
  };
}

/** Ответ сервера на тариф организации: поле `editable` из контракта убрано. */
function assigned(tariff: typeof TARIFF | null): MockResponse {
  return { status: 200, body: { tariff } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('раздел «Тариф» в кабинете', () => {
  it('показывает назначенный организации тариф, а не прайс', async () => {
    mockFetch(tariffRoutes(assigned(TARIFF)));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariff-current')).toBeInTheDocument();
    expect(screen.getByTestId('tariff-current-name')).toHaveTextContent('Базовый');
    expect(screen.getByTestId('tariff-current-price')).toHaveTextContent('5 000 ₽ в месяц');
    expect(screen.getByTestId('tariff-current-description')).toHaveTextContent('Всё основное');
    // Строки прайса с кнопками правки — это другой экран, которого больше нет.
    expect(screen.queryByTestId('tariff-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-edit')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-nav-tariffs')).toHaveAttribute('href', '/cabinet/tariffs');
    expect(document.title).toBe('Тариф — Домовой');
  });

  it('не оставляет в DOM ни одного элемента правки тарифа', async () => {
    mockFetch(tariffRoutes(assigned(TARIFF)));
    renderApp('/cabinet/tariffs');

    await screen.findByTestId('tariff-current');

    for (const testId of [
      'tariff-choose',
      'tariff-change',
      'tariff-save',
      'tariff-cancel',
      'tariff-option',
      'tariff-catalog-link',
      'tariff-choice-catalog-link',
      'tariffs-readonly',
      'tariff-current-visibility',
      'tariff-modal',
    ]) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
  });

  it('не запрашивает снятые ручки правки', async () => {
    const fetchMock = mockFetch(tariffRoutes(assigned(TARIFF)));
    renderApp('/cabinet/tariffs');

    await screen.findByTestId('tariff-current');

    expect(callsTo(fetchMock, '/api/tariffs/manage')).toHaveLength(0);
    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(1);
    // Единственный запрос к тарифу организации — чтение, без метода вовсе.
    expect(
      (callsTo(fetchMock, '/api/tariffs/current')[0][1] as RequestInit).method,
    ).toBeUndefined();
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
        : assigned(TARIFF);
    });
    const user = userEvent.setup();
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-error')).toHaveTextContent('Внутренняя ошибка');

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByTestId('tariff-current')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(2);
  });

  it('без тарифа объясняет, откуда он появится, и ничего не предлагает', async () => {
    mockFetch(tariffRoutes(assigned(null)));
    renderApp('/cabinet/tariffs');

    const empty = await screen.findByTestId('tariffs-empty');

    expect(empty).toHaveTextContent('Тариф организации ещё не назначен');
    expect(empty).toHaveTextContent('покупке');
    // Покупки в этой задаче нет: в пустом состоянии не должно быть ни кнопок,
    // ни ссылок на выбор тарифа — только объяснение.
    expect(within(empty).queryByRole('button')).not.toBeInTheDocument();
    expect(within(empty).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-catalog-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-choose')).not.toBeInTheDocument();
  });

  it('удалённый адрес прайс-листа ведёт в раздел «Тариф», а не в 404', async () => {
    mockFetch(tariffRoutes(assigned(TARIFF)));
    renderApp('/cabinet/tariffs/catalog');

    expect(await screen.findByTestId('tariff-current')).toBeInTheDocument();
    expect(screen.queryByTestId('tariffs-table')).not.toBeInTheDocument();
    expect(document.title).toBe('Тариф — Домовой');
  });

  it('участник без права правки видит тот же тариф без кнопок', async () => {
    // Роль на клиент больше не приходит: ответ одинаков, и правки нет ни у кого.
    mockFetch(tariffRoutes(assigned(TARIFF)));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariff-current-name')).toHaveTextContent('Базовый');
    expect(screen.queryByTestId('tariff-change')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tariff-choose')).not.toBeInTheDocument();
  });

  it('без организации показывает ошибку сервера', async () => {
    mockFetch(tariffRoutes(NOT_FOUND));
    renderApp('/cabinet/tariffs');

    expect(await screen.findByTestId('tariffs-error')).toHaveTextContent('Не найдено');
  });
});
