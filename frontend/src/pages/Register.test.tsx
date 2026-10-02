import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const REGISTERED = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  password: 's3cret-generated-password',
  created_at: '2026-01-01T00:00:00Z',
};

function routes(overrides: Record<string, MockResponse> = {}) {
  return (url: string): MockResponse => {
    for (const [path, response] of Object.entries(overrides)) {
      if (url.endsWith(path)) {
        return response;
      }
    }
    return { status: 401, body: { detail: 'Требуется авторизация' } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('страница регистрации', () => {
  it('не отправляет форму и показывает ошибки, если поля пусты', async () => {
    const fetchMock = mockFetch(routes());
    const user = userEvent.setup();
    renderApp('/register');

    await user.click(await screen.findByTestId('register-submit'));

    expect(await screen.findByTestId('register-email-error')).toHaveTextContent('Укажите email');
    expect(screen.getByTestId('register-full-name-error')).toHaveTextContent('Укажите ФИО');
    expect(callsTo(fetchMock, '/api/auth/register')).toHaveLength(0);
  });

  it('ругается на email без собаки', async () => {
    const fetchMock = mockFetch(routes());
    const user = userEvent.setup();
    renderApp('/register');

    await user.type(await screen.findByTestId('register-email'), 'не-почта');
    await user.type(screen.getByTestId('register-full-name'), 'Иванов Иван');
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-email-error')).toHaveTextContent('не email');
    expect(callsTo(fetchMock, '/api/auth/register')).toHaveLength(0);
  });

  it('показывает сгенерированный пароль после успешной регистрации', async () => {
    mockFetch(routes({ '/api/auth/register': { status: 201, body: REGISTERED } }));
    const user = userEvent.setup();
    renderApp('/register');

    await user.type(await screen.findByTestId('register-email'), REGISTERED.email);
    await user.type(screen.getByTestId('register-full-name'), REGISTERED.full_name);
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('generated-password')).toHaveTextContent(REGISTERED.password);
    expect(screen.getByTestId('register-result-email')).toHaveTextContent(REGISTERED.email);
    expect(screen.getByTestId('copy-password')).toBeInTheDocument();
    expect(screen.getByTestId('password-warning')).toHaveTextContent('Сохраните пароль сейчас');
  });

  it('сообщает про занятый email', async () => {
    mockFetch(
      routes({
        '/api/auth/register': { status: 409, body: { detail: 'Пользователь уже существует' } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/register');

    await user.type(await screen.findByTestId('register-email'), REGISTERED.email);
    await user.type(screen.getByTestId('register-full-name'), REGISTERED.full_name);
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-error')).toHaveTextContent('уже зарегистрирован');
    expect(screen.queryByTestId('generated-password')).not.toBeInTheDocument();
  });
});
