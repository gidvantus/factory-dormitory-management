import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationTariff, TrialState } from '../api/client';
import { mockFetch } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const USER = {
  email: 'owner@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
};

const LOCKED: TrialState = {
  ends_at: '2026-10-01T00:00:00Z',
  days_left: 0,
  is_active: false,
  locked: true,
  member_limit: 3,
};

const RUNNING: TrialState = {
  ends_at: '2026-11-01T00:00:00Z',
  days_left: 12,
  is_active: true,
  locked: false,
  member_limit: 3,
};

const NO_TARIFF: OrganizationTariff = {
  tariff: null,
  ends_at: null,
  days_left: 0,
  is_expiring: false,
  next: null,
};

/** Ярус «Рост» месяца: пятнадцать мест и известный конец периода. */
const GROWTH = {
  id: 21,
  name: 'Рост',
  description: 'Все разделы, расширенная отчётность и статистика',
  amount: '9900.00',
  currency: 'RUB',
  period: 'month' as const,
  unit_label: null,
  position: 21,
  max_members: 15,
  tooltip: 'Место — сотрудник с доступом к кабинету.',
  group_code: 'growth',
  price_label: '9 900 ₽ в месяц',
};

/** Оплаченный вперёд период: «Команда» на 12 месяцев. */
const TEAM = {
  ...GROWTH,
  id: 33,
  name: 'Команда · 12 месяцев',
  amount: '143000.00',
  period: 'year' as const,
  position: 33,
  max_members: 30,
  tooltip: null,
  group_code: 'team',
  price_label: '143 000 ₽ в год',
};

/**
 * Подписка с известным сроком. `daysLeft` — то, что посчитал сервер: сам фронт
 * дни из `ends_at` не вычитает и правило «за 14 дней» не повторяет.
 */
function subscription(
  daysLeft: number,
  next: OrganizationTariff['next'] = null,
): OrganizationTariff {
  return {
    tariff: GROWTH,
    ends_at: '2026-11-02T12:00:00Z',
    days_left: daysLeft,
    is_expiring: daysLeft > 0 && daysLeft <= 14,
    next,
  };
}

