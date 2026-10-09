import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const PROFILE = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
};

const INACTIVE_PROFILE = { ...PROFILE, is_active: false };

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

  it('с неактивированным кабинетом отправляет на экран активации', async () => {
    mockFetch(sessionRoutes({ status: 200, body: INACTIVE_PROFILE }));
    renderApp('/cabinet');

    expect(await screen.findByTestId('activate-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-overview')).not.toBeInTheDocument();
  });

  it('на экран активации уводит и прямой заход в раздел кабинета', async () => {
    mockFetch(sessionRoutes({ status: 200, body: INACTIVE_PROFILE }));
    renderApp('/cabinet/dormitories');

    expect(await screen.findByTestId('activate-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('dormitories-page')).not.toBeInTheDocument();
  });

  it('открывает обзор, а реальные личные данные показывает внутри общей оболочки', async () => {
    mockFetch(sessionRoutes({ status: 200, body: PROFILE }));
    const user = userEvent.setup();
    renderApp('/cabinet');

    expect(await screen.findByTestId('workspace-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('cabinet-full-name')).not.toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Боковая панель' });
    expect(screen.getByTestId('workspace-nav-overview')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Проживающие' })).not.toBeInTheDocument();

    await user.click(screen.getByTestId('workspace-nav-profile'));
    expect(screen.getByTestId('cabinet-full-name')).toHaveTextContent(PROFILE.full_name);
    expect(screen.getByTestId('cabinet-email')).toHaveTextContent(PROFILE.email);
    expect(screen.getByTestId('workspace-nav-profile')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('workspace-nav-overview')).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Личные данные', level: 1 })).toHaveFocus();
    expect(screen.getByRole('complementary', { name: 'Боковая панель' })).toBe(sidebar);

    await user.click(screen.getByTestId('workspace-nav-overview'));
    expect(screen.getByTestId('workspace-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('personal-data-page')).not.toBeInTheDocument();
  });

  it('открывает личные данные по прямой ссылке с действующей сессией', async () => {
    mockFetch(sessionRoutes({ status: 200, body: PROFILE }));
    renderApp('/cabinet/profile');

    expect(await screen.findByTestId('cabinet-email')).toHaveTextContent(PROFILE.email);
    expect(screen.queryByTestId('workspace-overview')).not.toBeInTheDocument();
  });

  it('после входа возвращает на запрошенную страницу личных данных', async () => {
    mockFetch(
      sessionRoutes(
        { status: 401, body: { detail: 'Требуется авторизация' } },
        { status: 200, body: PROFILE },
      ),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/profile');

    await user.type(await screen.findByTestId('login-email'), PROFILE.email);
    await user.type(screen.getByTestId('login-password'), 's3cret-generated-password');
    await user.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('cabinet-email')).toHaveTextContent(PROFILE.email);
    expect(screen.queryByTestId('workspace-overview')).not.toBeInTheDocument();
  });

  it('закрывает мобильное меню по Escape и при выборе раздела', async () => {
    mockFetch(sessionRoutes({ status: 200, body: PROFILE }));
    const user = userEvent.setup();
    renderApp('/cabinet');
    const toggle = await screen.findByTestId('workspace-menu-toggle');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('workspace-nav-overview')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    expect(document.body.style.overflow).not.toBe('hidden');

    await user.click(toggle);
    await user.click(screen.getByTestId('workspace-nav-profile'));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('cabinet-email')).toHaveTextContent(PROFILE.email);
    expect(document.body.style.overflow).not.toBe('hidden');
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

  it('при сбое выхода сохраняет сессию и позволяет повторить запрос', async () => {
    let attempts = 0;
    mockFetch((url) => {
      if (url.endsWith('/api/auth/logout')) {
        attempts += 1;
        return attempts === 1
          ? { status: 503, body: { detail: 'Сервис недоступен' } }
          : { status: 204 };
      }
      return { status: 200, body: PROFILE };
    });
    const user = userEvent.setup();
    renderApp('/cabinet/profile');

    await user.click(await screen.findByTestId('logout-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось выйти из аккаунта');
    expect(screen.getByTestId('cabinet-email')).toHaveTextContent(PROFILE.email);
    expect(screen.getByTestId('logout-button')).toBeEnabled();
    await user.click(screen.getByTestId('logout-button'));
    expect(await screen.findByTestId('login-submit')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });
});

describe('страница входа', () => {
  it('после обычного входа открывает обзор рабочего пространства', async () => {
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

    expect(await screen.findByTestId('workspace-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('personal-data-page')).not.toBeInTheDocument();
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
