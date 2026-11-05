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

/**
 * Прайс после #177: ровно две видимые лицензии — на 6 и на 12 месяцев. Ярусов
 * прежней сетки в ответе нет: миграция гасит их флагом `is_visible`.
 */
const LICENSES = [
  {
    id: 101,
    name: 'Домовой · 6 месяцев',
    description: 'Лицензия на 6 месяцев: до 5 сотрудников включено',
    amount: '60000.00',
    currency: 'RUB',
    period: 'half_year',
    unit_label: null,
    position: 1,
    max_members: 5,
    tooltip: 'Место — сотрудник с доступом к кабинету. Проживающие не считаются.',
    group_code: 'license',
    price_label: '60 000 ₽ за 6 месяцев',
  },
  {
    id: 102,
    name: 'Домовой · 12 месяцев',
    description: 'Лицензия на 12 месяцев: до 10 сотрудников включено',
    amount: '100000.00',
    currency: 'RUB',
    period: 'year',
    unit_label: null,
    position: 2,
    max_members: 10,
    tooltip: 'Место — сотрудник с доступом к кабинету. Проживающие не считаются.',
    group_code: 'license',
    price_label: '100 000 ₽ за 12 месяцев',
  },
];

/**
 * Ступени скидки за места — ответ `/api/tariffs/extra-seats`. Цену места считает
 * сервер (`app/seats.py`): 10 мест стоят 1 350 ₽ каждое, 50 — 750 ₽.
 */
const EXTRA_SEATS = {
  base_amount: '1500.00',
  currency: 'RUB',
  max_quantity: 100,
  bands: [
    { from: 1, to: 9, discount_percent: 0, unit_amount: '1500.00' },
    { from: 10, to: 19, discount_percent: 10, unit_amount: '1350.00' },
    { from: 20, to: 29, discount_percent: 20, unit_amount: '1200.00' },
    { from: 30, to: 39, discount_percent: 30, unit_amount: '1050.00' },
    { from: 40, to: 49, discount_percent: 40, unit_amount: '900.00' },
    { from: 50, to: 100, discount_percent: 50, unit_amount: '750.00' },
  ],
};

/** Подписки нет: организация тарифа ещё не покупала. */
const NO_SUBSCRIPTION = {
  tariff: null,
  ends_at: null,
  days_left: 0,
  is_expiring: false,
  next: null,
  member_limit: null,
  extra_seats: 0,
};

/** Счёт «тариф + 5 мест», который сервер возвращает на покупку. */
const INVOICE = {
  id: 1,
  number: 'СЧ-2026-1',
  status: 'new',
  status_label: 'Новый',
  item_kind: 'tariff',
  quantity: null,
  amount: '67500.00',
  currency: 'RUB',
  amount_label: '67 500 ₽',
  tariff_name: 'Домовой · 6 месяцев',
  tariff_period: 'half_year',
  buyer_name: 'ООО «Домовой»',
  buyer_inn: '7701234567',
  buyer_kpp: null,
  buyer_ogrn: null,
  buyer_address: null,
  has_act: false,
  can_manage: true,
  paid_at: null,
  created_at: '2026-01-01T00:00:00Z',
  items: [
    {
      kind: 'tariff',
      name: 'Домовой · 6 месяцев',
      period: 'half_year',
      quantity: null,
      unit_amount: '60000.00',
      amount: '60000.00',
    },
    {
      kind: 'seats',
      name: null,
      period: null,
      quantity: 5,
      unit_amount: '1500.00',
      amount: '7500.00',
    },
  ],
};

