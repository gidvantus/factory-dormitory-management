import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const ANONYMOUS: MockResponse = { status: 401, body: { detail: 'Требуется авторизация' } };
const RECOVERY_SENT: MockResponse = {
  status: 200,
  body: { detail: 'Если такой адрес зарегистрирован, письмо отправлено' },
};

function respond(url: string): MockResponse {
  if (url.includes('/api/auth/password-recovery')) {
    return RECOVERY_SENT;
  }
  return ANONYMOUS;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('экран восстановления пароля', () => {
  it('показывает форму запроса ссылки', async () => {
    mockFetch((url) => respond(url));
    renderApp('/forgot-password');

    expect(await screen.findByTestId('forgot-password')).toHaveTextContent('Восстановление пароля');
    expect(screen.getByTestId('forgot-password-email')).toBeInTheDocument();
    expect(screen.getByTestId('forgot-password-submit')).toHaveTextContent('Отправить ссылку');
  });

  it('просит email и не отправляет запрос с пустым полем', async () => {
    const fetchMock = mockFetch((url) => respond(url));
    const user = userEvent.setup();
    renderApp('/forgot-password');

    await user.click(await screen.findByTestId('forgot-password-submit'));

    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent(
      'Укажите email, на который регистрировались',
    );
    expect(callsTo(fetchMock, '/api/auth/password-recovery')).toHaveLength(0);
  });

  it('не отправляет запрос с невалидным адресом', async () => {
    const fetchMock = mockFetch((url) => respond(url));
    const user = userEvent.setup();
    renderApp('/forgot-password');

    await user.type(await screen.findByTestId('forgot-password-email'), 'не-почта');
    await user.click(screen.getByTestId('forgot-password-submit'));

    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent('Укажите email');
    expect(callsTo(fetchMock, '/api/auth/password-recovery')).toHaveLength(0);
  });

  it('после валидного адреса показывает сообщение об отправке', async () => {
    const fetchMock = mockFetch((url) => respond(url));
    const user = userEvent.setup();
    renderApp('/forgot-password');

    await user.type(await screen.findByTestId('forgot-password-email'), 'worker@example.com');
    await user.click(screen.getByTestId('forgot-password-submit'));

    const result = await screen.findByTestId('forgot-password-result');
    expect(result).toHaveAttribute('role', 'status');
    expect(result).toHaveTextContent('Если такой адрес зарегистрирован, письмо отправлено');
    expect(callsTo(fetchMock, '/api/auth/password-recovery')).toHaveLength(1);
  });

  it('показывает ошибку, если сервер не ответил', async () => {
    mockFetch((url) => {
      if (url.includes('/api/auth/password-recovery')) {
        return { status: 500, body: { detail: 'Внутренняя ошибка' } };
      }
      return ANONYMOUS;
    });
    const user = userEvent.setup();
    renderApp('/forgot-password');

    await user.type(await screen.findByTestId('forgot-password-email'), 'worker@example.com');
    await user.click(screen.getByTestId('forgot-password-submit'));

    const result = await screen.findByTestId('forgot-password-result');
    expect(result).toHaveAttribute('role', 'alert');
    expect(result).toHaveTextContent('Не удалось отправить письмо. Попробуйте ещё раз.');
  });

  it('возвращает ко входу по ссылке', async () => {
    mockFetch((url) => respond(url));
    renderApp('/forgot-password');

    const link = await screen.findByTestId('link-to-login');
    expect(link).toHaveTextContent('Вернуться ко входу');
    expect(link).toHaveAttribute('href', '/login');
  });
});

describe('ссылка на восстановление со экрана входа', () => {
  it('ведёт на /forgot-password', async () => {
    mockFetch((url) => respond(url));
    renderApp('/login');

    const link = await screen.findByTestId('link-to-forgot-password');
    expect(link).toHaveTextContent('Забыли пароль?');
    expect(link).toHaveAttribute('href', '/forgot-password');
  });
});
