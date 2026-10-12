import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrialState } from '../api/client';
import { mockFetch } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const USER = {
  email: 'owner@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
};

const LOCKED: TrialState = {
  ends_at: '2026-10-01T00:00:00Z',
  days_left: 0,
  is_active: false,
  locked: true,
  member_limit: 3,
};

const RUNNING: TrialState = {
  ends_at: '2026-11-01T00:00:00Z',
  days_left: 12,
  is_active: true,
  locked: false,
  member_limit: 3,
};

const EMPTY_DASHBOARD = {
  snapshot_date: '2026-10-04',
  totals: { residents: 0, attendance: 0 },
  dormitories: [],
  clients: [],
  daily: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountOverview(trial: TrialState): ReturnType<typeof vi.fn> {
  const fetchMock = mockFetch((url) => {
    if (url.endsWith('/api/me')) return { status: 200, body: USER };
    if (url.endsWith('/api/trial')) return { status: 200, body: trial };
    if (url.includes('/api/dashboard?')) return { status: 200, body: EMPTY_DASHBOARD };
    return { status: 404, body: { detail: 'Не найдено' } };
  });
  renderApp('/cabinet');
  return fetchMock;
}

describe('сообщение о пробном периоде на обзоре', () => {
  it('на закрытом кабинете показывает заметный блок со ссылкой на тарифы', async () => {
    mountOverview(LOCKED);

    const notice = await screen.findByTestId('trial-expired-notice');
    expect(notice).toHaveTextContent('Пробный период закончился');
    expect(notice).toHaveTextContent('Выберите тариф, чтобы вернуть рабочие разделы');
    expect(notice).toHaveAttribute('role', 'status');

    const link = screen.getByTestId('trial-expired-link');
    expect(link).toHaveAttribute('href', '/cabinet/tariffs');
    expect(link).toHaveTextContent('Выбрать тариф');
    expect(screen.queryByTestId('trial-days-left')).not.toBeInTheDocument();
  });

  it('на идущем периоде показывает остаток дней и дату окончания', async () => {
    mountOverview(RUNNING);

    const note = await screen.findByTestId('trial-days-left');
    expect(note).toHaveTextContent('Пробный период: осталось 12 дней, до 01.11.2026');
    expect(screen.queryByTestId('trial-expired-notice')).not.toBeInTheDocument();
  });

  it('с выбранным тарифом не показывает ничего о пробном периоде', async () => {
    mountOverview({ ...RUNNING, is_active: false, locked: false });

    expect(await screen.findByTestId('workspace-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('trial-expired-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trial-days-left')).not.toBeInTheDocument();
  });

  it('читает состояние отдельной ручкой, а не из профиля', async () => {
    const fetchMock = mountOverview(RUNNING);

    await screen.findByTestId('trial-days-left');

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/trial'))).toBe(true);
  });
});
