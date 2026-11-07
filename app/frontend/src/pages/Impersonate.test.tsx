import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
