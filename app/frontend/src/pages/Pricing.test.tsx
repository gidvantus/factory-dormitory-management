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

const TARIFF = {
  id: 1,
  name: 'Базовый',
  description: 'Всё основное: реестр, комнаты и отчёты',
  amount: '5000.00',
  currency: 'RUB',
  period: 'month',
  unit_label: null,
  position: 1,
  is_visible: true,
  price_label: '5 000 ₽ в месяц',
};

const SECOND_TARIFF = {
  ...TARIFF,
  id: 2,
  name: 'Годовой',
  description: null,
  amount: '60000.00',
  period: 'year',
  position: 2,
  price_label: '60 000 ₽ в год',
};

/** Прайс владельца: месяц до 10 пользователей, полгода до 15 и год без лимита. */
const PLANS = [
  {
    ...TARIFF,
    name: 'Старт',
    description: 'До 10 пользователей. Реестр проживающих, комнаты и базовые отчёты.',
    amount: '10000.00',
    price_label: '10 000 ₽ в месяц',
  },
  {
    ...TARIFF,
    id: 2,
    name: 'Стандарт',
    description: 'До 15 пользователей. Все разделы, расширенная отчётность и статистика.',
    amount: '50000.00',
    period: 'half_year',
    position: 2,
    price_label: '50 000 ₽ за 6 месяцев',
  },
  {
    ...TARIFF,
    id: 3,
    name: 'Максимум',
    description: 'Без ограничений по пользователям. Все разделы и приоритетная поддержка.',
    amount: '90000.00',
    period: 'year',
    position: 3,
    price_label: '90 000 ₽ в год',
  },
];

