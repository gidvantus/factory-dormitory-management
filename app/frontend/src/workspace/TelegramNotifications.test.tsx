import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch, type MockResponse } from '../test/mockFetch';
import {
  TELEGRAM_CODE_EXPIRED_TEXT,
  TELEGRAM_ERROR_TEXT,
  TELEGRAM_TEST_SENT_TEXT,
  TelegramNotifications,
} from './TelegramNotifications';

/** Ответ статуса в неподключённом состоянии: подписка включена по умолчанию. */
const DISCONNECTED = {
  connected: false,
  username: null,
  bot_username: 'DormitoryNotifyBot',
  subscriptions: [{ kind: 'resident_outflow', title: 'Выселение проживающего', is_enabled: true }],
};

const CONNECTED = { ...DISCONNECTED, connected: true, username: 'ivan' };

/**
 * Срок действия в фикстурах считается от текущего момента, а не берётся датой из
 * литерала: иначе тест «код действует» через полгода молча превратился бы в тест
 * «код истёк».
 */
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Код выдан: срок ещё не вышел. */
const PENDING = {
  code: 'код-из-кабинета',
  deep_link: 'https://t.me/DormitoryNotifyBot?start=код-из-кабинета',
  expires_at: new Date(Date.now() + TEN_MINUTES_MS).toISOString(),
};

/** Код выдан, но срок уже вышел. */
const PENDING_EXPIRED = {
  ...PENDING,
  code: 'просроченный-код',
  expires_at: new Date(Date.now() - TEN_MINUTES_MS).toISOString(),
};

/** Второй код: его выдаёт сервер после «Получить новый код». */
const PENDING_RENEWED = {
  ...PENDING,
  code: 'код-второй',
  deep_link: 'https://t.me/DormitoryNotifyBot?start=код-второй',
};

/**
 * Ответы `GET /api/telegram/status` по порядку вызовов.
 *
 * Последний элемент повторяется: карточка переспрашивает статус, пока чат не
 * подключён, и тест не должен от этого зависеть. Последовательность нужна там,
 * где состояние меняется по ходу сценария, — например, после отключения.
 */
type StatusAnswers = MockResponse[];
type ConnectAnswers = MockResponse[];

interface MountOptions {
  status?: StatusAnswers;
  /** Ответы `POST /api/telegram/connect` по порядку вызовов. */
  connect?: ConnectAnswers;
  /** Перехват остальных маршрутов; вызывается перед ответом по умолчанию. */
  extra?: (url: string, init?: RequestInit) => MockResponse | null;
}

/** Подсчёт вызовов маршрута: по нему видно, что кнопка действительно сходила на сервер. */
function countCalls(fetchMock: ReturnType<typeof mockFetch>, path: string): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(path)).length;
}

