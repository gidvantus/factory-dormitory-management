import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch, type MockResponse } from '../test/mockFetch';
import { TelegramNotifications } from './TelegramNotifications';

/** Ответ статуса в неподключённом состоянии: подписка включена по умолчанию. */
const DISCONNECTED = {
  connected: false,
  username: null,
  bot_username: 'DormitoryNotifyBot',
  subscriptions: [{ kind: 'resident_outflow', title: 'Выселение проживающего', is_enabled: true }],
};

const CONNECTED = { ...DISCONNECTED, connected: true, username: 'ivan' };

const PENDING = {
  code: 'код-из-кабинета',
  deep_link: 'https://t.me/DormitoryNotifyBot?start=код-из-кабинета',
  expires_at: '2026-10-13T12:00:00+00:00',
};

/**
 * Ответы `GET /api/telegram/status` по порядку вызовов.
 *
 * Последний элемент повторяется: карточка переспрашивает статус, пока чат не
 * подключён, и тест не должен от этого зависеть. Последовательность нужна там,
 * где состояние меняется по ходу сценария, — например, после отключения.
 */
type StatusAnswers = MockResponse[];

interface MountOptions {
  status?: StatusAnswers;
  /** Перехват остальных маршрутов; вызывается перед ответом по умолчанию. */
  extra?: (url: string, init?: RequestInit) => MockResponse | null;
}

function mountTelegram(options: MountOptions = {}): ReturnType<typeof mockFetch> {
  const answers = options.status ?? [{ status: 200, body: DISCONNECTED }];
  let served = 0;
  const fetchMock = mockFetch((url, init) => {
    const custom = options.extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith('/api/telegram/status')) {
      const response = answers[Math.min(served, answers.length - 1)];
      served += 1;
      return response;
    }
    if (url.endsWith('/api/telegram/connect')) return { status: 200, body: PENDING };
    if (url.endsWith('/api/telegram/disconnect'))
      return { status: 200, body: { connected: false } };
    if (url.endsWith('/api/telegram/subscriptions')) {
      return {
        status: 200,
        body: [{ kind: 'resident_outflow', title: 'Выселение проживающего', is_enabled: false }],
      };
    }
    if (url.endsWith('/api/telegram/test-message')) return { status: 200, body: { queued: true } };
    return { status: 404, body: { detail: 'нет такого маршрута' } };
  });
  render(<TelegramNotifications />);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('карточка уведомлений в Telegram', () => {
  it('в неподключённом состоянии показывает кнопку и подписку', async () => {
    mountTelegram();

    expect(await screen.findByTestId('telegram-card')).toBeInTheDocument();
    expect(await screen.findByTestId('telegram-status')).toHaveTextContent('Не подключено');
    expect(screen.getByTestId('telegram-connect-button')).toBeInTheDocument();
    expect(screen.queryByTestId('telegram-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('telegram-subscription-resident_outflow')).toBeChecked();
    expect(screen.queryByTestId('telegram-disconnect-button')).not.toBeInTheDocument();
  });

  it('после нажатия «Подключить» показывает код и ссылку на бота', async () => {
    const user = userEvent.setup();
    const fetchMock = mountTelegram();
    await user.click(await screen.findByTestId('telegram-connect-button'));

    expect(await screen.findByTestId('telegram-code')).toHaveTextContent('код-из-кабинета');
    const link = screen.getByTestId('telegram-deep-link');
    expect(link).toHaveAttribute('href', PENDING.deep_link);
    // Ссылка открывается в новой вкладке: текущая страница кабинета не теряется.
    expect(link).toHaveAttribute('target', '_blank');
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/api/telegram/connect')),
    ).toBe(true);
  });

  it('в подключённом состоянии показывает имя, отключение и тестовое сообщение', async () => {
    const user = userEvent.setup();
    mountTelegram({ status: [{ status: 200, body: CONNECTED }] });

    expect(await screen.findByTestId('telegram-status')).toHaveTextContent('Подключено: @ivan');
    expect(screen.getByTestId('telegram-disconnect-button')).toBeInTheDocument();
    await user.click(screen.getByTestId('telegram-test-button'));
    expect(await screen.findByTestId('telegram-test-sent')).toHaveTextContent(
      'Тестовое уведомление отправлено.',
    );
  });

  it('переключатель подписки уходит на сервер с кодом вида события', async () => {
    const user = userEvent.setup();
    const fetchMock = mountTelegram({ status: [{ status: 200, body: CONNECTED }] });

    const toggle = await screen.findByTestId('telegram-subscription-resident_outflow');
    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId('telegram-subscription-resident_outflow')).not.toBeChecked(),
    );
    const call = fetchMock.mock.calls.find((item) =>
      String(item[0]).endsWith('/api/telegram/subscriptions'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      kind: 'resident_outflow',
      is_enabled: false,
    });
  });

  it('отключение возвращает карточку в неподключённое состояние', async () => {
    const user = userEvent.setup();
    mountTelegram({
      status: [
        { status: 200, body: CONNECTED },
        { status: 200, body: DISCONNECTED },
      ],
    });

    await user.click(await screen.findByTestId('telegram-disconnect-button'));

    await waitFor(() =>
      expect(screen.getByTestId('telegram-status')).toHaveTextContent('Не подключено'),
    );
    expect(screen.getByTestId('telegram-connect-button')).toBeInTheDocument();
  });

  it('ошибка подключения показывается общим текстом без технических деталей', async () => {
    const user = userEvent.setup();
    mountTelegram({
      extra: (url) =>
        url.endsWith('/api/telegram/connect')
          ? { status: 503, body: { detail: 'Telegram не настроен' } }
          : null,
    });

    await user.click(await screen.findByTestId('telegram-connect-button'));

    expect(await screen.findByTestId('telegram-error')).toHaveTextContent(
      'Не удалось подключить Telegram.',
    );
    expect(screen.queryByText('Telegram не настроен')).not.toBeInTheDocument();
  });
});
