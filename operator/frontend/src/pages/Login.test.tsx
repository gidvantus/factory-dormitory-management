import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Login } from './Login';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

/** Форма входа в настоящем роутере: успех проверяем по подменённой главной. */
function renderLogin(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<p data-testid="home-probe">Пустая страница кабинета</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return network;
}

async function submitPair(username: string, password: string): Promise<void> {
  const user = userEvent.setup();
  if (username !== '') {
    await user.type(screen.getByTestId('operator-login-username'), username);
  }
  if (password !== '') {
    await user.type(screen.getByTestId('operator-login-password'), password);
  }
  await user.click(screen.getByTestId('operator-login-submit'));
}

describe('экран входа кабинета оператора', () => {
  it('успешный вход ведёт на главную кабинета', async () => {
    const network = renderLogin([{ status: 200, body: { username: 'operator' } }]);

    await submitPair('operator', 'change-me');

    expect(await screen.findByTestId('home-probe')).toBeInTheDocument();
    expect(network.fetchMock).toHaveBeenCalledTimes(1);
    const [call] = network.calls;
    expect(call.url).toBe('/api/auth/login');
    expect(call.init.method).toBe('POST');
    // Сессия в httpOnly cookie: без credentials браузер её не отправит.
    expect(call.init.credentials).toBe('include');
    expect(JSON.parse(String(call.init.body))).toEqual({
      username: 'operator',
      password: 'change-me',
    });
  });

  it('401 показывает текст сервера дословно и не стирает введённое', async () => {
    renderLogin([{ status: 401, body: { detail: 'Неверный логин или пароль' } }]);

    await submitPair('operator', 'wrong');

    const error = await screen.findByTestId('operator-login-error');
    expect(error).toHaveTextContent(/^Неверный логин или пароль$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('operator-login-username')).toHaveValue('operator');
    expect(screen.getByTestId('operator-login-password')).toHaveValue('wrong');
    // Отказ сервера касается пары целиком: оба поля помечены как неверные.
    expect(screen.getByTestId('operator-login-username')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('operator-login-password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('home-probe')).not.toBeInTheDocument();
  });

  it('пустые поля не отправляют запрос и подписаны под полями', async () => {
    const network = renderLogin([]);

    await submitPair('', '');

    expect(screen.getByText('Укажите логин')).toBeInTheDocument();
    expect(screen.getByText('Укажите пароль')).toBeInTheDocument();
    expect(screen.getByTestId('operator-login-username')).toHaveAttribute('aria-invalid', 'true');
    expect(network.fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('operator-login-error')).not.toBeInTheDocument();
  });

  it('на отправке кнопка неактивна и говорит «Вход…»', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    renderLogin([() => pending]);

    await submitPair('operator', 'change-me');

    const button = screen.getByTestId('operator-login-submit');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Вход…');
    // Поля не блокируются: введённые значения остаются на месте.
    expect(screen.getByTestId('operator-login-username')).toHaveValue('operator');

    release({ status: 200, body: { username: 'operator' } });
    expect(await screen.findByTestId('home-probe')).toBeInTheDocument();
  });

  it('сеть недоступна — общий текст вместо кода ответа', async () => {
    renderLogin([{ reject: true }]);

    await submitPair('operator', 'change-me');

    const error = await screen.findByTestId('operator-login-error');
    expect(error).toHaveTextContent(/^Не удалось войти\. Попробуйте ещё раз$/);
    // Введённые значения не виноваты: подсветка «неверная пара» — только у 401.
    expect(screen.getByTestId('operator-login-username')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByTestId('operator-login-password')).toHaveAttribute('aria-invalid', 'false');
  });

  it('5xx — тоже общий текст, а не выдуманное «неверный пароль»', async () => {
    renderLogin([{ status: 500, body: { detail: 'Internal Server Error' } }]);

    await submitPair('operator', 'change-me');

    const error = await screen.findByTestId('operator-login-error');
    expect(error).toHaveTextContent(/^Не удалось войти\. Попробуйте ещё раз$/);
    expect(screen.getByTestId('operator-login-username')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByTestId('operator-login-password')).toHaveAttribute('aria-invalid', 'false');
  });

  it('после 401 сетевой сбой снимает подсветку пары', async () => {
    renderLogin([{ status: 401, body: { detail: 'Неверный логин или пароль' } }, { reject: true }]);
    const user = userEvent.setup();

    await submitPair('operator', 'wrong');
    expect(screen.getByTestId('operator-login-username')).toHaveAttribute('aria-invalid', 'true');

    // Повторная отправка не дошла до сервера: держать подсветку «пара неверна»
    // нельзя, иначе оператор меняет верный пароль из-за упавшей сети.
    await user.click(screen.getByTestId('operator-login-submit'));
    await screen.findByText(/^Не удалось войти\. Попробуйте ещё раз$/);

    expect(screen.getByTestId('operator-login-username')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByTestId('operator-login-password')).toHaveAttribute('aria-invalid', 'false');
  });
});
