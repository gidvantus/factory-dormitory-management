import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../../test/mockFetch';
import type { MockResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

const PROFILE: MockResponse = {
  status: 200,
  body: {
    email: 'owner@example.com',
    full_name: 'Иванов Иван Иванович',
    created_at: '2026-01-01T00:00:00Z',
    is_active: true,
  },
};

const DASHBOARD: MockResponse = {
  status: 200,
  body: {
    snapshot_date: '2026-10-04',
    totals: { residents: 35, attendance: 23 },
    dormitories: [],
    clients: [],
    daily: [],
  },
};

const TARIFF = {
  id: 1,
  name: 'Базовый',
  description: 'Всё основное',
  amount: '5000.00',
  currency: 'RUB',
  period: 'month',
  unit_label: 'за одно место',
  position: 1,
  is_visible: true,
  price_label: '5 000 ₽ за одно место в месяц',
  editable: true,
};

/** Обзор грузит и показатели, и тариф организации — маршруты нужны оба. */
function overviewRoutes(tariff: MockResponse) {
  return (url: string): MockResponse => {
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/current')) return tariff;
    if (url.includes('/api/dashboard')) return DASHBOARD;
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('тариф организации в обзоре', () => {
  it('показывает купленный тариф рядом с показателями', async () => {
    mockFetch(overviewRoutes({ status: 200, body: { tariff: TARIFF, editable: true } }));
    renderApp('/cabinet');

    expect(await screen.findByTestId('dashboard-tariff-price')).toHaveTextContent(
      '5 000 ₽ за одно место в месяц',
    );
    expect(screen.getByTestId('dashboard-tariff-name')).toHaveTextContent('Базовый');
    expect(screen.getByTestId('dashboard-tariff-link')).toHaveAttribute('href', '/cabinet/tariffs');
    // Дашборд остаётся на месте: тариф — дополнение, а не замена обзора.
    expect(screen.getByTestId('workspace-overview')).toBeInTheDocument();
  });

  it('без выбранного тарифа предлагает перейти в раздел «Тариф»', async () => {
    mockFetch(overviewRoutes({ status: 200, body: { tariff: null, editable: true } }));
    renderApp('/cabinet');

    expect(await screen.findByTestId('dashboard-tariff-empty')).toHaveTextContent(
      'Тариф не выбран',
    );
    expect(screen.getByTestId('dashboard-tariff-link')).toHaveAttribute('href', '/cabinet/tariffs');
    expect(screen.getByTestId('workspace-overview')).toBeInTheDocument();
  });

  it('ошибка загрузки тарифа не ломает дашборд', async () => {
    mockFetch(overviewRoutes({ status: 500, body: { detail: 'Внутренняя ошибка' } }));
    renderApp('/cabinet');

    expect(await screen.findByTestId('dashboard-tariff-error')).toHaveTextContent(
      'Внутренняя ошибка',
    );
    expect(screen.getByTestId('workspace-overview')).toBeInTheDocument();
  });
});
