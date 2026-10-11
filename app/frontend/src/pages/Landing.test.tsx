import { screen, waitFor } from '@testing-library/react';
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

  it('открывает форму регистрации в модальном окне с призыва героя', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('hero-register'));

    expect(await screen.findByTestId('auth-modal-title')).toHaveTextContent('Регистрация');
    expect(screen.getByTestId('register-email')).toBeInTheDocument();
    expect(screen.getByTestId('register-full-name')).toBeInTheDocument();
  });

  it('переводит фокус в первое поле окна', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');

    await user.click(await screen.findByTestId('nav-login'));

    expect(await screen.findByTestId('login-email')).toHaveFocus();
  });
});

describe('контент лендинга на главной', () => {
  it('показывает все разделы прототипа', async () => {
    anonymous();
    const { container } = renderApp('/');
    await screen.findByTestId('landing');

    expect(
      screen.getByRole('heading', { name: 'Одна система — три разных рабочих дня' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Всё, что нужно для учёта общежития' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Как это работает' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Понятный экран вместо семи вкладок' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Отчёты, которые не нужно собирать вручную' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Частые вопросы' })).toBeInTheDocument();

    expect(container.querySelectorAll('.card--role')).toHaveLength(3);
    expect(container.querySelectorAll('.card--feature')).toHaveLength(6);
    expect(container.querySelectorAll('.step')).toHaveLength(4);
    expect(container.querySelectorAll('.chart__row')).toHaveLength(5);
    expect(container.querySelectorAll('.faq details')).toHaveLength(5);
  });

  it('показывает макет интерфейса и иллюстрации лендинга', async () => {
    anonymous();
    const { container } = renderApp('/');
    await screen.findByTestId('landing');

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Иванов П. С.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Заполняемость общежитий/ })).toBeInTheDocument();

    // Большие иллюстрации Vite отдаёт файлами, маленькие (аватары, кот, пёс)
    // инлайнит в data-URI — проверяем, что подключены обе группы.
    const sources = Array.from(container.querySelectorAll('img')).map((img) =>
      img.getAttribute('src'),
    );
    expect(sources.some((src) => src?.includes('hero-scene'))).toBe(true);
    expect(sources.some((src) => src?.includes('dorm-house'))).toBe(true);
    expect(
      sources.filter((src) => src?.startsWith('data:image/svg+xml')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('ведёт на публичную страницу тарифов из меню и подвала', async () => {
    anonymous();
    renderApp('/');
    await screen.findByTestId('landing');

    // Ссылка есть дважды: пункт меню в шапке и колонка «Продукт» в подвале.
    const links = screen.getAllByRole('link', { name: 'Тарифы' });
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.every((link) => link.getAttribute('href') === '/pricing')).toBe(true);
  });

  it('открывает регистрацию из финального блока', async () => {
    anonymous();
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByTestId('landing');

    await user.click(screen.getByTestId('cta-register'));

    expect(await screen.findByTestId('register-submit')).toBeInTheDocument();
    expect(screen.getByTestId('auth-modal-title')).toHaveTextContent('Регистрация');
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
