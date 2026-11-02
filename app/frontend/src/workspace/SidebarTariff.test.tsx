import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch } from '../test/mockFetch';
import type { MockResponse } from '../test/mockFetch';
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
};

const TRIAL_RUNNING: MockResponse = {
  status: 200,
  body: {
    ends_at: '2026-11-01T00:00:00Z',
    days_left: 12,
    is_active: true,
    locked: false,
    member_limit: 3,
  },
};

const TRIAL_LOCKED: MockResponse = {
  status: 200,
  body: {
    ends_at: '2026-10-01T00:00:00Z',
    days_left: 0,
    is_active: false,
    locked: true,
    member_limit: null,
  },
};

/** Подписка организации: тариф со сроком, остатком дней и признаком скорого конца. */
function subscription(
  overrides: Partial<{
    tariff: typeof TARIFF | null;
    ends_at: string | null;
    days_left: number;
    is_expiring: boolean;
  }> = {},
): MockResponse {
  return {
    status: 200,
    body: {
      tariff: TARIFF,
      ends_at: '2026-12-02T00:00:00Z',
      days_left: 12,
      is_expiring: false,
      next: null,
      ...overrides,
    },
  };
}

/** Кабинет грузит профиль, пробный период, подписку и показатели обзора. */
function cabinetRoutes(tariff: MockResponse, trial?: MockResponse) {
  return (url: string): MockResponse => {
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/trial')) return trial ?? { status: 404, body: { detail: 'Не найдено' } };
    if (url.endsWith('/api/tariffs/current')) return tariff;
    if (url.includes('/api/dashboard')) return DASHBOARD;
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('карточка тарифа в левой панели', () => {
  it('показывает название тарифа, срок и ведёт на прайс', async () => {
    mockFetch(cabinetRoutes(subscription()));
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const ends = await within(card).findByTestId('sidebar-tariff-ends');

    expect(card).toHaveAttribute('data-access', 'paid');
    expect(within(card).getByTestId('sidebar-tariff-name')).toHaveTextContent('Базовый');
    expect(ends).toHaveTextContent('Оплачен до 02.12.2026');
    expect(card).toHaveTextContent('осталось 12 дней');
    expect(within(card).getByTestId('sidebar-tariff-link')).toHaveAttribute('href', '/pricing');
    expect(within(card).getByTestId('sidebar-tariff-link')).toHaveTextContent('О тарифе');
  });

  it('при скором конце тарифа предлагает продлить, а не «О тарифе»', async () => {
    mockFetch(
      cabinetRoutes(
        subscription({ ends_at: '2026-11-12T00:00:00Z', days_left: 5, is_expiring: true }),
      ),
    );
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const ends = await within(card).findByTestId('sidebar-tariff-ends');

    expect(card).toHaveAttribute('data-access', 'paid');
    expect(card).toHaveAttribute('data-state', 'expiring');
    expect(ends).toHaveTextContent('Оплачен до 12.11.2026');
    expect(within(card).getByTestId('sidebar-tariff-link')).toHaveTextContent('Продлить тариф');
    expect(within(card).getByTestId('sidebar-tariff-link')).toHaveAttribute('href', '/pricing');
  });

  it('у бессрочного тарифа вместо срока показывает цену', async () => {
    mockFetch(cabinetRoutes(subscription({ ends_at: null, days_left: 0 })));
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const price = await within(card).findByTestId('sidebar-tariff-price');

    expect(within(card).getByTestId('sidebar-tariff-name')).toHaveTextContent('Базовый');
    expect(price).toHaveTextContent('5 000 ₽ за одно место в месяц');
    expect(within(card).queryByTestId('sidebar-tariff-ends')).not.toBeInTheDocument();
    expect(within(card).getByTestId('sidebar-tariff-link')).toHaveTextContent('О тарифе');
  });

  it('на идущем пробном периоде показывает остаток дней и дату окончания', async () => {
    mockFetch(cabinetRoutes(subscription({ tariff: null, ends_at: null }), TRIAL_RUNNING));
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const days = await within(card).findByTestId('sidebar-tariff-trial-days');

    expect(card).toHaveAttribute('data-access', 'trial');
    expect(days).toHaveTextContent('осталось 12 дней, до 01.11.2026');
    expect(within(card).getByTestId('sidebar-tariff-choose')).toHaveTextContent('Выбрать тариф');
    expect(within(card).getByTestId('sidebar-tariff-choose')).toHaveAttribute('href', '/pricing');
  });

  it('без даты окончания пробного периода показывает только остаток дней', async () => {
    mockFetch(
      cabinetRoutes(subscription({ tariff: null, ends_at: null }), {
        status: 200,
        body: { ends_at: null, days_left: 12, is_active: true, locked: false, member_limit: null },
      }),
    );
    renderApp('/cabinet');

    const days = await screen.findByTestId('sidebar-tariff-trial-days');

    expect(days).toHaveTextContent('осталось 12 дней');
    expect(days).not.toHaveTextContent('до ');
  });

  it('без тарифа и без пробного периода объясняет, что условия появятся после покупки', async () => {
    mockFetch(cabinetRoutes(subscription({ tariff: null, ends_at: null, days_left: 0 })));
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const empty = await within(card).findByTestId('sidebar-tariff-empty');

    expect(card).toHaveAttribute('data-access', 'none');
    expect(card).toHaveTextContent('Тариф не выбран');
    expect(empty).toHaveTextContent('Его условия появятся здесь после покупки.');
    expect(within(empty).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).getByTestId('sidebar-tariff-choose')).toHaveAttribute('href', '/pricing');
  });

  it('на закрытом кабинете говорит об этом текстом и ведёт на прайс', async () => {
    mockFetch(cabinetRoutes(subscription({ tariff: null, ends_at: null }), TRIAL_LOCKED));
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');

    await within(card).findByText('Доступ закрыт');

    expect(card).toHaveAttribute('data-access', 'locked');
    expect(card).toHaveTextContent('Кабинет закрыт');
    expect(card).toHaveTextContent(
      'Срок тарифа или пробного периода закончился. Данные и сотрудники сохранены.',
    );
    expect(within(card).getByTestId('sidebar-tariff-choose')).toHaveTextContent('Выбрать тариф');
  });

  it('ошибка загрузки подписки не ломает кабинет: причина и «Повторить»', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(
      cabinetRoutes({ status: 500, body: { detail: 'Внутренняя ошибка' } }),
    );
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const error = await within(card).findByTestId('sidebar-tariff-error');

    expect(card).toHaveAttribute('data-access', 'none');
    expect(error).toHaveTextContent('Внутренняя ошибка');
    // Обзор на месте: тариф — дополнение к панели, а не замена экрана.
    expect(screen.getByTestId('workspace-overview')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Повторить' }));

    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(2);
  });

  it('первый кадр — «Загружаем тариф…» и карточка не пустая', async () => {
    // Подписка висит без ответа, поэтому загрузка — устойчивое состояние, а не
    // гонка с разбором ответа: оболочка уже отрисована, а данных ещё нет.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/tariffs/current')) return new Promise<Response>(() => undefined);
        if (url.endsWith('/api/me'))
          return new Response(JSON.stringify(PROFILE.body), { status: 200 });
        return new Response(JSON.stringify({ detail: 'Не найдено' }), { status: 404 });
      }),
    );
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');

    expect(card).toHaveAttribute('data-state', 'loading');
    expect(within(card).getByTestId('sidebar-tariff-loading')).toHaveTextContent(
      'Загружаем тариф…',
    );
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
  });

  it('стоит в панели кабинета, а ленты тарифа на обзоре больше нет', async () => {
    mockFetch(cabinetRoutes(subscription()));
    renderApp('/cabinet');

    const card = await screen.findByTestId('sidebar-tariff');
    const overview = screen.getByTestId('workspace-overview');
    const sidebar = screen.getByRole('complementary', { name: 'Боковая панель' });

    expect(sidebar).toContainElement(card);
    expect(within(overview).queryByTestId('sidebar-tariff')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-tariff')).not.toBeInTheDocument();
    // Обзор остаётся: блок тарифа на нём — только предупреждение о сроке и периоды.
    expect(screen.getByTestId('trial-tariff-block')).toBeInTheDocument();
  });
});
