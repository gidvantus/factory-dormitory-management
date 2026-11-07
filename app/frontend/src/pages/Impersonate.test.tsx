import { StrictMode } from 'react';

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { SessionProvider } from '../auth/SessionProvider';
import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const TOKEN = 'raw-impersonation-token-value';
const PROFILE = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
};

const ANONYMOUS: MockResponse = { status: 401, body: { detail: 'Требуется авторизация' } };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Ответы для страницы и для кабинета, в который она уводит.
 *
 * `entered` нужен, потому что `/api/me` спрашивают дважды: провайдер сессии при
 * монтировании (ещё аноним) и дочитывание профиля после входа.
 */
function respond(entered: boolean): (url: string) => MockResponse {
  return (url) => {
    if (url.includes('/api/auth/impersonate')) {
      return { status: 200, body: PROFILE };
    }
    if (url.includes('/api/me')) {
      return entered ? { status: 200, body: { ...PROFILE, role: 'owner' } } : ANONYMOUS;
    }
    // Остальные разделы кабинета в этом тесте не проверяются: их отказ экран
    // кабинета переживает сам, а нам важен только факт перехода.
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

describe('страница входа по ссылке кабинета оператора', () => {
  it('предъявляет токен из адреса и открывает кабинет', async () => {
    let entered = false;
    const fetchMock = mockFetch((url) => {
      const response = respond(entered)(url);
      if (url.includes('/api/auth/impersonate')) entered = true;
      return response;
    });
    renderApp(`/su/${TOKEN}`);

    // Сразу после монтирования страница ещё ждёт ответа.
    expect(screen.getByTestId('impersonate-loading')).toHaveTextContent('Входим в кабинет…');
    expect(await screen.findByTestId('cabinet-page', {}, { timeout: 4000 })).toBeInTheDocument();
    // Адреса со токеном на экране больше нет — переход `replace`.
    expect(screen.queryByTestId('impersonate-loading')).not.toBeInTheDocument();

    expect(callsTo(fetchMock, '/api/auth/impersonate')).toHaveLength(1);
    const [call] = callsTo(fetchMock, '/api/auth/impersonate');
    expect(call[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ token: TOKEN });
  });

  it('показывает текст отказа сервера дословно и ведёт на главную', async () => {
    mockFetch((url) => {
      if (url.includes('/api/auth/impersonate')) {
        return { status: 400, body: { detail: 'Ссылка входа недействительна' } };
      }
      return ANONYMOUS;
    });
    renderApp(`/su/${TOKEN}`);

    const error = await screen.findByTestId('impersonate-error');
    expect(error).toHaveTextContent(/^Ссылка входа недействительна$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('impersonate-home')).toHaveAttribute('href', '/');
    expect(screen.queryByTestId('impersonate-loading')).not.toBeInTheDocument();
  });

  it('без сети показывает общий текст и не уводит в кабинет', async () => {
    // Сеть пропала только на ручке входа: проверка сессии отвечает как обычно,
    // иначе провайдер записал бы сетевой сбой в консоль, а не в отказ экрана.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/auth/impersonate')) {
          throw new TypeError('Failed to fetch');
        }
        return new Response(JSON.stringify(ANONYMOUS.body), {
          status: ANONYMOUS.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    renderApp(`/su/${TOKEN}`);

    const error = await screen.findByTestId('impersonate-error');
    expect(error).toHaveTextContent(/^Не удалось войти\. Попробуйте ещё раз$/);
    expect(screen.getByTestId('impersonate-home')).toBeInTheDocument();
  });

  it('поздний ответ проверки сессии не отменяет вход и не уводит на лендинг', async () => {
    // Стартовая проверка сессии отвечает позже входа — так на медленной сети и
    // получалась гонка: `401` от `/api/me` приходил после `setUser` и сбрасывал
    // сессию в `anonymous`, а `RequireAuth` уводила на `/login` — то есть на
    // лендинг, при живой cookie и уже израсходованной ссылке.
    let releaseSession: () => void = () => undefined;
    const sessionCheck = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let sessionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/me')) {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          await sessionCheck;
          return reply(401, { detail: 'Требуется авторизация' });
        }
        // Дочитывание профиля после входа: роль приходит только отсюда.
        return reply(200, { ...PROFILE, role: 'owner' });
      }
      if (url.includes('/api/auth/impersonate')) {
        return reply(200, PROFILE);
      }
      return reply(404, { detail: 'Не найдено' });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp(`/su/${TOKEN}`);

    // Пока сессия не проверена, вход не начинается — иначе его ответ перекрыл
    // бы поздний `401`, и оператор увидел бы лендинг вместо кабинета.
    await waitFor(() => expect(callsTo(fetchMock, '/api/me')).toHaveLength(1));
    expect(callsTo(fetchMock, '/api/auth/impersonate')).toHaveLength(0);

    releaseSession();

    expect(await screen.findByTestId('cabinet-page', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/auth/impersonate')).toHaveLength(1);
    // Кабинет, а не лендинг: `/login` рендерит именно его.
    expect(screen.queryByTestId('landing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('impersonate-loading')).not.toBeInTheDocument();
  });
});

/** Ответ с телом-JSON: в этом тесте часть ответов откладывается, нужен свой helper. */
function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('страница входа в StrictMode', () => {
  it('отправляет вход один раз, несмотря на двойной монтаж эффектов', async () => {
    // `main.tsx` оборачивает приложение в `StrictMode`: эффекты монтируются
    // дважды. Вход не должен уйти дважды и не должен застрять на «Входим…».
    let entered = false;
    const fetchMock = mockFetch((url) => {
      const response = respond(entered)(url);
      if (url.includes('/api/auth/impersonate')) entered = true;
      return response;
    });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/su/${TOKEN}`]}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByTestId('cabinet-page', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/auth/impersonate')).toHaveLength(1);
  });
});