function mountTelegram(options: MountOptions = {}): ReturnType<typeof mockFetch> {
  const answers = options.status ?? [{ status: 200, body: DISCONNECTED }];
  const connectAnswers = options.connect ?? [{ status: 200, body: PENDING }];
  let served = 0;
  let connected = 0;
  const fetchMock = mockFetch((url, init) => {
    const custom = options.extra?.(url, init);
    if (custom) return custom;
    if (url.endsWith('/api/telegram/status')) {
      const response = answers[Math.min(served, answers.length - 1)];
      served += 1;
      return response;
    }
    if (url.endsWith('/api/telegram/connect')) {
      const response = connectAnswers[Math.min(connected, connectAnswers.length - 1)];
      connected += 1;
      return response;
    }
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

/** Открыть карточку в состоянии «код выдан»: нажать «Подключить Telegram». */
async function issueCode(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('telegram-connect-button'));
  await screen.findByTestId('telegram-steps');
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
    expect(screen.queryByTestId('telegram-steps')).not.toBeInTheDocument();
    expect(screen.getByTestId('telegram-subscription-resident_outflow')).toBeChecked();
    expect(screen.queryByTestId('telegram-disconnect-button')).not.toBeInTheDocument();
  });

  it('после нажатия «Подключить» показывает код и ссылку на бота', async () => {
    const fetchMock = mountTelegram();
    await issueCode();

    expect(screen.getByTestId('telegram-code')).toHaveTextContent('код-из-кабинета');
    const link = screen.getByTestId('telegram-deep-link');
    expect(link).toHaveAttribute('href', PENDING.deep_link);
    // Ссылка открывается в новой вкладке: текущая страница кабинета не теряется.
    expect(link).toHaveAttribute('target', '_blank');
    expect(countCalls(fetchMock, '/api/telegram/connect')).toBe(1);
  });

  it('в состоянии «код выдан» показывает четыре шага с именем бота', async () => {
    mountTelegram();
    await issueCode();

    const steps = screen.getByTestId('telegram-steps');
    // Настоящий `ol`: номера шагов — часть смысла инструкции.
    expect(steps.tagName).toBe('OL');
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Откройте Telegram.');
    expect(items[1]).toHaveTextContent(/найдите\s+@DormitoryNotifyBot\s+и откройте этого бота/);
    expect(items[2]).toHaveTextContent('Нажмите «Start» (в русском интерфейсе — «Запустить»).');
    expect(items[3]).toHaveTextContent('/start');
    expect(items[3]).toHaveTextContent('код из полосы ниже');

    // Имя бота пришло из ответа сервера, а не зашито в компонент.
    expect(screen.getByTestId('telegram-bot-username')).toHaveTextContent('@DormitoryNotifyBot');
    // Шаги — основной путь: фразы «отправьте боту» без имени бота на экране нет.
    expect(screen.getByTestId('telegram-card')).not.toHaveTextContent(/отправьте боту/i);
  });

  it('показывает срок действия кода в локальном времени', async () => {
    mountTelegram();
    await issueCode();

    const localTime = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(PENDING.expires_at));
    expect(screen.getByTestId('telegram-code-expiry')).toHaveTextContent(
      `Код действует до ${localTime}`,
    );
    expect(screen.getByTestId('telegram-copy-button')).toBeEnabled();
  });

  it('истёкший код: строка «Код истёк» и «Получить новый код» остаётся доступной', async () => {
    mountTelegram({ connect: [{ status: 200, body: PENDING_EXPIRED }] });
    await issueCode();

    expect(screen.getByTestId('telegram-code-expiry')).toHaveTextContent(
      TELEGRAM_CODE_EXPIRED_TEXT,
    );
    expect(screen.getByTestId('telegram-code')).toHaveTextContent('просроченный-код');
    const renew = screen.getByTestId('telegram-renew-button');
    expect(renew).toBeEnabled();
    // Мёртвый код не предлагаем отправить.
    expect(screen.getByTestId('telegram-copy-button')).toBeDisabled();
    expect(screen.getByTestId('telegram-deep-link')).toHaveAttribute('aria-disabled', 'true');
  });

  it('«Получить новый код» просит у сервера второй код и заменяет карточку', async () => {
    const user = userEvent.setup();
    const fetchMock = mountTelegram({
      connect: [
        { status: 200, body: PENDING_EXPIRED },
        { status: 200, body: PENDING_RENEWED },
      ],
    });
    await issueCode();

    await user.click(screen.getByTestId('telegram-renew-button'));

    await screen.findByText('код-второй');
    expect(screen.getByTestId('telegram-code')).toHaveTextContent('код-второй');
    // Новый код вместо истёкшего: срок снова действует, подсказка об истечении ушла.
    expect(screen.getByTestId('telegram-code-expiry')).toHaveTextContent('Код действует до');
    expect(screen.getByTestId('telegram-code-expiry')).not.toHaveTextContent(
      TELEGRAM_CODE_EXPIRED_TEXT,
    );
    expect(countCalls(fetchMock, '/api/telegram/connect')).toBe(2);
    // Старый код сервер не аннулирует — карточка об этом и не обещает.
    expect(screen.getByTestId('telegram-card')).not.toHaveTextContent(/аннулир|недействит/i);
  });

  it('в подключённом состоянии показывает имя, отключение и тестовое сообщение', async () => {
    const user = userEvent.setup();
    mountTelegram({ status: [{ status: 200, body: CONNECTED }] });

    expect(await screen.findByTestId('telegram-status')).toHaveTextContent('Подключено: @ivan');
    expect(screen.getByTestId('telegram-disconnect-button')).toBeInTheDocument();
    await user.click(screen.getByTestId('telegram-test-button'));
    expect(await screen.findByTestId('telegram-test-sent')).toHaveTextContent(
      TELEGRAM_TEST_SENT_TEXT,
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

    expect(await screen.findByTestId('telegram-status')).toHaveTextContent('Не подключено');
    expect(await screen.findByTestId('telegram-connect-button')).toBeInTheDocument();
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

    expect(await screen.findByTestId('telegram-error')).toHaveTextContent(TELEGRAM_ERROR_TEXT);
    expect(screen.queryByText('Telegram не настроен')).not.toBeInTheDocument();
  });
});
