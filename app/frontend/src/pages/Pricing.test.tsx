import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch } from '../test/mockFetch';
import type { MockHandler, MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const ANONYMOUS: MockResponse = { status: 401, body: { detail: 'Требуется авторизация' } };

const PROFILE: MockResponse = {
  status: 200,
  body: {
    email: 'owner@example.com',
    full_name: 'Иванов Иван Иванович',
    created_at: '2026-01-01T00:00:00Z',
    is_active: true,
  },
};

/** Разделитель разрядов у сервера неразрывный (`app/pricing.py`). */
const NB = '\u00a0';

function money(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, NB);
}

const PERIOD_SUFFIX = {
  month: 'в месяц',
  quarter: 'за 3 месяца',
  year: 'в год',
} as const;

type Period = keyof typeof PERIOD_SUFFIX;

/** Сетка прайса из постановки: четыре яруса, три срока у каждого. */
const TIER_GRID: {
  group_code: string;
  title: string;
  max_members: number | null;
  prices: Record<Period, number>;
  tooltip: string | null;
}[] = [
  {
    group_code: 'start',
    title: 'Старт',
    max_members: 5,
    prices: { month: 4900, quarter: 13200, year: 47000 },
    tooltip: 'Место — сотрудник с доступом к кабинету. Проживающие не считаются.',
  },
  {
    group_code: 'growth',
    title: 'Рост',
    max_members: 15,
    prices: { month: 9900, quarter: 26700, year: 95000 },
    tooltip: null,
  },
  {
    group_code: 'team',
    title: 'Команда',
    max_members: 30,
    prices: { month: 14900, quarter: 40200, year: 143000 },
    tooltip: 'Несколько общежитий и отчёты по каждому.',
  },
  {
    group_code: 'unlimited',
    title: 'Безлимит',
    max_members: null,
    prices: { month: 19900, quarter: 53700, year: 191000 },
    tooltip: null,
  },
];

const PERIODS: Period[] = ['month', 'quarter', 'year'];

/** Имя строки прайса: месячная называется ярусом, остальные — со сроком. */
function rowName(title: string, period: Period): string {
  return period === 'month' ? title : `${title} · ${PERIOD_SUFFIX[period].replace('за ', '')}`;
}

const PLANS = TIER_GRID.flatMap((tier, tierIndex) =>
  PERIODS.map((period, periodIndex) => ({
    id: (tierIndex + 1) * 10 + periodIndex + 1,
    name: rowName(tier.title, period),
    description: `Все разделы для яруса «${tier.title}»`,
    amount: `${tier.prices[period]}.00`,
    currency: 'RUB',
    period,
    unit_label: null,
    position: tierIndex * 10 + periodIndex + 1,
    max_members: tier.max_members,
    tooltip: tier.tooltip,
    group_code: tier.group_code,
    price_label: `${money(tier.prices[period])} ₽ ${PERIOD_SUFFIX[period]}`,
  })),
);

/** Строка прайса по ярусу и сроку: её и покупает человек. */
function plan(groupCode: string, period: Period = 'month') {
  const found = PLANS.find((row) => row.group_code === groupCode && row.period === period);
  if (!found) throw new Error(`нет строки ${groupCode}/${period}`);
  return found;
}

/** Подписки нет: организация тарифа ещё не покупала. */
const NO_SUBSCRIPTION = {
  tariff: null,
  ends_at: null,
  days_left: 0,
  is_expiring: false,
  next: null,
};

/** Счёт, который сервер возвращает на покупку. */
const INVOICE = {
  id: 1,
  number: 'СЧ-2026-1',
  status: 'new',
  status_label: 'Новый',
  amount: '4900.00',
  currency: 'RUB',
  amount_label: '4 900 ₽ в месяц',
  tariff_name: 'Старт',
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
};

