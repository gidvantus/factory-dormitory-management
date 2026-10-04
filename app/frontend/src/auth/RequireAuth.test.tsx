import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const PROFILE = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
};

function sessionRoutes(session: MockResponse, login: MockResponse = session) {
  return (url: string): MockResponse => {
    if (url.endsWith('/api/me')) {
      return session;
    }
    if (url.endsWith('/api/auth/login')) {
      return login;
    }
    return { status: 404, body: { detail: 'Не найдено' } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('защищённый маршрут /cabinet', () => {
  it('без валидной сессии отправляет на /login', async () => {
    mockFetch(sessionRoutes({ status: 401, body: { detail: 'Требуется авторизация' } }));
    renderApp('/cabinet');

    expect(await screen.findByTestId('login-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('cabinet-full-name')).not.toBeInTheDocument();
  });

  it('с валидной сессией показывает ФИО и email', async () => {
    mockFetch(sessionRoutes({ status: 200, body: PROFILE }));
    renderApp('/cabinet');

    expect(await screen.findByTestId('cabinet-full-name')).toHaveTextContent(PROFILE.full_name);
    expect(screen.getByTestId('cabinet-email')).toHaveTextContent(PROFILE.email);
  });

  it('выход сбрасывает доступ и уводит на /login', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/api/auth/logout')) {
        return { status: 204 };
      }
      if (url.endsWith('/api/me')) {
        return { status: 200, body: PROFILE };
      }
      return { status: 404, body: { detail: 'Не найдено' } };
    });
    const user = userEvent.setup();
    renderApp('/cabinet');

    await user.click(await screen.findByTestId('logout-button'));

    expect(await screen.findByTestId('login-submit')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/auth/logout')).toHaveLength(1);
  });
});

describe('страница входа', () => {
  it('после входа уводит в кабинет', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/me')) {
        return { status: 401, body: { detail: 'Требуется авторизация' } };
      }
      if (url.endsWith('/api/auth/login')) {
        return { status: 200, body: PROFILE };
      }
      return { status: 404, body: { detail: 'Не найдено' } };
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(await screen.findByTestId('login-email'), PROFILE.email);
    await user.type(screen.getByTestId('login-password'), 's3cret-generated-password');
    await user.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('cabinet-full-name')).toHaveTextContent(PROFILE.full_name);
  });

  it('на неверный пароль показывает один и тот же текст', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/me')) {
        return { status: 401, body: { detail: 'Требуется авторизация' } };
      }
      if (url.endsWith('/api/auth/login')) {
        return { status: 401, body: { detail: 'Неверный email или пароль' } };
      }
      return { status: 404, body: { detail: 'Не найдено' } };
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(await screen.findByTestId('login-email'), PROFILE.email);
    await user.type(screen.getByTestId('login-password'), 'неверный');
    await user.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('login-error')).toHaveTextContent('Неверный email или пароль');
    expect(screen.queryByTestId('cabinet-full-name')).not.toBeInTheDocument();
  });
});