/** Счёт, который сервер возвращает на покупку. */
const INVOICE = {
  id: 1,
  number: 'СЧ-2026-1',
  status: 'new',
  status_label: 'Новый',
  amount: '10000.00',
  currency: 'RUB',
  amount_label: '10 000 ₽ в месяц',
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
 * Та же страница с активной сессией: в шапке должен быть личный кабинет.
 *
 * `purchase` — ответ на покупку; без него POST отвечает успехом со счётом, а
 * чтение счетов отдаёт список с тем же счётом: после покупки страница уводит в
 * «Документы», и тем же маршрутом она их и читает.
 */
function signedInRoutes(tariffs: MockResponse, purchase?: MockResponse): MockHandler {
  return (url, init) => {
    if (url.endsWith('/api/tariffs')) return tariffs;
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/billing/invoices')) {
      if (init?.method === 'POST') return purchase ?? { status: 201, body: INVOICE };
      return { status: 200, body: [INVOICE] };
    }
    if (url.endsWith('/api/tariffs/current')) return { status: 200, body: { tariff: null } };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('публичная страница тарифов', () => {
  it('доступна без сессии и показывает карточки из базы', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF, SECOND_TARIFF] }));
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing')).toBeInTheDocument();
    expect(screen.getAllByTestId('tariff-card')).toHaveLength(2);
    expect(screen.getAllByTestId('tariff-name')[0]).toHaveTextContent('Базовый');
    expect(screen.getAllByTestId('tariff-description')[0]).toHaveTextContent(
      'Всё основное: реестр, комнаты и отчёты',
    );
    // Цену собирает сервер: страница показывает `price_label` как есть.
    expect(screen.getAllByTestId('tariff-price')[0]).toHaveTextContent('5 000 ₽ в месяц');
    expect(screen.queryByTestId('pricing-empty')).not.toBeInTheDocument();
  });

  it('читает только публичный список и не запрашивает кабинетный', async () => {
    const fetchMock = mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    renderApp('/pricing');

    await screen.findByTestId('tariff-card');

    expect(callsTo(fetchMock, '/api/tariffs')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tariffs/manage')).toHaveLength(0);
  });

  it('показывает плашки трёх тарифов с ценой и кнопкой «Купить»', async () => {
    mockFetch(publicRoutes({ status: 200, body: PLANS }));
    renderApp('/pricing');

    expect(await screen.findAllByTestId('tariff-card')).toHaveLength(3);
    expect(screen.getAllByTestId('tariff-name').map((node) => node.textContent)).toEqual([
      'Старт',
      'Стандарт',
      'Максимум',
    ]);
    // Цену собирает сервер: страница показывает `price_label` как есть.
    expect(screen.getAllByTestId('tariff-price').map((node) => node.textContent)).toEqual([
      '10 000 ₽ в месяц',
      '50 000 ₽ за 6 месяцев',
      '90 000 ₽ в год',
    ]);
    // Ограничение по пользователям живое: оно есть в описании плашки.
    expect(screen.getAllByTestId('tariff-description')[0]).toHaveTextContent('До 10 пользователей');

    const buy = screen.getAllByTestId('tariff-buy');
    expect(buy).toHaveLength(3);
    expect(buy[0]).toHaveTextContent('Купить');
  });

  it('кнопка «Купить» открывает регистрацию на самой странице', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('tariff-buy'));

    expect(await screen.findByTestId('register-email')).toBeInTheDocument();
    // Уводить на главную ради формы незачем: страница остаётся на месте.
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
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
          : { status: 200, body: [TARIFF] };
      }
      return ANONYMOUS;
    });
    const user = userEvent.setup();
    renderApp('/pricing');

    expect(await screen.findByTestId('pricing-error')).toHaveTextContent(
      'Сервис временно недоступен',
    );

    await user.click(screen.getByTestId('pricing-retry'));

    expect(await screen.findByTestId('tariff-card')).toBeInTheDocument();
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

  it('не показывает тарифы без описания как сломанную карточку', async () => {
    mockFetch(publicRoutes({ status: 200, body: [SECOND_TARIFF] }));
    renderApp('/pricing');

    expect(await screen.findByTestId('tariff-name')).toHaveTextContent('Годовой');
    expect(screen.getByTestId('tariff-description')).toHaveTextContent('');
    expect(screen.getByTestId('tariff-price')).toHaveTextContent('60 000 ₽ в год');
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
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByTestId('nav-login')).toBeInTheDocument();
    expect(header.getByTestId('nav-register')).toBeInTheDocument();
    expect(header.queryByTestId('nav-cabinet')).not.toBeInTheDocument();
  });

  it('вошедшему показывает личный кабинет вместо входа', async () => {
    mockFetch(signedInRoutes({ status: 200, body: [TARIFF] }));
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(await header.findByTestId('nav-cabinet')).toBeInTheDocument();
    expect(header.queryByTestId('nav-login')).not.toBeInTheDocument();
    expect(header.queryByTestId('nav-register')).not.toBeInTheDocument();
  });

  it('ведёт в кабинет по кнопке «Личный кабинет»', async () => {
    mockFetch(signedInRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-cabinet'));

    expect(await screen.findByTestId('cabinet-page')).toBeInTheDocument();
  });

  it('вошедшему кнопка «Купить» выставляет счёт и ведёт в «Документы»', async () => {
    const fetchMock = mockFetch(signedInRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/pricing');

    // Кнопка кабинета означает, что сессия уже подтверждена: иначе «Купить»
    // успела бы открыть окно регистрации.
    await screen.findByTestId('nav-cabinet');

    await user.click(await screen.findByTestId('tariff-buy'));

    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(1);
    expect(await screen.findByTestId('documents-page')).toBeInTheDocument();
    expect(await screen.findByTestId('documents-purchase-success')).toBeInTheDocument();
    expect(screen.getByTestId('document-number')).toHaveTextContent('СЧ-2026-1');
    expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument();
  });

  it('показывает текст отказа сервера и ссылку на раздел «Тариф»', async () => {
    const fetchMock = mockFetch(
      signedInRoutes(
        { status: 200, body: [TARIFF] },
        {
          status: 409,
          body: { detail: 'Тариф организации уже выбран' },
        },
      ),
    );
    const user = userEvent.setup();
    renderApp('/pricing');

    await screen.findByTestId('nav-cabinet');
    await user.click(await screen.findByTestId('tariff-buy'));

    const error = await screen.findByTestId('pricing-buy-error');
    // Текст показан как есть, а не заменён общим «что-то пошло не так».
    expect(error).toHaveTextContent('Тариф организации уже выбран');
    expect(screen.getByTestId('pricing-buy-tariff-link')).toHaveAttribute(
      'href',
      '/cabinet/tariffs',
    );
    // Покупки не было: страница осталась на прайсе.
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
    expect(callsWithMethod(fetchMock, '/api/billing/invoices', 'POST')).toHaveLength(1);
  });

  it('открывает вход окном на самой странице тарифов', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-login'));

    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toBeInTheDocument();
    // Уводить на главную ради формы незачем: страница остаётся на месте.
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('открывает регистрацию окном и закрывает его по Escape', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    const user = userEvent.setup();
    renderApp('/pricing');

    await user.click(await screen.findByTestId('nav-register'));
    expect(await screen.findByTestId('register-email')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('pricing')).toBeInTheDocument();
  });

  it('ведёт пунктами меню на разделы главной, а не по самой странице', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    renderApp('/pricing');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByRole('link', { name: 'Кому подходит' })).toHaveAttribute('href', '/#roles');
    expect(header.getByRole('link', { name: 'Возможности' })).toHaveAttribute('href', '/#features');
    expect(header.getByRole('link', { name: 'Как работает' })).toHaveAttribute('href', '/#how');
    expect(header.getByRole('link', { name: 'Интерфейс' })).toHaveAttribute('href', '/#interface');
    expect(header.getByRole('link', { name: 'Вопросы' })).toHaveAttribute('href', '/#faq');
    // Пользователь уже на прайсе: пункт «Тарифы» здесь лишний.
    expect(header.queryByRole('link', { name: 'Тарифы' })).not.toBeInTheDocument();
  });

  it('ведёт ссылками подвала на главную', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
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
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
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
