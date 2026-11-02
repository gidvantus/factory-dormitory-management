import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsTo, mockFetch } from '../test/mockFetch';
import type { MockHandler, MockResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';
import styles from './Workspace.module.css';

const PROFILE: MockResponse = {
  status: 200,
  body: {
    email: 'owner@example.com',
    full_name: 'Иванов Иван Иванович',
    created_at: '2026-01-01T00:00:00Z',
    is_active: true,
  },
};

/** Пробный период идёт: раздел «Документы» открыт и без него, но состояние нужно оболочке. */
const TRIAL: MockResponse = {
  status: 200,
  body: {
    ends_at: '2026-02-01T00:00:00Z',
    days_left: 12,
    is_active: true,
    locked: false,
    member_limit: 3,
  },
};

const NOT_FOUND: MockResponse = { status: 404, body: { detail: 'Не найдено' } };

const NEW_INVOICE = {
  id: 1,
  number: 'СЧ-2026-1',
  status: 'new',
  status_label: 'Новый',
  amount: '10000.00',
  currency: 'RUB',
  amount_label: '10 000 ₽ в месяц',
  tariff_name: 'Старт',
  tariff_period: 'month',
  buyer_name: 'ООО «Домовой»',
  buyer_inn: '7701234567',
  buyer_kpp: null,
  buyer_ogrn: null,
  buyer_address: null,
  has_act: false,
  can_manage: true,
  paid_at: null,
  created_at: '2026-01-15T10:00:00Z',
};

const PAID_INVOICE = {
  ...NEW_INVOICE,
  status: 'paid',
  status_label: 'Оплачен',
  has_act: true,
  paid_at: '2026-01-16T10:00:00Z',
};

/** Счёт за решение магазина: в столбце предмета стоит название решения. */
const SOLUTION_INVOICE = {
  ...NEW_INVOICE,
  item_kind: 'solution',
  tariff_name: 'Уведомления в Telegram',
  amount: '500.00',
  amount_label: '500 ₽ в месяц',
};

/** Строка каталога решений: право выдаётся оплатой, но не на этом экране. */
const SOLUTION = {
  id: 7,
  code: 'telegram_notifications',
  name: 'Уведомления в Telegram',
  description: 'Сообщения о событиях, которые вас касаются',
  amount: '500.00',
  currency: 'RUB',
  period: 'month',
  price_label: '500 ₽ в месяц',
  is_owned: false,
  expires_at: null,
};

/** Маршруты кабинета: сессия активна, счета приходят из `/api/billing/invoices`. */
function routes(invoices: MockResponse, patch?: MockResponse): MockHandler {
  return (url, init) => {
    if (url.endsWith('/api/me')) return PROFILE;
    if (url.endsWith('/api/trial')) return TRIAL;
    if (url.endsWith('/api/billing/invoices')) return invoices;
    if (url.includes('/api/billing/invoices/')) {
      if (init?.method === 'PATCH') return patch ?? { status: 200, body: PAID_INVOICE };
      return NOT_FOUND;
    }
    return NOT_FOUND;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('раздел «Документы» в кабинете', () => {
  it('показывает строку счёта с номером, датой, тарифом, суммой и статусом', async () => {
    mockFetch(routes({ status: 200, body: [NEW_INVOICE] }));
    renderApp('/cabinet/documents');

    expect(await screen.findByTestId('documents-page')).toBeInTheDocument();
    expect(await screen.findByTestId('documents-row')).toBeInTheDocument();
    expect(screen.getAllByTestId('documents-row')).toHaveLength(1);
    expect(screen.getByTestId('document-number')).toHaveTextContent('СЧ-2026-1');
    expect(screen.getByTestId('document-date')).not.toBeEmptyDOMElement();
    expect(screen.getByTestId('document-tariff')).toHaveTextContent('Старт');
    // Сумму собирает сервер: строка показывает `amount_label` как есть.
    expect(screen.getByTestId('document-amount')).toHaveTextContent('10 000 ₽ в месяц');
    expect(screen.getByTestId('document-status')).toHaveTextContent('Новый');
    expect(screen.getByTestId('document-status')).toHaveClass(styles['tag--wait']);
    expect(document.title).toBe('Документы — Домовой');
  });

  it('скачивает счёт и акт обычной ссылкой, без fetch', async () => {
    const fetchMock = mockFetch(routes({ status: 200, body: [PAID_INVOICE] }));
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');

    expect(screen.getByTestId('document-download')).toHaveAttribute(
      'href',
      '/api/billing/invoices/1/file',
    );
    expect(screen.getByTestId('document-act')).toHaveAttribute(
      'href',
      '/api/billing/invoices/1/act-file',
    );
    // Файлы открывает браузер переходом по ссылке: запросов за ними быть не должно.
    expect(callsTo(fetchMock, '/api/billing/invoices/1/file')).toHaveLength(0);
    expect(callsTo(fetchMock, '/api/billing/invoices/1/act-file')).toHaveLength(0);
  });

  it('держит действия строки одним столбиком, а не подряд в одной строке', async () => {
    mockFetch(routes({ status: 200, body: [PAID_INVOICE] }));
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');

    // Все действия строки — внутри одного блока: без него ссылки подряд
    // читались одной фразой «Скачать счётСкачать актОтменить».
    const actions = screen.getByTestId('document-actions');
    expect(actions).toHaveClass(styles['document-actions']);
    expect(within(actions).getByTestId('document-download')).toBeInTheDocument();
    expect(within(actions).getByTestId('document-act')).toBeInTheDocument();
    expect(within(actions).getByTestId('document-status-close')).toBeInTheDocument();

    // jsdom не считает CSS модулей: раскладку проверяем по самому файлу правил.
    const css = readFileSync(resolve(process.cwd(), 'src/workspace/Workspace.module.css'), 'utf8');
    const rule = /\.shell \.document-actions \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('flex-direction: column');
  });

  it('не показывает ссылку на акт до оплаты', async () => {
    mockFetch(routes({ status: 200, body: [NEW_INVOICE] }));
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');

    expect(screen.queryByTestId('document-act')).not.toBeInTheDocument();
  });

  it('без счетов показывает пустое состояние', async () => {
    mockFetch(routes({ status: 200, body: [] }));
    renderApp('/cabinet/documents');

    expect(await screen.findByTestId('documents-empty')).toHaveTextContent('Счетов пока нет');
    expect(screen.queryAllByTestId('documents-row')).toHaveLength(0);
  });

  it('показывает загрузку, пока счета не пришли', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/billing/invoices')
          ? new Promise<Response>(() => {})
          : new Response(JSON.stringify(PROFILE.body), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
    renderApp('/cabinet/documents');

    expect(await screen.findByTestId('documents-loading')).toBeInTheDocument();
  });

  it('показывает текст ошибки и повторяет запрос', async () => {
    let attempts = 0;
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/api/me')) return PROFILE;
      if (url.endsWith('/api/trial')) return TRIAL;
      if (url.endsWith('/api/billing/invoices')) {
        attempts += 1;
        return attempts === 1
          ? { status: 500, body: { detail: 'Внутренняя ошибка' } }
          : { status: 200, body: [NEW_INVOICE] };
      }
      return NOT_FOUND;
    });
    const user = userEvent.setup();
    renderApp('/cabinet/documents');

    expect(await screen.findByTestId('documents-error')).toHaveTextContent('Внутренняя ошибка');

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByTestId('documents-row')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/billing/invoices')).toHaveLength(2);
  });

  it('в строке неоплаченного счёта нет кнопки «Оплатить»', async () => {
    // Оплату вносит кабинет оператора: из «Документов» организации `PATCH` не уходит.
    const fetchMock = mockFetch(routes({ status: 200, body: [NEW_INVOICE] }));
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');

    expect(screen.queryByTestId('document-status-paid')).not.toBeInTheDocument();
    expect(screen.getByTestId('document-status-cancel')).toBeInTheDocument();
    expect(
      callsTo(fetchMock, '/api/billing/invoices/1').filter(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toHaveLength(0);
  });

  it('отменяет неоплаченный счёт', async () => {
    const fetchMock = mockFetch(
      routes(
        { status: 200, body: [NEW_INVOICE] },
        {
          status: 200,
          body: { ...NEW_INVOICE, status: 'cancelled', status_label: 'Отменён' },
        },
      ),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');
    await user.click(screen.getByTestId('document-status-cancel'));

    expect(screen.getByTestId('document-status')).toHaveTextContent('Отменён');
    expect(screen.getByTestId('document-status')).toHaveClass(styles['tag--out']);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]).endsWith('/api/billing/invoices/1') &&
          (call[1] as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toBe(true);
  });

  it('показывает отказ сервера при смене статуса', async () => {
    mockFetch(
      routes(
        { status: 200, body: [NEW_INVOICE] },
        {
          status: 409,
          body: { detail: 'Так нельзя изменить статус счёта' },
        },
      ),
    );
    const user = userEvent.setup();
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');
    await user.click(screen.getByTestId('document-status-cancel'));

    expect(await screen.findByTestId('documents-action-error')).toHaveTextContent(
      'Так нельзя изменить статус счёта',
    );
  });

  it('без права правки показывает счета и файлы, но не кнопки статуса', async () => {
    const readOnly = { ...NEW_INVOICE, can_manage: false };
    mockFetch(routes({ status: 200, body: [readOnly] }));
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');

    expect(screen.getByTestId('document-download')).toBeInTheDocument();
    expect(screen.queryByTestId('document-status-cancel')).not.toBeInTheDocument();
  });

  it('закрытие и отмена счёта каталог решений не перечитывают', async () => {
    // Право меняет только оплата: остальные переходы лишний запрос не шлют.
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return PROFILE;
      if (url.endsWith('/api/trial')) return TRIAL;
      if (url.endsWith('/api/solutions')) {
        return { status: 200, body: { items: [SOLUTION] } };
      }
      if (url.endsWith('/api/billing/invoices')) {
        return { status: 200, body: [SOLUTION_INVOICE] };
      }
      if (url.includes('/api/billing/invoices/') && init?.method === 'PATCH') {
        return {
          status: 200,
          body: { ...SOLUTION_INVOICE, status: 'cancelled', status_label: 'Отменён' },
        };
      }
      return NOT_FOUND;
    });
    const user = userEvent.setup();
    renderApp('/cabinet/documents');

    await screen.findByTestId('documents-row');
    await user.click(screen.getByTestId('document-status-cancel'));

    expect(screen.getByTestId('document-status')).toHaveTextContent('Отменён');
    expect(callsTo(fetchMock, '/api/solutions')).toHaveLength(1);
  });
});
