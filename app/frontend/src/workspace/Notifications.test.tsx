import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../test/mockFetch';
import type { MockHandler, MockResponse } from '../test/mockFetch';
import { Notifications } from './Notifications';
import { SolutionsProvider } from './SolutionsProvider';

const SOLUTION = {
  id: 7,
  code: 'telegram_notifications',
  name: 'Уведомления в Telegram',
  description: 'Сообщения о событиях, которые вас касаются',
  amount: '500.00',
  currency: 'RUB',
  period: 'month',
  price_label: '500 ₽ в месяц',
  is_owned: true,
  expires_at: '2026-11-14T10:00:00Z',
};

const TELEGRAM_STATUS: MockResponse = {
  status: 200,
  body: {
    connected: false,
    username: null,
    bot_username: 'DormitoryNotifyBot',
    subscriptions: [],
  },
};

const NOT_FOUND: MockResponse = { status: 404, body: { detail: 'Не найдено' } };

/** Каталог решений и состояние Telegram: остальное — 404. */
function pageRoutes(catalog: MockResponse, telegram: MockResponse = TELEGRAM_STATUS): MockHandler {
  return (url) => {
    if (url.endsWith('/api/solutions')) return catalog;
    if (url.endsWith('/api/telegram/status')) return telegram;
    return NOT_FOUND;
  };
}

function renderNotifications(handler: MockHandler): void {
  mockFetch(handler);
  render(
    <MemoryRouter initialEntries={['/cabinet/notifications']}>
      <SolutionsProvider>
        <Routes>
          <Route path="/cabinet/notifications" element={<Notifications />} />
          <Route path="/cabinet/shop" element={<p>Страница магазина</p>} />
        </Routes>
      </SolutionsProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('раздел «Уведомления»', () => {
  it('показывает карточку Telegram при действующем праве', async () => {
    renderNotifications(pageRoutes({ status: 200, body: { items: [SOLUTION] } }));

    expect(await screen.findByTestId('notifications-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeInTheDocument();
    expect(await screen.findByTestId('telegram-card')).toBeInTheDocument();
    expect(screen.queryByTestId('notifications-no-solution')).not.toBeInTheDocument();
  });

  it('без права показывает «Решение не подключено» и ссылку в магазин', async () => {
    renderNotifications(
      pageRoutes({
        status: 200,
        body: { items: [{ ...SOLUTION, is_owned: false, expires_at: null }] },
      }),
    );

    expect(await screen.findByTestId('notifications-no-solution')).toHaveTextContent(
      'Решение не подключено',
    );
    const link = screen.getByRole('link', { name: 'В магазин улучшений' });
    expect(link).toHaveAttribute('href', '/cabinet/shop');
    // Настройки платной функции без права не показываются вовсе.
    expect(screen.queryByTestId('telegram-card')).not.toBeInTheDocument();
  });

  it('сбой загрузки каталога читается как «права нет», а не как падение страницы', async () => {
    renderNotifications(pageRoutes({ status: 500, body: { detail: 'Ошибка' } }));

    expect(await screen.findByTestId('notifications-no-solution')).toBeInTheDocument();
  });

  it('показывает загрузку, пока каталог не ответил', () => {
    renderNotifications(pageRoutes({ status: 200, body: { items: [SOLUTION] } }));

    expect(screen.getByTestId('notifications-loading')).toBeInTheDocument();
  });
});
