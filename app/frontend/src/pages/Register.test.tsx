import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const REGISTERED = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  activation_email_sent: true,
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

/** Заполнить форму и (по умолчанию) отметить обе обязательные строки — иначе запрос не уходит. */
async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  { consent = true, terms = true }: { consent?: boolean; terms?: boolean } = {},
): Promise<void> {
  await user.type(await screen.findByTestId('register-email'), REGISTERED.email);
  await user.type(screen.getByTestId('register-full-name'), REGISTERED.full_name);
  if (terms) {
    await user.click(screen.getByTestId('register-terms'));
  }
  if (consent) {
    await user.click(screen.getByTestId('register-consent'));
  }
}

describe('страница регистрации', () => {
  it('не отправляет форму и показывает ошибки, если поля пусты', async () => {
    const fetchMock = mockFetch(routes());
    const user = userEvent.setup();
    renderApp('/register');

    await user.click(await screen.findByTestId('register-submit'));

    expect(await screen.findByTestId('register-email-error')).toHaveTextContent('Укажите email');
    expect(screen.getByTestId('register-full-name-error')).toHaveTextContent('Укажите ФИО');
    expect(screen.getByTestId('register-terms-error')).toHaveTextContent(
      'Отметьте принятие правил использования платформой',
    );
    expect(screen.getByTestId('register-consent-error')).toHaveTextContent(
      'Отметьте согласие на обработку персональных данных',
    );
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

  it('после успешной регистрации сообщает про письмо активации', async () => {
    mockFetch(routes({ '/api/auth/register': { status: 201, body: REGISTERED } }));
    const user = userEvent.setup();
    renderApp('/register');

    await fillForm(user);
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-mail-notice')).toHaveTextContent('письмо');
    expect(screen.getByTestId('register-result-email')).toHaveTextContent(REGISTERED.email);
    expect(screen.getByTestId('link-to-activate')).toHaveAttribute('href', '/activate');
    expect(screen.queryByTestId('generated-password')).not.toBeInTheDocument();
    expect(screen.queryByTestId('copy-password')).not.toBeInTheDocument();
    expect(screen.queryByTestId('password-warning')).not.toBeInTheDocument();
  });

  it('предупреждает, если письмо отправить не удалось', async () => {
    mockFetch(
      routes({
        '/api/auth/register': {
          status: 201,
          body: { ...REGISTERED, activation_email_sent: false },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/register');

    await fillForm(user);
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-mail-warning')).toHaveTextContent(
      'Письмо отправить не удалось',
    );
  });

  it('сообщает про занятый email', async () => {
    mockFetch(
      routes({
        '/api/auth/register': { status: 409, body: { detail: 'Пользователь уже существует' } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/register');

    await fillForm(user);
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-error')).toHaveTextContent('уже зарегистрирован');
    expect(screen.queryByTestId('register-mail-notice')).not.toBeInTheDocument();
  });

  it('без согласия не отправляет запрос и показывает ошибку под чекбоксом', async () => {
    const fetchMock = mockFetch(routes());
    const user = userEvent.setup();
    renderApp('/register');

    await fillForm(user, { consent: false });
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-consent-error')).toHaveTextContent(
      'Отметьте согласие на обработку персональных данных',
    );
    // Вторая отметка отмечена — её ошибки нет, и она не блокирует отправку.
    expect(screen.queryByTestId('register-terms-error')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/auth/register')).toHaveLength(0);
  });

  it('без принятия правил не отправляет запрос и показывает ошибку под своим чекбоксом', async () => {
    const fetchMock = mockFetch(routes());
    const user = userEvent.setup();
    renderApp('/register');

    await fillForm(user, { terms: false });
    await user.click(screen.getByTestId('register-submit'));

    expect(await screen.findByTestId('register-terms-error')).toHaveTextContent(
      'Отметьте принятие правил использования платформой',
    );
    expect(screen.queryByTestId('register-consent-error')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/auth/register')).toHaveLength(0);
  });

  it('связывает ошибку каждой отметки со своим чекбоксом', async () => {
    mockFetch(routes());
    const user = userEvent.setup();
    renderApp('/register');

    await user.click(await screen.findByTestId('register-submit'));

    const terms = screen.getByTestId('register-terms');
    expect(terms).toHaveAttribute('aria-invalid', 'true');
    expect(terms).toHaveAttribute('aria-describedby', 'register-terms-error');
    expect(screen.getByTestId('register-terms-error')).toHaveAttribute(
      'id',
      'register-terms-error',
    );

    const consent = screen.getByTestId('register-consent');
    expect(consent).toHaveAttribute('aria-invalid', 'true');
    expect(consent).toHaveAttribute('aria-describedby', 'register-consent-error');
    expect(screen.getByTestId('register-consent-error')).toHaveAttribute(
      'id',
      'register-consent-error',
    );
  });

  it('отправляет обе отметки в теле запроса', async () => {
    const fetchMock = mockFetch(
      routes({ '/api/auth/register': { status: 201, body: REGISTERED } }),
    );
    const user = userEvent.setup();
    renderApp('/register');

    await fillForm(user);
    await user.click(screen.getByTestId('register-submit'));

    await screen.findByTestId('register-mail-notice');
    const [call] = callsTo(fetchMock, '/api/auth/register');
    const init = call[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ consent: true, terms_accepted: true });
  });

  it('ведёт на документы в новой вкладке, чтобы не потерять заполненную форму', async () => {
    mockFetch(routes());
    renderApp('/register');

    const privacy = await screen.findByRole('link', { name: 'Политики конфиденциальности' });
    const consent = screen.getByRole('link', { name: 'согласие на обработку персональных данных' });
    const terms = screen.getByRole('link', { name: 'Правила использования платформой' });

    expect(privacy).toHaveAttribute('href', '/documents/privacy-policy');
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(privacy).toHaveAttribute('rel', 'noreferrer');
    expect(consent).toHaveAttribute('href', '/documents/personal-data-consent');
    expect(consent).toHaveAttribute('target', '_blank');
    expect(consent).toHaveAttribute('rel', 'noreferrer');
    expect(terms).toHaveAttribute('href', '/documents/terms-of-use');
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('rel', 'noreferrer');
  });
});
