import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

/** Главная доступна анонимному пользователю: сессии нет, окна закрыты. */
function anonymous(): void {
  mockFetch(() => ({ status: 401, body: { detail: 'Требуется авторизация' } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('главная страница', () => {
  it('показывает лендинг без модального окна', async () => {
    anonymous();
    renderApp('/');

    expect(await screen.findByTestId('landing')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-submit')).not.toBeInTheDocument();
  });

  it('открывает форму входа в модальном окне по кнопке в шапке', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('nav-login'));

    const dialog = await screen.findByTestId('auth-modal');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('auth-modal-title')).toHaveTextContent('Вход в личный кабинет');
    expect(screen.getByTestId('login-email')).toBeInTheDocument();
    expect(screen.getByTestId('login-password')).toBeInTheDocument();
  });

  it('открывает форму регистрации в модальном окне из шапки', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('nav-register'));

    expect(await screen.findByTestId('auth-modal-title')).toHaveTextContent('Регистрация');
    expect(screen.getByTestId('register-email')).toBeInTheDocument();
    expect(screen.getByTestId('register-full-name')).toBeInTheDocument();
  });

  it('сохраняет иллюстрацию, все разделы и якорное меню полного лендинга', async () => {
    anonymous();
    renderApp('/');

    const landing = await screen.findByTestId('landing');
    expect(landing.querySelector('img')?.getAttribute('src')).toContain('hero-scene.svg');
    for (const title of [
      'Одна система — три разных рабочих дня',
      'Всё, что нужно для учёта общежития',
      'Как это работает',
      'Понятный экран вместо семи вкладок',
      'Отчёты, которые не нужно собирать вручную',
      'Что говорят те, кто ведёт учёт каждый день',
      'Частые вопросы',
      'Покажем Домового на ваших общежитиях',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    const navigation = screen.getByRole('navigation', { name: 'Основная навигация' });
    for (const link of within(navigation).getAllByRole('link')) {
      expect(landing.querySelector(link.getAttribute('href') ?? '')).not.toBeNull();
    }
  });

  it('не убирает разделы и иллюстрации при открытии и закрытии входа', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');
    const originalIllustration = (await screen.findByTestId('landing')).querySelector('img');

    await user.click(screen.getByTestId('nav-login'));
    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(originalIllustration).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument();
    expect(originalIllustration).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Частые вопросы' })).toBeInTheDocument();
  });

  it('проверяет почту в демо-форме и сообщает, что заявка не отправляется', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');

    await user.click(screen.getByRole('button', { name: 'Запросить демо' }));
    const email = screen.getByLabelText('Рабочая почта');
    expect(email).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Укажите рабочую почту');

    await user.type(email, 'worker@example.com');
    await user.click(screen.getByRole('button', { name: 'Запросить демо' }));
    expect(screen.getByRole('status')).toHaveTextContent('заявка никуда не отправлена');
  });

  it('показывает вошедшему пользователю переход в личный кабинет', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        email: 'worker@example.com',
        full_name: 'Иван Иванов',
        created_at: '2026-01-01T00:00:00Z',
      },
    }));
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('nav-cabinet'));
    expect(await screen.findByTestId('workspace-overview')).toBeInTheDocument();
    await user.click(screen.getByTestId('workspace-nav-profile'));
    expect(await screen.findByTestId('cabinet-email')).toHaveTextContent('worker@example.com');
  });

  it('переводит фокус в первое поле окна', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('nav-login'));

    expect(await screen.findByTestId('login-email')).toHaveFocus();
  });
});

describe('адреса /login и /register', () => {
  it('/login сразу открывает окно входа', async () => {
    anonymous();
    renderApp('/login');

    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit')).toBeInTheDocument();
  });

  it('/register сразу открывает окно регистрации', async () => {
    anonymous();
    renderApp('/register');

    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();
    expect(screen.getByTestId('register-submit')).toBeInTheDocument();
  });

  it('из окна входа можно перейти к регистрации', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/login');

    await user.click(await screen.findByTestId('link-to-register'));

    expect(await screen.findByTestId('register-full-name')).toBeInTheDocument();
    expect(screen.queryByTestId('login-email')).not.toBeInTheDocument();
  });
});

describe('закрытие модального окна', () => {
  it('закрывается по Esc и возвращает на главную', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/login');
    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('landing')).toBeInTheDocument();
  });

  it('закрывается кнопкой закрытия', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/register');
    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('auth-modal-close'));

    await waitFor(() => expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument());
  });

  it('закрывается кликом по подложке', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/register');
    expect(await screen.findByTestId('auth-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('auth-modal-backdrop'));

    await waitFor(() => expect(screen.queryByTestId('auth-modal')).not.toBeInTheDocument());
  });
});