/** Сессия анонимная: страница тарифов публичная, 401 от `/api/me` — норма. */
function publicRoutes(tariffs: MockResponse): MockHandler {
  return (url) => {
    if (url.endsWith('/api/tariffs')) return tariffs;
    if (url.endsWith('/api/me')) return ANONYMOUS;
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

/**
 * Та же страница с активной сессией.
 *
 * `purchase` — ответ на покупку; без него POST отвечает успехом со счётом, а
 * чтение счетов отдаёт список с тем же счётом: после покупки страница уводит в
 * «Документы», и тем же маршрутом она их и читает. `current` — подписка
 * организации; без неё организация тарифа не имеет.
 */
function signedInRoutes(
  tariffs: MockResponse,
  purchase?: MockResponse,
  current?: MockResponse,
): MockHandler {
  return (url, init) => {
    if (url.endsWith('/api/tariffs')) return tariffs;
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/current')) {
      return current ?? { status: 200, body: NO_SUBSCRIPTION };
    }
    if (url.endsWith('/api/billing/invoices')) {
      if (init?.method === 'POST') return purchase ?? { status: 201, body: INVOICE };
      return { status: 200, body: [INVOICE] };
    }
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

/** Вызовы одного маршрута с указанным методом. */
function callsWithMethod(
  fetchMock: ReturnType<typeof vi.fn>,
  path: string,
  method: string,
): unknown[][] {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]).endsWith(path) && (call[1] as RequestInit | undefined)?.method === method,
  );
}

