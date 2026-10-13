import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../test/mockFetch';
import type { MockHandler, MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

/** Сессия анонимная: документ публичный, 401 от `/api/me` — нормальное состояние. */
const ANONYMOUS: MockResponse = { status: 401, body: { detail: 'Требуется авторизация' } };

const PRIVACY_POLICY = {
  code: 'privacy-policy',
  title: 'Политика конфиденциальности',
  body: 'Первый абзац про данные.\n\nВторой абзац про цели.\n\nТретий абзац про права.',
  updated_at: '2026-05-01T12:00:00+00:00',
};

function publicRoutes(document: MockResponse): MockHandler {
  return (url) => {
    if (url.endsWith('/api/documents/privacy-policy')) return document;
    if (url.endsWith('/api/me')) return ANONYMOUS;
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.document.title = '';
});

describe('публичная страница документа', () => {
  it('открывается без сессии и показывает заголовок и абзацы текста', async () => {
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    renderApp('/documents/privacy-policy');

    expect(await screen.findByTestId('document-page')).toBeInTheDocument();
    expect(screen.getByTestId('document-title')).toHaveTextContent('Политика конфиденциальности');

    const paragraphs = screen.getAllByTestId('document-paragraph');
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toHaveTextContent('Первый абзац про данные.');
    expect(paragraphs[2]).toHaveTextContent('Третий абзац про права.');
  });

  it('ставит заголовок документа в `document.title`', async () => {
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    renderApp('/documents/privacy-policy');

    await screen.findByTestId('document-title');

    expect(document.title).toBe('Политика конфиденциальности — Домовой');
  });

  it('показывает загрузку, пока запрос в пути', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/documents/privacy-policy')
          ? new Promise<Response>(() => {})
          : new Response(JSON.stringify({ detail: 'Требуется авторизация' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
    renderApp('/documents/privacy-policy');

    expect(screen.getByTestId('document-loading')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем документ');
  });

  it('на неизвестный код показывает экран «Документ не найден» со ссылкой на главную', async () => {
    mockFetch(publicRoutes({ status: 404, body: { detail: 'Документ не найден' } }));
    renderApp('/documents/privacy-policy');

    expect(await screen.findByTestId('document-missing')).toHaveTextContent('Документ не найден');
    expect(screen.getByTestId('document-home')).toHaveAttribute('href', '/');
    expect(screen.queryByTestId('document-title')).not.toBeInTheDocument();
  });

  it('на прочие ошибки показывает понятный текст и не выдаёт их за 404', async () => {
    mockFetch(publicRoutes({ status: 500, body: { detail: 'Внутренняя ошибка' } }));
    renderApp('/documents/privacy-policy');

    expect(await screen.findByTestId('document-error')).toHaveTextContent(
      'Не удалось загрузить документ, попробуйте ещё раз',
    );
    expect(screen.queryByTestId('document-missing')).not.toBeInTheDocument();
  });

  it('переживает сбой сети', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/documents/privacy-policy')) {
          throw new Error('network down');
        }
        return new Response(JSON.stringify({ detail: 'Требуется авторизация' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    renderApp('/documents/privacy-policy');

    await waitFor(() =>
      expect(screen.getByTestId('document-error')).toHaveTextContent(
        'Не удалось загрузить документ, попробуйте ещё раз',
      ),
    );
  });

  it('не запрашивает ручки кабинета', async () => {
    const fetchMock = mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    renderApp('/documents/privacy-policy');

    await screen.findByTestId('document-title');

    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => path.includes('/api/documents/'))).toBe(true);
    // Сессия проверяется, чтобы показать шапку; всё остальное — кабинетные ручки.
    expect(paths.filter((path) => !path.includes('/api/me'))).toHaveLength(1);
  });
});

describe('шапка и подвал страницы документа — как на главной', () => {
  it('показывает то же меню разделов, что на главной', async () => {
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    renderApp('/documents/privacy-policy');

    const header = within(await screen.findByTestId('site-header'));

    // Якоря ведут на разделы главной (`/#roles`), а не ищут их на самом документе.
    const anchors: Array<[string, string]> = [
      ['Кому подходит', '/#roles'],
      ['Возможности', '/#features'],
      ['Как работает', '/#how'],
      ['Интерфейс', '/#interface'],
      ['Вопросы', '/#faq'],
    ];
    for (const [label, href] of anchors) {
      expect(header.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
    // «Тарифы» — отдельный адрес, он остаётся на месте.
    expect(header.getByRole('link', { name: 'Тарифы' })).toHaveAttribute('href', '/pricing');
  });

  it('анониму показывает вход и регистрацию, как на главной', async () => {
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    renderApp('/documents/privacy-policy');

    const header = within(await screen.findByTestId('site-header'));

    expect(header.getByTestId('nav-login')).toBeInTheDocument();
    expect(header.getByTestId('nav-register')).toBeInTheDocument();
    expect(header.queryByTestId('nav-cabinet')).not.toBeInTheDocument();
  });

  it('открывает вход окном на самом документе', async () => {
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    const user = userEvent.setup();
    renderApp('/documents/privacy-policy');

    await user.click(await screen.findByTestId('nav-login'));

    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toBeInTheDocument();
    expect(screen.getByTestId('document-page')).toBeInTheDocument();
  });

  it('открывает регистрацию окном и закрывает его по Escape', async () => {
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    const user = userEvent.setup();
    renderApp('/documents/privacy-policy');

    await user.click(await screen.findByTestId('nav-register'));
    expect(await screen.findByTestId('register-email')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('document-page')).toBeInTheDocument();
  });

  it('по пункту меню возвращает на раздел главной', async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    mockFetch(publicRoutes({ status: 200, body: PRIVACY_POLICY }));
    const user = userEvent.setup();
    renderApp('/documents/privacy-policy');

    await user.click(
      within(await screen.findByTestId('site-header')).getByRole('link', { name: 'Возможности' }),
    );

    expect(await screen.findByTestId('landing')).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    scrollIntoView.mockRestore();
  });

  it('подвал ведёт на три документа и повторяет состав подвала главной', async () => {
    mockFetch(() => ANONYMOUS);
    const { container } = renderApp('/documents/privacy-policy');

    await screen.findByTestId('document-page');

    const titles = Array.from(container.querySelectorAll('.footer__grid h3')).map(
      (heading) => heading.textContent,
    );
    expect(titles).toEqual(['Продукт', 'Роли', 'Документы', 'Связь']);
  });
});

describe('колонка «Документы» в подвале', () => {
  it('ведёт на три документа сервиса', async () => {
    mockFetch(() => ANONYMOUS);
    const { container } = renderApp('/');

    await screen.findByTestId('landing');

    // Ссылка «Политика конфиденциальности» есть ещё и в плашке согласия на
    // cookie, поэтому проверяем колонку подвала: по всей странице таких ссылок
    // законно две, а внутри подвала на каждый документ должна быть ровно одна.
    const footer = container.querySelector<HTMLElement>('.footer__grid');
    if (footer === null) {
      throw new Error('Не найден подвал страницы');
    }

    const links: Array<[string, string]> = [
      ['Политика конфиденциальности', '/documents/privacy-policy'],
      ['Правила использования', '/documents/terms-of-use'],
      ['Оферта для организации', '/documents/offer'],
    ];
    for (const [label, href] of links) {
      const found = within(footer).getAllByRole('link', { name: label });
      expect(found).toHaveLength(1);
      expect(found[0]).toHaveAttribute('href', href);
    }
  });

  it('стоит после «Ролей», а «Связь» остаётся последней', async () => {
    mockFetch(() => ANONYMOUS);
    const { container } = renderApp('/');

    await screen.findByTestId('landing');

    const titles = Array.from(container.querySelectorAll('.footer__grid h3')).map(
      (heading) => heading.textContent,
    );
    expect(titles).toEqual(['Продукт', 'Роли', 'Документы', 'Связь']);
  });
});
