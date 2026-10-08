import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTIVATION_REQUIRED_DETAIL } from '../auth/activation';
import { callsTo, mockFetch, type MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const TOKEN = 'raw-activation-token-value';
const PROFILE = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: false,
};
const ACTIVATION_INFO = {
  email: PROFILE.email,
  full_name: PROFILE.full_name,
  expires_at: '2026-01-02T00:00:00Z',
};
const EMPTY_DASHBOARD: MockResponse = {
  status: 200,
  body: {
    snapshot_date: null,
    totals: { attendance: null, residents: null },
    dormitories: [],
    clients: [],
    daily: [],
  },
};

const ANONYMOUS: MockResponse = { status: 401, body: { detail: 'Требуется авторизация' } };

function respond(url: string): MockResponse {
  if (url.includes('/api/auth/activate/resend')) {
    return {
      status: 200,
      body: { detail: 'Если такой адрес зарегистрирован, письмо отправлено повторно' },
    };
  }
  if (url.includes(`/api/auth/activate/${TOKEN}`)) {
    return { status: 200, body: ACTIVATION_INFO };
  }
  if (url.includes('/api/auth/activate')) {
    return { status: 200, body: { ...PROFILE, is_active: true } };
  }
  if (url.includes('/api/me')) {
    return ANONYMOUS;
  }
  if (url.includes('/api/dashboard')) {
    return EMPTY_DASHBOARD;
  }
  return { status: 404, body: { detail: 'Не найдено' } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('экран активации без токена', () => {
  it('объясняет, что кабинет открывается по ссылке из письма', async () => {
    mockFetch((url) => respond(url));
    renderApp('/activate');

    expect(await screen.findByTestId('activate-pending')).toHaveTextContent('по ссылке из письма');
    expect(screen.getByTestId('resend-activation')).toHaveTextContent('Отправить письмо ещё раз');
  });

  it('просит email перед повторной отправкой', async () => {
    const fetchMock = mockFetch((url) => respond(url));
    const user = userEvent.setup();
    renderApp('/activate');

    await user.type(await screen.findByTestId('activate-resend-email'), 'не-почта');
    await user.click(screen.getByTestId('resend-activation'));

    expect(await screen.findByTestId('activate-error')).toHaveTextContent('Укажите email');
    expect(callsTo(fetchMock, '/api/auth/activate/resend')).toHaveLength(0);
  });

  it('после повторной отправки показывает одинаковый для любого адреса ответ', async () => {
    const fetchMock = mockFetch((url) => respond(url));
    const user = userEvent.setup();
    renderApp('/activate');

    await user.type(await screen.findByTestId('activate-resend-email'), 'nobody@example.com');
    await user.click(screen.getByTestId('resend-activation'));

    expect(await screen.findByTestId('activate-resend-result')).toHaveTextContent(
      'Если такой адрес зарегистрирован',
    );
    expect(callsTo(fetchMock, '/api/auth/activate/resend')).toHaveLength(1);
  });
});

describe('экран активации по ссылке из письма', () => {
  it('проверяет ссылку и просит новый пароль', async () => {
    mockFetch((url) => respond(url));
    renderApp(`/activate/${TOKEN}`);

    expect(await screen.findByTestId('activate-full-name')).toHaveTextContent(PROFILE.full_name);
    expect(screen.getByTestId('activate-email-value')).toHaveTextContent(PROFILE.email);
    expect(screen.getByTestId('activate-password')).toBeInTheDocument();
    expect(screen.getByTestId('activate-password-confirm')).toBeInTheDocument();
  });

  it('ругается на короткий пароль и на несовпадение', async () => {
    const fetchMock = mockFetch((url) => respond(url));
    const user = userEvent.setup();
    renderApp(`/activate/${TOKEN}`);

    await user.type(await screen.findByTestId('activate-password'), 'short');
    await user.type(screen.getByTestId('activate-password-confirm'), 'short');
    await user.click(screen.getByTestId('activate-submit'));
    expect(await screen.findByTestId('activate-error')).toHaveTextContent('не короче 8 символов');

    await user.clear(screen.getByTestId('activate-password'));
    await user.type(screen.getByTestId('activate-password'), 'new-password-123');
    await user.clear(screen.getByTestId('activate-password-confirm'));
    await user.type(screen.getByTestId('activate-password-confirm'), 'another-password-123');
    await user.click(screen.getByTestId('activate-submit'));
    expect(await screen.findByTestId('activate-error')).toHaveTextContent('не совпадают');
    expect(callsTo(fetchMock, '/api/auth/activate')).toHaveLength(0);
  });

  it('активирует кабинет и открывает его без повторного входа', async () => {
    let activated = false;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/auth/activate') && init?.method === 'POST') {
        activated = true;
        return { status: 200, body: { ...PROFILE, is_active: true } };
      }
      if (url.includes('/api/me')) {
        return { status: 200, body: activated ? { ...PROFILE, is_active: true } : PROFILE };
      }
      return respond(url);
    });
    const user = userEvent.setup();
    renderApp(`/activate/${TOKEN}`);

    await user.type(await screen.findByTestId('activate-password'), 'new-password-123');
    await user.type(screen.getByTestId('activate-password-confirm'), 'new-password-123');
    await user.click(screen.getByTestId('activate-submit'));

    expect(await screen.findByTestId('activate-success')).toBeInTheDocument();
    expect(await screen.findByTestId('cabinet-page', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/auth/activate')).toHaveLength(1);
  });

  it('показывает причину, если ссылка уже использована', async () => {
    mockFetch((url) => {
      if (url.includes('/api/auth/activate/')) {
        return { status: 410, body: { detail: 'Ссылка активации уже использована' } };
      }
      return { status: 401, body: { detail: 'Требуется авторизация' } };
    });
    renderApp(`/activate/${TOKEN}`);

    expect(await screen.findByTestId('activate-error')).toHaveTextContent('уже использована');
    expect(screen.queryByTestId('activate-password')).not.toBeInTheDocument();
  });
});

describe('403 на рабочей ручке', () => {
  it('уводит в кабинет активации вместо «не удалось загрузить»', async () => {
    mockFetch((url) => {
      if (url.includes('/api/me')) {
        return { status: 200, body: { ...PROFILE, is_active: true } };
      }
      if (url.includes('/api/dormitories')) {
        return { status: 403, body: { detail: ACTIVATION_REQUIRED_DETAIL } };
      }
      if (url.includes('/api/report-templates')) {
        return { status: 403, body: { detail: ACTIVATION_REQUIRED_DETAIL } };
      }
      return { status: 200, body: EMPTY_DASHBOARD.body };
    });
    renderApp('/cabinet/dormitories');

    expect(await screen.findByTestId('activate-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('dormitories-page')).not.toBeInTheDocument();
  });
});