/** Нажимает вариант срока в переключателе. */
async function choosePeriod(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
): Promise<void> {
  const option = await screen.findByRole('radio', { name: label });
  await user.click(option);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('публичная страница тарифов', () => {
  it('доступна без сессии и показывает карточки из базы', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing')).toBeInTheDocument();
    // Четыре яруса по три срока: на экране — ярус, а не каждая строка прайса.
    expect(screen.getAllByTestId('tariff-card')).toHaveLength(4);
    expect(screen.getAllByTestId('tariff-name').map((node) => node.textContent)).toEqual([
      'Старт',
      'Рост',
      'Команда',
      'Безлимит',
    ]);
    expect(screen.getAllByTestId('tariff-description')[0]).toHaveTextContent(
      'Все разделы для яруса «Старт»',
    );
    // Цену собирает сервер: страница показывает `price_label` как есть.
    expect(screen.getAllByTestId('tariff-price')[0]).toHaveTextContent('4 900 ₽ в месяц');
    expect(screen.queryByTestId('pricing-empty')).not.toBeInTheDocument();
  });

  it('читает только публичный список и не запрашивает кабинетный', async () => {
    const fetchMock = mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    await screen.findAllByTestId('tariff-card');

    expect(callsTo(fetchMock, '/api/tariffs')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tariffs/manage')).toHaveLength(0);
  });

  it('по умолчанию показывает месячный срок', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    await screen.findAllByTestId('tariff-card');

    expect(screen.getByRole('radio', { name: '1 месяц' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '3 месяца' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getAllByTestId('tariff-price').map((node) => node.textContent)).toEqual([
      `${money(4900)} ₽ в месяц`,
      `${money(9900)} ₽ в месяц`,
      `${money(14900)} ₽ в месяц`,
      `${money(19900)} ₽ в месяц`,
    ]);
  });

  it('показывает в плашке предел мест и подсказку яруса', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    await screen.findAllByTestId('tariff-card');

    expect(screen.getAllByTestId('tariff-seats').map((node) => node.textContent)).toEqual([
      'до 5 сотрудников',
      'до 15 сотрудников',
      'до 30 сотрудников',
      'без ограничения',
    ]);
    // Подсказка есть только у ярусов, где сервер её отдал.
    expect(screen.getAllByTestId('tariff-tooltip')).toHaveLength(2);
  });

  it('раскрывает подсказку яруса по кнопке', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findAllByTestId('tariff-card');
    const tooltip = screen.getAllByTestId('tariff-tooltip')[0];
    expect(tooltip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.click(tooltip);

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Место — сотрудник с доступом к кабинету',
    );
    expect(tooltip).toHaveAttribute('aria-expanded', 'true');
  });

  it('переключатель срока меняет цену каждой плашки', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findAllByTestId('tariff-card');
    await choosePeriod(user, '3 месяца');

    expect(screen.getByRole('radio', { name: '3 месяца' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByTestId('tariff-price').map((node) => node.textContent)).toEqual([
      `${money(13200)} ₽ за 3 месяца`,
      `${money(26700)} ₽ за 3 месяца`,
      `${money(40200)} ₽ за 3 месяца`,
      `${money(53700)} ₽ за 3 месяца`,
    ]);

    await choosePeriod(user, '12 месяцев');

    // Разделитель разрядов — неразрывный пробел сервера, поэтому сравнение
    // дословное, а не через `toHaveTextContent` (он схлопывает пробелы).
    expect(screen.getAllByTestId('tariff-price')[0].textContent).toBe(`${money(47000)} ₽ в год`);
  });

  it('переключателя нет, когда в прайсе один срок', async () => {
    mockFetch(publicRoutes({ status: 200, body: [plan('start')] }));
    renderApp('/pricing');

    expect(await screen.findAllByTestId('tariff-card')).toHaveLength(1);
    expect(screen.queryByTestId('tariff-period-switch')).not.toBeInTheDocument();
  });

  it('показывает плашки с ценой и кнопкой «Купить»', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    expect(await screen.findAllByTestId('tariff-card')).toHaveLength(4);
    const buy = screen.getAllByTestId('tariff-buy');
    expect(buy).toHaveLength(4);
    expect(buy[0]).toHaveTextContent('Купить');
  });

  it('кнопка «Купить» открывает регистрацию на самой странице', async () => {
    mockFetch(publicRoutes({ status: 200, body: [plan('start')] }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('tariff-buy'));

    expect(await screen.findByTestId('register-email')).toBeInTheDocument();
    // Уводить на главную ради формы незачем: страница остаётся на месте.
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
    // Анониму окно подтверждения не показывается: счёт выставляется вошедшему.
    expect(screen.queryByTestId('purchase-confirm')).not.toBeInTheDocument();
  });

  it('показывает загрузку, пока запрос в пути', () => {
    // Незавершённый запрос: состояние загрузки видно до ответа сервера.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/tariffs')
          ? new Promise<Response>(() => {})
          : new Response(JSON.stringify({ detail: 'Требуется авторизация' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
    renderApp('/pricing');

    expect(screen.getByTestId('pricing-loading')).toBeInTheDocument();
  });

  it('показывает текст ошибки от API и позволяет повторить запрос', async () => {
    let attempts = 0;
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/api/tariffs')) {
        attempts += 1;
        return attempts === 1
          ? { status: 503, body: { detail: 'Сервис временно недоступен' } }
          : { status: 200, body: PLANS };
      }
      return ANONYMOUS;
    });
    const user = userEvent.setup();
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing-error')).toHaveTextContent(
      'Сервис временно недоступен',
    );

    await user.click(screen.getByTestId('pricing-retry'));

    expect(await screen.findAllByTestId('tariff-card')).toHaveLength(4);
    expect(screen.queryByTestId('pricing-error')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tariffs')).toHaveLength(2);
  });

  it('вместо пустой сетки показывает, что тарифы не опубликованы', async () => {
    mockFetch(publicRoutes({ status: 200, body: [] }));
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing-empty')).toHaveTextContent(
      'Тарифы ещё не опубликованы',
    );
    expect(screen.queryAllByTestId('tariff-card')).toHaveLength(0);
  });

  it.each(['/cabinet/tariffs', '/cabinet/tariffs/catalog'])(
    'переводит старый кабинетный адрес %s на публичный прайс без входа',
    async (route) => {
      // Раздела «Тарифы» в кабинете больше нет, а закладка осталась: редирект
      // стоит вне `RequireAuth`, поэтому аноним видит прайс, а не экран входа.
      mockFetch(publicRoutes({ status: 200, body: [] }));
      renderApp(route);

      expect(await screen.findByTestId('pricing')).toBeInTheDocument();
      expect(await screen.findByTestId('pricing-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('login-email')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cabinet-page')).not.toBeInTheDocument();
    },
  );

  it('не показывает тарифы без описания как сломанную карточку', async () => {
    mockFetch(publicRoutes({ status: 200, body: [{ ...plan('start'), description: null }] }));
    renderApp('/pricing');

    expect(await screen.findByTestId('tariff-name')).toHaveTextContent('Старт');
    expect(screen.getByTestId('tariff-description')).toHaveTextContent('');
    expect(screen.getByTestId('tariff-price')).toHaveTextContent('4 900 ₽ в месяц');
  });

  it('переживает сбой сети без текста от сервера', async () => {
    // Сеть падает только на прайсе: проверка сессии отвечает штатным 401.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/tariffs')) {
          throw new Error('network down');
        }
        return new Response(JSON.stringify({ detail: 'Требуется авторизация' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    renderApp('/pricing');

    await waitFor(() =>
      expect(screen.getByTestId('pricing-error')).toHaveTextContent('Не удалось загрузить тарифы'),
    );
  });
});

describe('шапка и подвал страницы тарифов', () => {
  it('анониму показывает те же кнопки шапки, что на главной', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByTestId('nav-login')).toBeInTheDocument();
    expect(header.getByTestId('nav-register')).toBeInTheDocument();
    expect(header.queryByTestId('nav-cabinet')).not.toBeInTheDocument();
  });

  it('вошедшему показывает личный кабинет вместо входа', async () => {
    mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(await header.findByTestId('nav-cabinet')).toBeInTheDocument();
    expect(header.queryByTestId('nav-login')).not.toBeInTheDocument();
    expect(header.queryByTestId('nav-register')).not.toBeInTheDocument();
  });

  it('ведёт в кабинет по кнопке «Личный кабинет»', async () => {
    mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-cabinet'));

    expect(await screen.findByTestId('cabinet-page')).toBeInTheDocument();
  });

  it('вошедшему «Купить» открывает окно подтверждения и только по отметке выставляет счёт', async () => {
    const fetchMock = mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    // Кнопка кабинета означает, что сессия уже подтверждена: иначе «Купить»
    // успела бы открыть окно регистрации.
    await screen.findByTestId('nav-cabinet');

    await user.click((await screen.findAllByTestId('tariff-buy'))[0]);

    const dialog = await screen.findByTestId('purchase-confirm');
    expect(within(dialog).getByTestId('purchase-confirm-title')).toHaveTextContent(
      'Покупка тарифа «Старт»',
    );
    // Сумма — из `price_label` карточки: клиент её не считает.
    expect(screen.getByTestId('purchase-confirm-amount')).toHaveTextContent('4 900 ₽ в месяц');
    // Согласие — явное действие: до отметки кнопка погашена, запроса ещё нет.
    expect(screen.getByTestId('purchase-confirm-submit')).toBeDisabled();
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByRole('checkbox'));
    expect(screen.getByTestId('purchase-confirm-submit')).toBeEnabled();
    await user.click(screen.getByTestId('purchase-confirm-submit'));

    expect(await screen.findByTestId('documents-page')).toBeInTheDocument();
    expect(await screen.findByTestId('documents-purchase-success')).toBeInTheDocument();
    expect(screen.getByTestId('document-number')).toHaveTextContent('СЧ-2026-1');
    expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument();

    const post = callsWithMethod(fetchMock, '/api/billing/invoices', 'POST');
    expect(post).toHaveLength(1);
    // Отметка уходит на сервер: без неё тарифный счёт получить нельзя.
    expect(JSON.parse((post[0][1] as RequestInit).body as string)).toEqual({
      tariff_id: plan('start').id,
      offer_accepted: true,
    });
  });

  it('покупает строку выбранного срока, а не месячную по умолчанию', async () => {
    const fetchMock = mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await choosePeriod(user, '12 месяцев');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);
    const dialog = await screen.findByTestId('purchase-confirm');
    expect(screen.getByTestId('purchase-confirm-amount')).toHaveTextContent('47 000 ₽ в год');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByTestId('purchase-confirm-submit'));

    const post = callsWithMethod(fetchMock, '/api/billing/invoices', 'POST');
    expect(JSON.parse((post[0][1] as RequestInit).body as string)).toEqual({
      tariff_id: plan('start', 'year').id,
      offer_accepted: true,
    });
  });

  it('ведёт ссылкой из окна на страницу оферты', async () => {
    mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);

    const link = within(await screen.findByTestId('purchase-confirm')).getByRole('link', {
      name: 'условиями оферты',
    });
    expect(link).toHaveAttribute('href', '/documents/offer');
    // Оферта открывается в новой вкладке: окно с отметкой не теряется.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('закрывает окно по «Отмене» и не выставляет счёт', async () => {
    const fetchMock = mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);

    const dialog = await screen.findByTestId('purchase-confirm');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByTestId('purchase-confirm-cancel'));

    await waitFor(() => expect(screen.queryByTestId('purchase-confirm')).not.toBeInTheDocument());
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(0);
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('закрывает окно по Escape, не выставляя счёт', async () => {
    const fetchMock = mockFetch(signedInRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);
    expect(await screen.findByTestId('purchase-confirm')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('purchase-confirm')).not.toBeInTheDocument());
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(0);
  });

  it('показывает отказ сервера алертом, не объявляя чекбокс оферты невалидным', async () => {
    const fetchMock = mockFetch(
      signedInRoutes(
        { status: 200, body: PLANS },
        {
          status: 409,
          body: { detail: 'Тариф уже оплачен на будущий период' },
        },
      ),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);
    const dialog = await screen.findByTestId('purchase-confirm');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByTestId('purchase-confirm-submit'));

    const error = await screen.findByTestId('purchase-confirm-request-error');
    // Текст показан как есть, а не заменён общим «что-то пошло не так».
    expect(error).toHaveTextContent('Тариф уже оплачен на будущий период');
    // Причина отказа не в галочке: повторная отметка его не исправит, поэтому
    // чекбокс остаётся валидным и не связан с текстом через aria-describedby.
    const checkbox = within(dialog).getByRole('checkbox');
    expect(checkbox).not.toHaveAttribute('aria-invalid');
    expect(checkbox).not.toHaveAttribute('aria-describedby');
    expect(within(dialog).queryByTestId('purchase-confirm-error')).not.toBeInTheDocument();
    // Окно не закрывается, счёт не создан, страница осталась на прайсе.
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(1);
    // Повторить можно: кнопка снова доступна.
    expect(screen.getByTestId('purchase-confirm-submit')).toBeEnabled();
  });

  it('показывает сбой сети алертом, а не ошибкой чекбокса', async () => {
    const handler = signedInRoutes({ status: 200, body: PLANS });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/billing/invoices') && init?.method === 'POST') {
          throw new TypeError('Failed to fetch');
        }
        const { status, body } = handler(String(input), init);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);
    const dialog = await screen.findByTestId('purchase-confirm');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByTestId('purchase-confirm-submit'));

    expect(await screen.findByTestId('purchase-confirm-request-error')).toHaveTextContent(
      'Не удалось выставить счёт',
    );
    const checkbox = within(dialog).getByRole('checkbox');
    expect(checkbox).not.toHaveAttribute('aria-invalid');
    expect(checkbox).not.toHaveAttribute('aria-describedby');
  });

  it('показывает под чекбоксом текст отказа 422 без приставки валидатора', async () => {
    mockFetch(
      signedInRoutes(
        { status: 200, body: PLANS },
        {
          status: 422,
          body: {
            detail: [
              {
                loc: ['body'],
                msg: 'Value error, Отметьте согласие с условиями оферты',
                type: 'value_error',
              },
            ],
          },
        },
      ),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);
    const dialog = await screen.findByTestId('purchase-confirm');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByTestId('purchase-confirm-submit'));

    // Ровно текст макета: клиент снимает pydantic-приставку и путь `body`.
    const error = await screen.findByTestId('purchase-confirm-error');
    expect(error).toHaveTextContent('Отметьте согласие с условиями оферты');
    // Этот отказ — про отметку: чекбокс объявлен невалидным и связан с текстом.
    const checkbox = within(dialog).getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    expect(checkbox).toHaveAttribute('aria-describedby', 'purchase-offer-error');
    // Общего алерта при этом нет: отказ один, и он про галочку.
    expect(screen.queryByTestId('purchase-confirm-request-error')).not.toBeInTheDocument();
  });

  it('показывает отправку в окне и не даёт его закрыть до ответа', async () => {
    const handler = signedInRoutes({ status: 200, body: PLANS });
    // Незавершённый POST: состояние отправки видно до ответа сервера.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/billing/invoices') && init?.method === 'POST') {
          return new Promise<Response>(() => {});
        }
        const { status, body } = handler(String(input), init);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getAllByTestId('tariff-buy')[0]);
    const dialog = await screen.findByTestId('purchase-confirm');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByTestId('purchase-confirm-submit'));

    const submit = screen.getByTestId('purchase-confirm-submit');
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit).toHaveTextContent('Выставляем счёт…');
    // Пока ответ в пути, окно не закрывается: иначе результат запроса потеряется.
    expect(screen.getByTestId('purchase-confirm-cancel')).toBeDisabled();
    expect(screen.getByTestId('purchase-confirm-close')).toBeDisabled();
  });

  it('помечает купленный ярус, показывает срок и предлагает продление', async () => {
    const owned = plan('growth', 'quarter');
    mockFetch(
      signedInRoutes({ status: 200, body: PLANS }, undefined, {
        status: 200,
        body: {
          tariff: owned,
          ends_at: '2026-11-02T12:00:00Z',
          days_left: 5,
          is_expiring: true,
          next: null,
        },
      }),
    );
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    const cards = await screen.findAllByTestId('tariff-card');

    // Пометка стоит на плашке купленного яруса, а не отдельным блоком. Ярус
    // узнаётся по `group_code`: строк с разными сроками у него несколько.
    const growth = cards.find(
      (card) => within(card).queryByTestId('tariff-name')?.textContent === 'Рост',
    );
    if (!growth) throw new Error('нет плашки «Рост»');
    expect(within(growth).getByTestId('tariff-owned')).toHaveTextContent('Куплен');
    expect(within(growth).getByTestId('tariff-term')).toHaveTextContent('Оплачен до 02.11.2026');
    expect(within(growth).getByTestId('tariff-next-start')).toHaveTextContent(
      'На будущий период — с 02.11.2026',
    );
    expect(within(growth).getByTestId('tariff-buy')).toHaveTextContent('Продлить');

    // Куплен только один ярус: остальные остаются с «Купить».
    expect(screen.getAllByTestId('tariff-owned')).toHaveLength(1);
    const others = cards.filter((card) => card !== growth);
    for (const card of others) {
      expect(within(card).getByTestId('tariff-buy')).toHaveTextContent('Купить');
    }
  });

  it('при оплаченном вперёд периоде ведёт продление на его начало', async () => {
    mockFetch(
      signedInRoutes({ status: 200, body: PLANS }, undefined, {
        status: 200,
        body: {
          tariff: plan('growth', 'quarter'),
          ends_at: '2026-11-02T12:00:00Z',
          days_left: 5,
          is_expiring: true,
          next: { tariff: plan('team', 'year'), starts_at: '2026-11-02T12:00:00Z' },
        },
      }),
    );
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await screen.findAllByTestId('tariff-card');

    const growth = screen
      .getAllByTestId('tariff-card')
      .find((card) => within(card).queryByTestId('tariff-name')?.textContent === 'Рост');
    if (!growth) throw new Error('нет плашки «Рост»');
    // Дата начала — `next.starts_at` с сервера, а не пересчёт срока на клиенте.
    expect(within(growth).getByTestId('tariff-next-start')).toHaveTextContent(
      'На будущий период — с 02.11.2026',
    );
  });

  it('не гасит кнопки, пока тариф организации не выбран', async () => {
    mockFetch(signedInRoutes({ status: 200, body: [plan('start')] }));
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await screen.findAllByTestId('tariff-card');

    expect(screen.getByTestId('tariff-buy')).toBeEnabled();
    expect(screen.queryByTestId('tariff-owned')).not.toBeInTheDocument();
  });

  it('анониму не спрашивает тариф организации', async () => {
    const fetchMock = mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    await screen.findAllByTestId('tariff-card');

    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(0);
  });

  it('открывает вход окном на самой странице тарифов', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-login'));

    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toBeInTheDocument();
    // Уводить на главную ради формы незачем: страница остаётся на месте.
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('открывает регистрацию окном и закрывает его по Escape', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-register'));
    expect(await screen.findByTestId('register-email')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('ведёт пунктами меню на разделы главной, а не по самой странице', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByRole('link', { name: 'Кому подходит' })).toHaveAttribute('href', '/#roles');
    expect(header.getByRole('link', { name: 'Возможности' })).toHaveAttribute('href', '/#features');
    expect(header.getByRole('link', { name: 'Как работает' })).toHaveAttribute('href', '/#how');
    expect(header.getByRole('link', { name: 'Интерфейс' })).toHaveAttribute('href', '/#interface');
    // Список один и тот же на всех публичных страницах: на прайсе «Тарифы» тоже есть.
    expect(header.getByRole('link', { name: 'Тарифы' })).toHaveAttribute('href', '/pricing');
    expect(header.getByRole('link', { name: 'Вопросы' })).toHaveAttribute('href', '/#faq');
  });

  it('ведёт ссылками подвала на главную', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    await screen.findByTestId('pricing');

    const productLinks: Array<[string, string]> = [
      ['Возможности', '/#features'],
      ['Интерфейс', '/#interface'],
      ['Отчётность', '/#reports'],
      ['Внедрение', '/#how'],
    ];
    for (const [label, href] of productLinks) {
      const links = screen.getAllByRole('link', { name: label });
      expect(links.map((link) => link.getAttribute('href'))).toContain(href);
    }
    expect(screen.getAllByRole('link', { name: 'Коменданту' })[0]).toHaveAttribute(
      'href',
      '/#roles',
    );
  });

  it('открывает раздел главной по якорю, а не только её верх', async () => {
    // Адрес `/#features` сам по себе раздел не открывает: react-router меняет
    // историю без нативного перехода по якорю, поэтому прокручивает главная.
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(
      within(await screen.findByTestId('site-header')).getByRole('link', { name: 'Возможности' }),
    );

    expect(await screen.findByTestId('landing')).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toHaveAttribute('id', 'features');

    scrollIntoView.mockRestore();
  });
});
