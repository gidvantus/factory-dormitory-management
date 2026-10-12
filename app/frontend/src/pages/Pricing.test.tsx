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

/** Сессия анонимная: страница тарифов публичная, 401 от `/api/me` — норма. */
function publicRoutes(tariffs: MockResponse): MockHandler {
  return (url) => {
    if (url.endsWith('/api/tariffs')) return tariffs;
    if (url.endsWith('/api/me')) return ANONYMOUS;
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

/** Та же страница с активной сессией: в шапке должен быть личный кабинет. */
function signedInRoutes(tariffs: MockResponse): MockHandler {
  return (url) => {
    if (url.endsWith('/api/tariffs')) return tariffs;
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/tariffs/current')) return { status: 200, body: { tariff: null } };
    return { status: 404, body: { detail: 'Не найдено' } };
  };
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

  it('ведёт на регистрацию с карточки', async () => {
    mockFetch(publicRoutes({ status: 200, body: [TARIFF] }));
    renderApp('/pricing');

    const start = await screen.findByTestId('tariff-start');

    expect(start).toHaveAttribute('href', '/register');
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
});
