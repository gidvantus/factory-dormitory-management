import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Invoices } from './Invoices';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockResponse, MockStep } from '../test/mockFetch';

/** Строка счёта в форме ответа кабинета: поля ровно по контракту постановки. */
function invoice(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    number: 'СЧ-2026-1',
    status: 'new',
    status_label: 'Новый',
    item_kind: 'tariff',
    amount: '5000.00',
    currency: 'RUB',
    amount_label: '5 000 ₽ в месяц',
    tariff_name: 'Общежитие 200 мест',
    tariff_period: '1 месяц',
    buyer_name: 'ООО «Ромашка»',
    buyer_inn: '7701234567',
    buyer_kpp: null,
    buyer_ogrn: null,
    buyer_address: null,
    has_act: false,
    can_manage: true,
    paid_at: null,
    created_at: '2026-11-03T10:00:00',
    organization_id: 7,
    organization_name: 'ООО «Ромашка»',
    ...overrides,
  };
}

const NEW_INVOICE = invoice({ id: 1042, number: 'СЧ-2026-1042' });
const PAID_INVOICE = invoice({
  id: 1039,
  number: 'СЧ-2026-1039',
  status: 'paid',
  status_label: 'Оплачен',
  has_act: true,
  paid_at: '2026-11-02T12:00:00',
  created_at: '2026-11-02T10:00:00',
  organization_name: 'АО «Стройтрест №4»',
  tariff_name: 'Базовый',
  amount_label: '3 200 ₽ в месяц',
});
const CLOSED_INVOICE = invoice({
  id: 1027,
  number: 'СЧ-2026-1027',
  status: 'closed',
  status_label: 'Закрыт',
  has_act: true,
  item_kind: 'solution',
  tariff_name: 'Распознавание документов',
  amount_label: '1 500 ₽ разово',
  created_at: '2026-10-27T10:00:00',
  organization_name: 'ООО «Тёплый дом»',
});
const CANCELLED_INVOICE = invoice({
  id: 1035,
  number: 'СЧ-2026-1035',
  status: 'cancelled',
  status_label: 'Отменён',
  item_kind: 'solution',
  tariff_name: 'Электронный обход',
  amount_label: '900 ₽ разово',
  created_at: '2026-11-01T10:00:00',
  organization_name: 'ИП Кузнецов А. В.',
});

const FIRST_PAGE = {
  items: [NEW_INVOICE, PAID_INVOICE, CLOSED_INVOICE, CANCELLED_INVOICE],
  total: 4,
};