const EMPTY_DASHBOARD = {
  snapshot_date: '2026-10-04',
  totals: { residents: 0, attendance: 0 },
  dormitories: [],
  clients: [],
  daily: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountOverview(trial: TrialState, subscriptionBody: OrganizationTariff = NO_TARIFF) {
  const fetchMock = mockFetch((url) => {
    if (url.endsWith('/api/me')) return { status: 200, body: USER };
    if (url.endsWith('/api/trial')) return { status: 200, body: trial };
    if (url.endsWith('/api/tariffs/current')) return { status: 200, body: subscriptionBody };
    if (url.includes('/api/dashboard?')) return { status: 200, body: EMPTY_DASHBOARD };
    return { status: 404, body: { detail: 'Не найдено' } };
  });
  renderApp('/cabinet');
  return fetchMock;
}

describe('предупреждение о сроке тарифа', () => {
  it('за 14 дней показывает полосу с числом дней и ссылкой на прайс', async () => {
    mountOverview(RUNNING, subscription(14));

    const notice = await screen.findByTestId('tariff-notice');

    expect(within(notice).getByTestId('tariff-notice-days')).toHaveTextContent('14 дней');
    expect(notice).toHaveTextContent('Тариф истекает через');
    expect(notice).toHaveTextContent('оплачен до 02.11.2026');
    expect(notice).toHaveAttribute('role', 'status');

    const link = within(notice).getByTestId('tariff-notice-link');
    expect(link).toHaveAttribute('href', '/pricing');
    expect(link).toHaveTextContent('Открыть тарифы');
  });

  it('за 15 дней полосы нет: остаток виден только в ленте тарифа', async () => {
    mountOverview(RUNNING, subscription(15));

    expect(await screen.findByTestId('dashboard-tariff-ends')).toHaveTextContent(
      'Оплачен до 02.11.2026',
    );
    expect(screen.queryByTestId('tariff-notice')).not.toBeInTheDocument();
  });

  it('при оплаченном вперёд периоде говорит, что доплачивать не нужно', async () => {
    mountOverview(
      { ...RUNNING, is_active: false },
      subscription(5, { tariff: TEAM, starts_at: '2026-11-02T12:00:00Z' }),
    );

    const notice = await screen.findByTestId('tariff-notice');

    expect(within(notice).getByTestId('tariff-notice-days')).toHaveTextContent('5 дней');
    expect(notice).toHaveTextContent('начнётся «Команда · 12 месяцев»');
    expect(notice).toHaveTextContent('доплачивать не нужно');
  });

  it('без оплаченного вперёд периода предлагает продлить тариф', async () => {
    mountOverview({ ...RUNNING, is_active: false }, subscription(3));

    const notice = await screen.findByTestId('tariff-notice');

    expect(notice).toHaveTextContent('Продлите тариф, чтобы кабинет не закрылся');
    expect(notice).not.toHaveTextContent('доплачивать не нужно');
  });

  it('без тарифа и без истекающего срока молчит', async () => {
    mountOverview(RUNNING, NO_TARIFF);

    expect(await screen.findByTestId('workspace-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('tariff-notice')).not.toBeInTheDocument();
  });
});

describe('закрытый кабинет', () => {
  it('показывает заметный блок со ссылкой на тарифы и не выдумывает данных', async () => {
    mountOverview(LOCKED, NO_TARIFF);

    const notice = await screen.findByTestId('tariff-expired-notice');

    expect(notice).toHaveTextContent('Кабинет закрыт');
    expect(notice).toHaveTextContent('Выберите тариф, чтобы вернуть рабочие разделы');
    expect(notice).toHaveTextContent('данные и сотрудники сохранены');
    expect(notice).toHaveAttribute('role', 'status');

    const link = screen.getByTestId('tariff-expired-link');
    expect(link).toHaveAttribute('href', '/pricing');
    expect(link).toHaveTextContent('Выбрать тариф');
    expect(screen.queryByTestId('tariff-notice')).not.toBeInTheDocument();
  });

  it('держит сообщение внутри выделенного блока тарифа', async () => {
    mountOverview(LOCKED, NO_TARIFF);

    await screen.findByTestId('tariff-expired-notice');

    const block = screen.getByTestId('trial-tariff-block');
    expect(block).toHaveAttribute('data-trial', 'true');
    expect(block).toHaveAttribute('data-locked', 'true');
    expect(within(block).getByTestId('tariff-expired-notice')).toBeInTheDocument();
    expect(within(block).getByTestId('dashboard-tariff')).toBeInTheDocument();
  });
});

describe('пробный период на обзоре', () => {
  it('на идущем периоде показывает остаток дней и дату окончания в блоке «Ваш тариф»', async () => {
    mountOverview(RUNNING, NO_TARIFF);

    const note = await screen.findByTestId('trial-days-left');
    expect(note).toHaveTextContent('Пробный период: осталось 12 дней, до 01.11.2026');
    // Срок периода — часть «Вашего тарифа», а не отдельная строка над блоком.
    expect(within(screen.getByTestId('dashboard-tariff')).getByTestId('trial-days-left')).toBe(
      note,
    );
    expect(screen.queryByTestId('tariff-notice')).not.toBeInTheDocument();
  });

  it('с выбранным тарифом не показывает ничего о пробном периоде', async () => {
    mountOverview({ ...RUNNING, is_active: false }, subscription(30));

    expect(await screen.findByTestId('workspace-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('tariff-expired-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trial-days-left')).not.toBeInTheDocument();
  });

  it('читает состояние отдельной ручкой, а не из профиля', async () => {
    const fetchMock = mountOverview(RUNNING, NO_TARIFF);

    await screen.findByTestId('trial-days-left');

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/trial'))).toBe(true);
  });

  it('на идущем пробном периоде выделяет блок с остатком дней', async () => {
    mountOverview(RUNNING, NO_TARIFF);

    await screen.findByTestId('trial-days-left');

    const block = screen.getByTestId('trial-tariff-block');
    expect(block).toHaveAttribute('data-trial', 'true');
    expect(block).toHaveAttribute('data-locked', 'false');
    expect(within(block).getByTestId('trial-days-left')).toBeInTheDocument();
  });
});

describe('оплаченные периоды под лентой тарифа', () => {
  it('показывает действующий и оплаченный вперёд периоды с датами', async () => {
    mountOverview(
      { ...RUNNING, is_active: false },
      subscription(5, { tariff: TEAM, starts_at: '2026-11-02T12:00:00Z' }),
    );

    const slots = await screen.findByTestId('tariff-next');

    expect(slots).toHaveTextContent('Сейчас: «Рост» · до 02.11.2026');
    expect(slots).toHaveTextContent('Оплачено вперёд: «Команда · 12 месяцев» · с 02.11.2026');
  });

  it('без оплаченного вперёд периода блока нет', async () => {
    mountOverview({ ...RUNNING, is_active: false }, subscription(5));

    expect(await screen.findByTestId('dashboard-tariff-ends')).toBeInTheDocument();
    expect(screen.queryByTestId('tariff-next')).not.toBeInTheDocument();
  });
});