/** Сессия анонимная: страница тарифов публичная, 401 от `/api/me` — норма. */
function publicRoutes(
  tariffs: MockResponse = { status: 200, body: LICENSES },
  seats: MockResponse = { status: 200, body: EXTRA_SEATS },
): MockHandler {
  return (url) => {
    if (url.endsWith('/api/tariffs')) return tariffs;
    if (url.endsWith('/api/tariffs/extra-seats')) return seats;
    // Порядок важен: `/api/tariffs/current` не должен попасть в ветку прайса.
    if (url.endsWith('/api/tariffs/current')) return { status: 200, body: NO_SUBSCRIPTION };
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
  purchase?: MockResponse,
  options: { current?: MockResponse; tariffs?: MockResponse; seats?: MockResponse } = {},
): MockHandler {
  return (url, init) => {
    if (url.endsWith('/api/tariffs')) return options.tariffs ?? { status: 200, body: LICENSES };
    if (url.endsWith('/api/tariffs/extra-seats'))
      return options.seats ?? { status: 200, body: EXTRA_SEATS };
    if (url.endsWith('/api/tariffs/current')) {
      return options.current ?? { status: 200, body: NO_SUBSCRIPTION };
    }
    if (url.endsWith('/api/me')) return PROFILE;
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

/** Поле количества мест: у него есть подпись «Дополнительные места». */
function seatsField(): HTMLElement {
  return screen.getByRole('spinbutton', { name: 'Дополнительные места' });
}

/** Вводит количество дополнительных мест. */
async function chooseSeats(user: ReturnType<typeof userEvent.setup>, seats: number): Promise<void> {
  const field = seatsField();
  await user.clear(field);
  await user.type(field, String(seats));
}

/** Открывает окно подтверждения: калькулятор → «Посмотреть заказ». */
async function openOrder(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByTestId('license-buy'));
  return screen.findByTestId('purchase-confirm');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('публичная страница тарифов: две лицензии и места', () => {
  it('доступна без сессии и показывает калькулятор из двух лицензий', async () => {
    mockFetch(publicRoutes());
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing')).toBeInTheDocument();
    expect(await screen.findByTestId('license-calculator')).toBeInTheDocument();
    // Срок — ровно две кнопки: 6 и 12 месяцев, как в прайсе после миграции.
    expect(screen.getByTestId('license-term-half_year')).toBeInTheDocument();
    expect(screen.getByTestId('license-term-year')).toBeInTheDocument();
    expect(screen.getByTestId('license-term-half_year')).toHaveAttribute('aria-pressed', 'true');
    // Цену собирает сервер: лицензия без мест стоит свою прайсовую цену.
    expect(screen.getByTestId('license-total')).toHaveTextContent('60 000 ₽');
    expect(screen.queryByTestId('pricing-empty')).not.toBeInTheDocument();
  });

  it('читает прайс и параметры мест, а тариф организации у анонима не спрашивает', async () => {
    const fetchMock = mockFetch(publicRoutes());
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');

    expect(callsTo(fetchMock, '/api/tariffs')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tariffs/extra-seats')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tariffs/current')).toHaveLength(0);
  });

  it('показывает таблицу ступенек с готовыми ценами сервера', async () => {
    mockFetch(publicRoutes());
    renderApp('/pricing');

    const bands = await screen.findAllByTestId('license-band');
    expect(bands).toHaveLength(6);
    expect(bands[0]).toHaveTextContent('1–9 мест');
    expect(bands[0]).toHaveTextContent('1 500 ₽');
    expect(bands[1]).toHaveTextContent('10–19 мест');
    expect(bands[1]).toHaveTextContent('1 350 ₽');
    expect(bands[5]).toHaveTextContent('750 ₽');
    // Выбрана первая ступень: мест ещё ноль.
    expect(bands[0]).toHaveAttribute('data-used', 'true');
  });

  it('считает сумму из цены лицензии и цены места текущей ступени', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');
    expect(screen.getByTestId('license-seat-unit')).toHaveTextContent('1 500 ₽');
    expect(screen.getByTestId('license-seat-total')).toHaveTextContent('0 ₽');

    await chooseSeats(user, 5);

    // 60 000 ₽ лицензии + 5 × 1 500 ₽ — ровно то, что сервер посчитает в счёте.
    expect(screen.getByTestId('license-total')).toHaveTextContent('67 500 ₽');
    expect(screen.getByTestId('license-seat-total')).toHaveTextContent('7 500 ₽');
    expect(screen.getByTestId('license-seat-unit')).toHaveTextContent('1 500 ₽');
  });

  it('переходит на цену следующей ступени с десятого места', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');
    await chooseSeats(user, 10);

    // Скидка действует на весь набор: 10 мест по 1 350 ₽, а не 9 по 1 500.
    expect(screen.getByTestId('license-seat-unit')).toHaveTextContent('1 350 ₽');
    expect(screen.getByTestId('license-total')).toHaveTextContent('73 500 ₽');
    const bands = screen.getAllByTestId('license-band');
    expect(bands[1]).toHaveAttribute('data-used', 'true');
    expect(bands[0]).toHaveAttribute('data-used', 'false');
  });

  it('переключает срок и берёт цену лицензии из серверной строки', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');
    await user.click(screen.getByTestId('license-term-year'));

    expect(screen.getByTestId('license-term-year')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('license-total')).toHaveTextContent('100 000 ₽');
    expect(screen.getByText(/Сотрудников в лицензии/)).toBeInTheDocument();

    await user.click(screen.getByTestId('license-term-half_year'));
    expect(screen.getByTestId('license-total')).toHaveTextContent('60 000 ₽');
  });

  it('не даёт ввести больше потолка продажи и объясняет предел', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');
    await chooseSeats(user, 101);

    expect(await screen.findByRole('alert')).toHaveTextContent('Введите целое число от 0 до 100');
    expect(seatsField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('license-seat-total')).toHaveTextContent('0 ₽');
  });

  it('не считает отрицательное количество мест', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');
    await chooseSeats(user, -5);

    expect(await screen.findByRole('alert')).toHaveTextContent('Введите целое число от 0 до 100');
    // Сумма остаётся ценой лицензии: неверный ввод не превращается в скидку.
    expect(screen.getByTestId('license-total')).toHaveTextContent('60 000 ₽');
  });

  it('показывает загрузку, пока прайс не пришёл', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/tariffs') || String(input).endsWith('/api/tariffs/extra-seats')
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
          : { status: 200, body: LICENSES };
      }
      if (url.endsWith('/api/tariffs/extra-seats')) return { status: 200, body: EXTRA_SEATS };
      return ANONYMOUS;
    });
    const user = userEvent.setup();
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing-error')).toHaveTextContent(
      'Сервис временно недоступен',
    );

    await user.click(screen.getByTestId('pricing-retry'));

    expect(await screen.findByTestId('license-calculator')).toBeInTheDocument();
    expect(screen.queryByTestId('pricing-error')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tariffs')).toHaveLength(2);
  });

  it('вместо пустого прайса говорит, что тарифы не опубликованы', async () => {
    mockFetch(publicRoutes({ status: 200, body: [] }));
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing-empty')).toHaveTextContent(
      'Тарифы ещё не опубликованы',
    );
    expect(screen.queryByTestId('license-calculator')).not.toBeInTheDocument();
  });

  it('без продажи мест показывает лицензию без счётчика мест', async () => {
    // `404` ручки ступеней — «дополнительные сотрудники не продаются», а не сбой.
    mockFetch(publicRoutes(undefined, { status: 404, body: { detail: 'Не найдено' } }));
    renderApp('/pricing');

    await screen.findByTestId('license-calculator');

    expect(screen.queryByTestId('license-seats')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('license-band')).toHaveLength(0);
    expect(screen.getByTestId('license-total')).toHaveTextContent('60 000 ₽');
  });

  it.each(['/cabinet/tariffs', '/cabinet/tariffs/catalog'])(
    'переводит старый кабинетный адрес %s на публичный прайс без входа',
    async (route) => {
      mockFetch(publicRoutes({ status: 200, body: [] }));
      renderApp(route);

      expect(await screen.findByTestId('pricing')).toBeInTheDocument();
      expect(await screen.findByTestId('pricing-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument();
    },
  );

  it('переживает сбой сети без текста от сервера', async () => {
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
    mockFetch(publicRoutes());
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByTestId('nav-login')).toBeInTheDocument();
    expect(header.getByTestId('nav-register')).toBeInTheDocument();
    expect(header.queryByTestId('nav-cabinet')).not.toBeInTheDocument();
  });

  it('вошедшему показывает личный кабинет и действующую лицензию', async () => {
    mockFetch(
      signedInRoutes(undefined, {
        current: {
          status: 200,
          body: {
            ...NO_SUBSCRIPTION,
            tariff: LICENSES[0],
            ends_at: '2026-11-02T12:00:00Z',
            days_left: 5,
            is_expiring: true,
            member_limit: 5,
          },
        },
      }),
    );
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(await header.findByTestId('nav-cabinet')).toBeInTheDocument();
    expect(await screen.findByTestId('pricing-subscription')).toHaveTextContent(
      'Действующая лицензия: «Домовой · 6 месяцев»',
    );
  });

  it('подставляет срок действующей лицензии, когда подписка пришла позже прайса', async () => {
    // Проверка про гонку: прайс и ступени приходят сразу, а `/api/tariffs/current`
    // стартует только после `/api/me` и отвечает позже — калькулятор к этому
    // моменту уже смонтирован. Отвечаем с задержкой, чтобы порядок был такой же,
    // как в браузере, а не случайный.
    const handler = signedInRoutes(undefined, {
      current: {
        status: 200,
        body: {
          ...NO_SUBSCRIPTION,
          tariff: LICENSES[1],
          ends_at: '2027-01-01T00:00:00Z',
          days_left: 300,
          is_expiring: false,
          member_limit: 10,
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tariffs/current')) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const { status, body } = handler(url, init);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    renderApp('/pricing');

    expect(await screen.findByTestId('license-calculator')).toBeInTheDocument();

    // Без пересоздания калькулятора выбранным остался бы первый срок прайса.
    await waitFor(
      () => expect(screen.getByTestId('license-term-year')).toHaveAttribute('aria-pressed', 'true'),
      { timeout: 2000 },
    );
    expect(screen.getByTestId('license-term-half_year')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('license-total')).toHaveTextContent('100 000 ₽');
  });

  it('открывает вход окном на самой странице тарифов', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-login'));

    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('ведёт пунктами меню на разделы главной, а не по самой странице', async () => {
    mockFetch(publicRoutes());
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByRole('link', { name: 'Кому подходит' })).toHaveAttribute('href', '/#roles');
    expect(header.getByRole('link', { name: 'Тарифы' })).toHaveAttribute('href', '/pricing');
    expect(header.getByRole('link', { name: 'Вопросы' })).toHaveAttribute('href', '/#faq');
  });
});

describe('покупка лицензии с местами', () => {
  it('анониму «Посмотреть заказ» открывает регистрацию, а не окно счёта', async () => {
    mockFetch(publicRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('license-buy'));

    expect(await screen.findByTestId('register-email')).toBeInTheDocument();
    expect(screen.queryByTestId('purchase-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('показывает в окне обе позиции и итог, а счёт выставляет только по отметке оферты', async () => {
    const fetchMock = mockFetch(signedInRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await chooseSeats(user, 5);
    const dialog = await openOrder(user);

    // Заказ — один документ из двух позиций: лицензия и места.
    expect(within(dialog).getByTestId('purchase-confirm-items')).toHaveTextContent(
      'Домовой · 6 месяцев',
    );
    expect(within(dialog).getByTestId('purchase-confirm-items')).toHaveTextContent(
      'Дополнительные места · 5 (1 500 ₽ × 5)',
    );
    expect(within(dialog).getByTestId('purchase-confirm-amount')).toHaveTextContent('67 500 ₽');
    // Согласие — явное действие: до отметки запроса ещё нет.
    expect(within(dialog).getByTestId('license-offer')).not.toBeChecked();
    expect(within(dialog).getByTestId('purchase-confirm-submit')).toBeDisabled();
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByTestId('license-offer'));
    expect(within(dialog).getByTestId('purchase-confirm-submit')).toBeEnabled();
    await user.click(within(dialog).getByTestId('purchase-confirm-submit'));

    // Успех ведёт в «Документы»: там виден выставленный счёт и его состав.
    expect(await screen.findByTestId('documents-page')).toBeInTheDocument();
    expect(await screen.findByTestId('documents-purchase-success')).toBeInTheDocument();
    expect(await screen.findByTestId('documents-items')).toHaveTextContent(
      'Домовой · 6 месяцев + 5 мест',
    );

    const post = callsWithMethod(fetchMock, '/api/billing/invoices', 'POST');
    expect(post).toHaveLength(1);
    // Денег клиент не присылает: только предмет, количество и отметку оферты.
    expect(JSON.parse((post[0][1] as RequestInit).body as string)).toEqual({
      tariff_id: 101,
      seats: 5,
      offer_accepted: true,
    });
  });

  it('покупает только лицензию, когда мест ноль', async () => {
    const fetchMock = mockFetch(signedInRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    const dialog = await openOrder(user);

    expect(within(dialog).getByTestId('purchase-confirm-items')).not.toHaveTextContent(
      'Дополнительные места',
    );
    await user.click(within(dialog).getByTestId('license-offer'));
    await user.click(within(dialog).getByTestId('purchase-confirm-submit'));

    const post = callsWithMethod(fetchMock, '/api/billing/invoices', 'POST');
    expect(JSON.parse((post[0][1] as RequestInit).body as string)).toEqual({
      tariff_id: 101,
      offer_accepted: true,
    });
  });

  it('покупает выбранный срок, а не первый в прайсе', async () => {
    const fetchMock = mockFetch(signedInRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(screen.getByTestId('license-term-year'));
    const dialog = await openOrder(user);
    expect(within(dialog).getByTestId('purchase-confirm-amount')).toHaveTextContent('100 000 ₽');
    await user.click(within(dialog).getByTestId('license-offer'));
    await user.click(within(dialog).getByTestId('purchase-confirm-submit'));

    const post = callsWithMethod(fetchMock, '/api/billing/invoices', 'POST');
    expect(JSON.parse((post[0][1] as RequestInit).body as string)).toEqual({
      tariff_id: 102,
      offer_accepted: true,
    });
  });

  it('показывает отказ сервера дословно и не закрывает окно', async () => {
    const fetchMock = mockFetch(
      signedInRoutes({ status: 409, body: { detail: 'Тариф уже оплачен на будущий период' } }),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    const dialog = await openOrder(user);
    await user.click(within(dialog).getByTestId('license-offer'));
    await user.click(within(dialog).getByTestId('purchase-confirm-submit'));

    const error = await screen.findByTestId('license-error');
    expect(error).toHaveTextContent('Тариф уже оплачен на будущий период');
    // Причина отказа не в галочке: чекбокс остаётся валидным.
    expect(within(dialog).getByTestId('license-offer')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('purchase-confirm')).toBeInTheDocument();
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(1);
  });

  it('показывает текст отказа 422 про оферту под чекбоксом', async () => {
    mockFetch(
      signedInRoutes({
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
      }),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    const dialog = await openOrder(user);
    await user.click(within(dialog).getByTestId('license-offer'));
    await user.click(within(dialog).getByTestId('purchase-confirm-submit'));

    expect(await screen.findByTestId('license-error')).toHaveTextContent(
      'Отметьте согласие с условиями оферты',
    );
    expect(within(dialog).getByTestId('license-offer')).toHaveAttribute('aria-invalid', 'true');
  });

  it('ведёт ссылкой из окна на страницу оферты', async () => {
    mockFetch(signedInRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    const dialog = await openOrder(user);

    const link = within(dialog).getByRole('link', { name: 'условиями оферты' });
    expect(link).toHaveAttribute('href', '/documents/offer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('закрывает окно по «Отмене» и по Escape, не выставляя счёт', async () => {
    const fetchMock = mockFetch(signedInRoutes());
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    let dialog = await openOrder(user);
    await user.click(within(dialog).getByTestId('purchase-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('purchase-confirm')).not.toBeInTheDocument());
    expect(screen.getByTestId('pricing')).toBeInTheDocument();

    dialog = await openOrder(user);
    expect(dialog).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('purchase-confirm')).not.toBeInTheDocument());
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(0);
  });

  it('показывает отправку в окне и не даёт его закрыть до ответа', async () => {
    const handler = signedInRoutes();
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
    const dialog = await openOrder(user);
    await user.click(within(dialog).getByTestId('license-offer'));
    await user.click(within(dialog).getByTestId('purchase-confirm-submit'));

    const submit = screen.getByTestId('purchase-confirm-submit');
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit).toHaveTextContent('Выставляем счёт…');
    expect(screen.getByTestId('purchase-confirm-cancel')).toBeDisabled();
    expect(screen.getByTestId('purchase-confirm-close')).toBeDisabled();
  });
});