/** Раздел в настоящем роутере: переходы проверяем по подменённым экранам. */
function renderInvoices(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/invoices']}>
        <Routes>
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/users" element={<p data-testid="users-probe">Пользователи</p>} />
          <Route path="/" element={<p data-testid="organizations-probe">Организации</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Строка реестра по номеру счёта: действия проверяются внутри неё. */
function rowByNumber(number: string): HTMLElement {
  const row = screen
    .getAllByTestId('operator-invoice-row')
    .find(
      (element) => within(element).queryByTestId('operator-invoice-number')?.textContent === number,
    );
  if (row === undefined) {
    throw new Error(`Строки счёта ${number} нет в реестре`);
  }
  return row;
}

/** Тела запросов `PATCH`, ушедших на сервер. */
function patchBodies(network: { calls: { url: string; init: RequestInit }[] }): string[] {
  return network.calls
    .filter((call) => call.init.method === 'PATCH')
    .map((call) => String(call.init.body));
}

describe('раздел «Счета» кабинета оператора', () => {
  it('показывает строки, счётчик, предмет, сумму и статус из ответа', async () => {
    const network = renderInvoices([{ status: 200, body: FIRST_PAGE }]);

    expect(await screen.findByTestId('operator-invoices')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-invoice-row')).toHaveLength(4);
    expect(screen.getByText('4 счёта')).toBeInTheDocument();
    expect(screen.getByText('Показано 4 из 4')).toBeInTheDocument();

    const row = rowByNumber('СЧ-2026-1042');
    expect(within(row).getByTestId('operator-invoice-number')).toHaveTextContent('СЧ-2026-1042');
    expect(within(row).getByTestId('operator-invoice-date')).toHaveTextContent('03.11.2026');
    expect(within(row).getByTestId('operator-invoice-organization')).toHaveTextContent(
      'ООО «Ромашка»',
    );
    expect(within(row).getByTestId('operator-invoice-item')).toHaveTextContent(
      'Общежитие 200 мест',
    );
    // Сумму и статус печатает сервер: строки экран не пересобирает.
    expect(within(row).getByTestId('operator-invoice-amount')).toHaveTextContent('5 000 ₽ в месяц');
    expect(within(row).getByTestId('operator-invoice-status')).toHaveTextContent('Новый');
    // Вид предмета назван словом, а не значением из API.
    expect(within(row).getByText('Тариф')).toBeInTheDocument();
    expect(within(rowByNumber('СЧ-2026-1027')).getByText('Решение')).toBeInTheDocument();

    expect(screen.queryByTestId('operator-invoices-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-invoices-more')).not.toBeInTheDocument();

    const [call] = network.calls;
    expect(call.url).toBe('/api/invoices?limit=50&offset=0');
    // Сессия в httpOnly cookie: без credentials браузер её не отправит.
    expect(call.init.credentials).toBe('include');
  });

  it('показывает ровно те действия, которые разрешены статусом и has_act', async () => {
    renderInvoices([{ status: 200, body: FIRST_PAGE }]);
    await screen.findByTestId('operator-invoices');

    // Новый счёт: счёт, «Отменить» и «Оплатить»; акта ещё нет.
    const fresh = rowByNumber('СЧ-2026-1042');
    expect(within(fresh).getByTestId('operator-invoice-download')).toBeInTheDocument();
    expect(within(fresh).getByTestId('operator-invoice-cancel')).toBeInTheDocument();
    expect(within(fresh).getByTestId('operator-invoice-pay')).toBeInTheDocument();
    expect(within(fresh).queryByTestId('operator-invoice-act')).not.toBeInTheDocument();

    // Оплаченный и закрытый: документы без статусных кнопок.
    for (const number of ['СЧ-2026-1039', 'СЧ-2026-1027']) {
      const row = rowByNumber(number);
      expect(within(row).getByTestId('operator-invoice-download')).toBeInTheDocument();
      expect(within(row).getByTestId('operator-invoice-act')).toBeInTheDocument();
      expect(within(row).queryByTestId('operator-invoice-pay')).not.toBeInTheDocument();
      expect(within(row).queryByTestId('operator-invoice-cancel')).not.toBeInTheDocument();
      expect(within(row).queryByTestId('operator-invoice-confirm')).not.toBeInTheDocument();
    }

    // Отменённый — только счёт.
    const cancelled = rowByNumber('СЧ-2026-1035');
    expect(within(cancelled).getByTestId('operator-invoice-download')).toBeInTheDocument();
    expect(within(cancelled).queryByTestId('operator-invoice-act')).not.toBeInTheDocument();
    expect(within(cancelled).queryByTestId('operator-invoice-pay')).not.toBeInTheDocument();
    expect(within(cancelled).queryByTestId('operator-invoice-cancel')).not.toBeInTheDocument();
  });

  it('за файлами уходят обычные ссылки, а не запросы', async () => {
    const network = renderInvoices([{ status: 200, body: FIRST_PAGE }]);
    await screen.findByTestId('operator-invoices');

    const row = rowByNumber('СЧ-2026-1039');
    expect(within(row).getByTestId('operator-invoice-download')).toHaveAttribute(
      'href',
      '/api/invoices/1039/file',
    );
    expect(within(row).getByTestId('operator-invoice-act')).toHaveAttribute(
      'href',
      '/api/invoices/1039/act-file',
    );
    // Никакого `fetch` за файлом: загрузку делает переход по ссылке.
    expect(network.calls).toHaveLength(1);
  });

  it('пока идёт загрузка, показывает строку состояния и не показывает счётчик', () => {
    renderInvoices([
      () =>
        new Promise(() => {
          // Ответ не приходит: проверяем именно состояние загрузки.
        }),
    ]);

    const loading = screen.getByTestId('operator-invoices-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Загружаем счета…');
    expect(screen.queryByTestId('operator-invoices')).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ счёт/)).not.toBeInTheDocument();
    // Фильтры доступны, пока список грузится.
    expect(screen.getByTestId('operator-invoices-search')).toBeInTheDocument();
  });

  it('на пустой платформе показывает «Счетов пока нет»', async () => {
    renderInvoices([{ status: 200, body: { items: [], total: 0 } }]);

    expect(await screen.findByTestId('operator-invoices-empty')).toBeInTheDocument();
    expect(screen.getByText('Счетов пока нет')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ счёт/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-invoices')).not.toBeInTheDocument();
  });

  it('пустой результат фильтра отличается от пустой платформы', async () => {
    const network = renderInvoices([
      { status: 200, body: FIRST_PAGE },
      { status: 200, body: { items: [], total: 0 } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    await user.selectOptions(screen.getByTestId('operator-invoices-status'), 'cancelled');
    await user.type(screen.getByTestId('operator-invoices-search'), 'ромашка');

    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
    expect(
      screen.getByText(
        'По запросу «ромашка» в статусе «Отменён» счетов нет. Поиск идёт по названию организации и ИНН, регистр не важен.',
      ),
    ).toBeInTheDocument();
    // Значения фильтров остаются на месте.
    expect(screen.getByTestId('operator-invoices-search')).toHaveValue('ромашка');
    expect(screen.getByTestId('operator-invoices-status')).toHaveValue('cancelled');

    const filtered = network.calls[network.calls.length - 1];
    expect(decodeURIComponent(filtered.url)).toBe(
      '/api/invoices?limit=50&offset=0&status=cancelled&search=ромашка',
    );
  });

  it('«Сбросить» возвращает список без фильтров', async () => {
    const network = renderInvoices([
      { status: 200, body: FIRST_PAGE },
      { status: 200, body: { items: [NEW_INVOICE], total: 1 } },
      { status: 200, body: FIRST_PAGE },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    await user.selectOptions(screen.getByTestId('operator-invoices-status'), 'new');
    expect(await screen.findByText('1 счёт')).toBeInTheDocument();

    await user.click(screen.getByTestId('operator-invoices-reset'));

    expect(await screen.findByText('4 счёта')).toBeInTheDocument();
    expect(screen.getByTestId('operator-invoices-search')).toHaveValue('');
    expect(screen.getByTestId('operator-invoices-status')).toHaveValue('');
    expect(network.calls[2].url).toBe('/api/invoices?limit=50&offset=0');
  });

  it('отказ загрузки показывает текст detail дословно', async () => {
    renderInvoices([{ status: 502, body: { detail: 'Основной API недоступен' } }]);

    const error = await screen.findByTestId('operator-invoices-error');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('operator-invoices')).not.toBeInTheDocument();
  });

  it('«Показать ещё» дописывает вторую страницу и исчезает на total', async () => {
    const network = renderInvoices([
      { status: 200, body: { items: [NEW_INVOICE, PAID_INVOICE], total: 3 } },
      { status: 200, body: { items: [CANCELLED_INVOICE], total: 3 } },
    ]);
    const user = userEvent.setup();

    const more = await screen.findByTestId('operator-invoices-more');
    expect(screen.getByText('Показано 2 из 3')).toBeInTheDocument();

    await user.click(more);

    expect(await screen.findByText('Показано 3 из 3')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-invoice-row')).toHaveLength(3);
    expect(screen.queryByTestId('operator-invoices-more')).not.toBeInTheDocument();
    expect(network.calls[1].url).toBe('/api/invoices?limit=50&offset=2');
  });

  it('«Оплатить» сама запроса не шлёт: сначала подтверждение, потом ровно один PATCH', async () => {
    const network = renderInvoices([
      { status: 200, body: FIRST_PAGE },
      {
        status: 200,
        body: invoice({
          id: 1042,
          number: 'СЧ-2026-1042',
          status: 'paid',
          status_label: 'Оплачен',
          has_act: true,
        }),
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const row = rowByNumber('СЧ-2026-1042');
    await user.click(within(row).getByTestId('operator-invoice-pay'));

    // Первый клик только спрашивает подтверждение — PATCH ещё не ушёл.
    expect(within(row).getByTestId('operator-invoice-confirm')).toHaveTextContent('Подтвердить');
    expect(within(row).getByTestId('operator-invoice-confirm-decline')).toHaveTextContent(
      'Не надо',
    );
    expect(within(row).queryByTestId('operator-invoice-pay')).not.toBeInTheDocument();
    expect(patchBodies(network)).toHaveLength(0);

    await user.click(within(row).getByTestId('operator-invoice-confirm'));

    // Статусная метка — ровно `status_label` из ответа, кнопки строки вернулись.
    const paid = within(rowByNumber('СЧ-2026-1042'));
    expect(await paid.findByTestId('operator-invoice-act')).toBeInTheDocument();
    expect(paid.getByTestId('operator-invoice-status')).toHaveTextContent('Оплачен');
    expect(paid.queryByTestId('operator-invoice-pay')).not.toBeInTheDocument();

    const patches = network.calls.filter((call) => call.init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe('/api/invoices/1042');
    expect(patches[0].init.body).toBe('{"status":"paid"}');
    // Список не перезагружался: после PATCH всего два запроса.
    expect(network.calls).toHaveLength(2);
  });

  it('«Отменить» отправляет cancelled только после подтверждения', async () => {
    const network = renderInvoices([
      { status: 200, body: FIRST_PAGE },
      {
        status: 200,
        body: invoice({
          id: 1042,
          number: 'СЧ-2026-1042',
          status: 'cancelled',
          status_label: 'Отменён',
        }),
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const row = rowByNumber('СЧ-2026-1042');
    await user.click(within(row).getByTestId('operator-invoice-cancel'));
    expect(patchBodies(network)).toHaveLength(0);

    await user.click(within(row).getByTestId('operator-invoice-confirm'));

    const cancelled = within(rowByNumber('СЧ-2026-1042'));
    expect(cancelled.getByTestId('operator-invoice-status')).toHaveTextContent('Отменён');
    expect(cancelled.queryByTestId('operator-invoice-pay')).not.toBeInTheDocument();
    const patches = network.calls.filter((call) => call.init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].init.body).toBe('{"status":"cancelled"}');
  });

  it('«Не надо» возвращает строку в прежний вид без запроса', async () => {
    const network = renderInvoices([{ status: 200, body: FIRST_PAGE }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const row = rowByNumber('СЧ-2026-1042');
    await user.click(within(row).getByTestId('operator-invoice-pay'));
    await user.click(within(row).getByTestId('operator-invoice-confirm-decline'));

    expect(within(row).getByTestId('operator-invoice-pay')).toBeInTheDocument();
    expect(within(row).queryByTestId('operator-invoice-confirm')).not.toBeInTheDocument();
    expect(patchBodies(network)).toHaveLength(0);
    expect(network.calls).toHaveLength(1);
  });

  it('во время запроса кнопки строки неактивны и помечены aria-busy', async () => {
    const network = renderInvoices([
      { status: 200, body: FIRST_PAGE },
      () =>
        new Promise(() => {
          // Ответ на PATCH не приходит: проверяем состояние отправки.
        }),
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const row = rowByNumber('СЧ-2026-1042');
    await user.click(within(row).getByTestId('operator-invoice-pay'));
    await user.click(within(row).getByTestId('operator-invoice-confirm'));

    const pay = await within(row).findByTestId('operator-invoice-pay');
    expect(pay).toBeDisabled();
    expect(pay).toHaveAttribute('aria-busy', 'true');
    expect(within(row).getByTestId('operator-invoice-cancel')).toBeDisabled();
    // Соседняя строка не блокируется.
    expect(
      within(rowByNumber('СЧ-2026-1039')).getByTestId('operator-invoice-download'),
    ).toHaveAttribute('href', '/api/invoices/1039/file');
    expect(patchBodies(network)).toHaveLength(1);
  });

  it('не блокирует соседние строки: два PATCH уходят независимо', async () => {
    const secondNew = invoice({
      id: 1041,
      number: 'СЧ-2026-1041',
      organization_name: 'ООО «Северный дом»',
      amount_label: '12 400 ₽ за 3 месяца',
    });
    const network = renderInvoices([
      { status: 200, body: { items: [NEW_INVOICE, secondNew], total: 2 } },
      () =>
        new Promise(() => {
          // Ответ по первой строке не приходит: вторая команда не должна ждать.
        }),
      {
        status: 200,
        body: invoice({
          id: 1041,
          number: 'СЧ-2026-1041',
          status: 'cancelled',
          status_label: 'Отменён',
          organization_name: 'ООО «Северный дом»',
        }),
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const first = rowByNumber('СЧ-2026-1042');
    await user.click(within(first).getByTestId('operator-invoice-pay'));
    await user.click(within(first).getByTestId('operator-invoice-confirm'));

    // Первая оплата ещё в работе — вторая строка остаётся живой.
    const second = rowByNumber('СЧ-2026-1041');
    await user.click(within(second).getByTestId('operator-invoice-cancel'));
    await user.click(within(second).getByTestId('operator-invoice-confirm'));

    await waitFor(() => expect(patchBodies(network)).toHaveLength(2));
    expect(patchBodies(network)).toEqual(['{"status":"paid"}', '{"status":"cancelled"}']);
    // Вторая команда дошла до конца, первая всё ещё ждёт своего ответа.
    await waitFor(() =>
      expect(within(second).getByTestId('operator-invoice-status')).toHaveTextContent('Отменён'),
    );
    expect(within(first).getByTestId('operator-invoice-status')).toHaveTextContent('Новый');
    expect(within(first).getByTestId('operator-invoice-pay')).toBeDisabled();
  });

  it('после «Подтвердить» фокус остаётся в строке — до ответа и после', async () => {
    let resolvePatch: (response: MockResponse) => void = () => {};
    const pending = new Promise<MockResponse>((resolve) => {
      resolvePatch = resolve;
    });
    renderInvoices([{ status: 200, body: FIRST_PAGE }, () => pending]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const row = rowByNumber('СЧ-2026-1042');
    await user.click(within(row).getByTestId('operator-invoice-pay'));
    await user.click(within(row).getByTestId('operator-invoice-confirm'));

    // Кнопка «Подтвердить» исчезла из DOM, но фокус остался в этой же строке.
    const download = within(row).getByTestId('operator-invoice-download');
    await waitFor(() => expect(document.activeElement).toBe(download));

    await act(async () => {
      resolvePatch({
        status: 200,
        body: invoice({
          id: 1042,
          number: 'СЧ-2026-1042',
          status: 'paid',
          status_label: 'Оплачен',
          has_act: true,
        }),
      });
      await pending;
    });

    await waitFor(() =>
      expect(within(row).getByTestId('operator-invoice-status')).toHaveTextContent('Оплачен'),
    );
    expect(document.activeElement).toBe(download);
    expect(row).toContainElement(document.activeElement as HTMLElement);
  });

  it('отказ действия показывает detail дословно и не перезагружает список', async () => {
    const network = renderInvoices([
      { status: 200, body: FIRST_PAGE },
      { status: 409, body: { detail: 'Так нельзя изменить статус счёта' } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-invoices');
    const row = rowByNumber('СЧ-2026-1042');
    await user.click(within(row).getByTestId('operator-invoice-pay'));
    await user.click(within(row).getByTestId('operator-invoice-confirm'));

    const error = await screen.findByTestId('operator-invoices-action-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(/^Так нельзя изменить статус счёта$/);
    // Список не перезагружался, статус строки прежний, фильтры на месте.
    expect(network.calls).toHaveLength(2);
    expect(
      within(rowByNumber('СЧ-2026-1042')).getByTestId('operator-invoice-status'),
    ).toHaveTextContent('Новый');
    expect(screen.getByTestId('operator-invoices')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-invoices-error')).not.toBeInTheDocument();
  });

  it('навигация ведёт во все три раздела и помечает текущий', async () => {
    renderInvoices([{ status: 200, body: FIRST_PAGE }]);
    const user = userEvent.setup();

    const invoices = await screen.findByTestId('operator-nav-invoices');
    expect(invoices).toHaveAttribute('aria-current', 'page');
    expect(invoices).toHaveTextContent('Счета');
    const organizations = screen.getByTestId('operator-nav-organizations');
    expect(organizations).not.toHaveAttribute('aria-current');
    expect(organizations).toHaveAttribute('href', '/');
    const users = screen.getByTestId('operator-nav-users');
    expect(users).not.toHaveAttribute('aria-current');
    expect(users).toHaveAttribute('href', '/users');

    await user.click(users);
    expect(await screen.findByTestId('users-probe')).toBeInTheDocument();
  });
});
