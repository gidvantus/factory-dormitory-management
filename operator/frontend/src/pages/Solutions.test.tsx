import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Solutions } from './Solutions';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

/** Строка каталога в форме ответа кабинета: поля ровно по контракту постановки. */
function solution(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    code: 'telegram_notifications',
    name: 'Уведомления в Telegram',
    description: 'Сообщения о событиях, которые вас касаются',
    amount: '500.00',
    currency: 'RUB',
    period: 'month',
    position: 10,
    is_visible: true,
    price_label: '500 ₽ в месяц',
    created_at: '2026-02-14T10:00:00',
    updated_at: '2026-11-02T10:00:00',
    ...overrides,
  };
}

/** Снятое с продажи решение: строка остаётся в реестре, но карточки в магазине нет. */
const HIDDEN = solution({
  id: 2,
  code: 'journal',
  name: 'Журнал действий',
  description: 'Кто, когда и что изменил в кабинете',
  amount: '300.00',
  position: 20,
  is_visible: false,
  price_label: '300 ₽ в месяц',
  created_at: '2026-04-21T10:00:00',
  updated_at: '2026-04-21T10:00:00',
});

const EXTRA_MEMBER = solution({
  id: 3,
  code: 'extra_member',
  name: 'Дополнительные сотрудники',
  description: 'Каждый дополнительный сотрудник сверх мест тарифа.',
  amount: '900.00',
  period: 'once',
  position: 900,
  price_label: '900 ₽ разово',
  created_at: '2026-11-02T10:00:00',
  updated_at: '2026-11-02T10:00:00',
});

const TELEGRAM = solution({});

const CATALOG = [TELEGRAM, HIDDEN, EXTRA_MEMBER];

/** Раздел в настоящем роутере: навигация и переходы — часть проверки. */
function renderSolutions(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/solutions']}>
        <Routes>
          <Route path="/solutions" element={<Solutions />} />
          <Route path="/tariffs" element={<p data-testid="tariffs-probe">Тарифы</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Строка каталога по названию: действия проверяются внутри неё. */
function rowByName(name: string): HTMLElement {
  const row = screen
    .getAllByTestId('operator-solution-row')
    .find(
      (element) => within(element).queryByTestId('operator-solution-name')?.textContent === name,
    );
  if (row === undefined) {
    throw new Error(`Строки решения «${name}» нет в каталоге`);
  }
  return row;
}

/** Названия строк в том порядке, в котором их отрисовал экран. */
function renderedNames(): string[] {
  return screen
    .getAllByTestId('operator-solution-row')
    .map((row) => within(row).getByTestId('operator-solution-name').textContent ?? '');
}

/** Тела запросов указанного метода, ушедших на сервер. */
function bodies(
  network: { calls: { url: string; init: RequestInit }[] },
  method: string,
): string[] {
  return network.calls
    .filter((call) => call.init.method === method)
    .map((call) => String(call.init.body));
}

describe('раздел «Решения» кабинета оператора', () => {
  it('показывает весь каталог, счётчик и поля строк', async () => {
    const network = renderSolutions([{ status: 200, body: CATALOG }]);

    expect(await screen.findByTestId('operator-solutions')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-solution-row')).toHaveLength(3);
    // Счётчик считает и снятые строки: реестр — это весь каталог, а «в каталоге» — подпись продажи.
    expect(screen.getByTestId('operator-solutions-count')).toHaveTextContent(
      '3 решения · 2 в каталоге',
    );

    const telegram = rowByName('Уведомления в Telegram');
    expect(within(telegram).getByTestId('operator-solution-position')).toHaveTextContent('10');
    // Код — гейт функции: показан целиком, включая подчёркивание.
    expect(within(telegram).getByTestId('operator-solution-code')).toHaveTextContent(
      'telegram_notifications',
    );
    expect(within(telegram).getByTestId('operator-solution-state')).toHaveTextContent('В каталоге');
    // Цену печатает сервер готовым `price_label`: экран её не собирает.
    expect(within(telegram).getByTestId('operator-solution-price')).toHaveTextContent(
      '500 ₽ в месяц',
    );
    expect(within(telegram).getByTestId('operator-solution-period')).toHaveTextContent('в месяц');
    expect(within(telegram).getByTestId('operator-solution-created')).toHaveTextContent(
      '14.02.2026',
    );
    expect(within(telegram).getByTestId('operator-solution-updated')).toHaveTextContent(
      '02.11.2026',
    );

    const hidden = rowByName('Журнал действий');
    expect(within(hidden).getByTestId('operator-solution-state')).toHaveTextContent(
      'Не в каталоге',
    );

    const extra = rowByName('Дополнительные сотрудники');
    expect(within(extra).getByTestId('operator-solution-code')).toHaveTextContent('extra_member');
    expect(within(extra).getByTestId('operator-solution-period')).toHaveTextContent('разово');

    const [call] = network.calls;
    expect(call.url).toBe('/api/solutions');
    // Сессия в httpOnly cookie: без credentials браузер её не отправит.
    expect(call.init.credentials).toBe('include');
  });

  it('порядок строк — порядок ответа: экран его не пересортировывает', async () => {
    // Сервер отдаёт `position, id` уже отсортированным: экран обязан показать как пришло,
    // иначе правка порядка не доедет до витрины с той же последовательностью.
    renderSolutions([
      {
        status: 200,
        body: [
          solution({ id: 7, name: 'Первое', position: 1 }),
          solution({ id: 3, name: 'Второе', position: 2 }),
          solution({ id: 5, name: 'Третье', position: 900 }),
        ],
      },
    ]);

    await screen.findByTestId('operator-solutions');
    expect(renderedNames()).toEqual(['Первое', 'Второе', 'Третье']);
  });

  it('навигация помечает «Решения» текущим разделом', async () => {
    renderSolutions([{ status: 200, body: CATALOG }]);
    await screen.findByTestId('operator-solutions');

    expect(screen.getByTestId('operator-nav-solutions')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('operator-nav-solutions')).toHaveTextContent('Решения');
  });

  it('пока идёт загрузка, показывает строку состояния и не показывает счётчик', () => {
    renderSolutions([
      () =>
        new Promise(() => {
          // Ответ не приходит: проверяем именно состояние загрузки.
        }),
    ]);

    const loading = screen.getByTestId('operator-solutions-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Загружаем решения…');
    expect(screen.queryByTestId('operator-solutions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-solutions-count')).not.toBeInTheDocument();
  });

  it('на пустом каталоге показывает «Решений пока нет»', async () => {
    renderSolutions([{ status: 200, body: [] }]);

    expect(await screen.findByTestId('operator-solutions-empty')).toBeInTheDocument();
    expect(screen.getByText('Решений пока нет')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-solutions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-solutions-count')).not.toBeInTheDocument();
  });

  it('отказ загрузки показывает detail дословно и повторяет запрос по «Повторить»', async () => {
    const network = renderSolutions([
      { status: 502, body: { detail: 'Основной API недоступен' } },
      { status: 200, body: CATALOG },
    ]);
    const user = userEvent.setup();

    const error = await screen.findByTestId('operator-solutions-error');
    expect(within(error).getByRole('alert')).toHaveTextContent('Основной API недоступен');
    expect(screen.queryByTestId('operator-solutions')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('operator-solutions-retry'));

    expect(await screen.findByTestId('operator-solutions')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-solution-row')).toHaveLength(3);
    expect(network.calls.filter((call) => call.url === '/api/solutions')).toHaveLength(2);
  });

  it('раскрывает форму под строкой с её значениями', async () => {
    renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Дополнительные сотрудники');
    await user.click(within(row).getByTestId('operator-solution-edit'));

    expect(screen.getByTestId('operator-solution-name-input')).toHaveValue(
      'Дополнительные сотрудники',
    );
    expect(screen.getByTestId('operator-solution-description-input')).toHaveValue(
      'Каждый дополнительный сотрудник сверх мест тарифа.',
    );
    expect(screen.getByTestId('operator-solution-amount-input')).toHaveValue('900.00');
    expect(screen.getByTestId('operator-solution-currency-input')).toHaveValue('RUB');
    expect(screen.getByTestId('operator-solution-period-input')).toHaveValue('once');
    expect(screen.getByTestId('operator-solution-position-input')).toHaveValue('900');
    expect(screen.getByTestId('operator-solution-visible-input')).toHaveValue('true');
    // Открытая форма помечена на самой кнопке: скринридер читает состояние.
    expect(within(row).getByTestId('operator-solution-edit')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('«Отмена» закрывает форму без запроса', async () => {
    const network = renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    await user.click(screen.getByTestId('operator-solution-cancel'));

    expect(screen.queryByTestId('operator-solution-name-input')).not.toBeInTheDocument();
    expect(network.calls).toHaveLength(1);
  });

  it('«Сохранить» отправляет все редактируемые поля и обновляет строку', async () => {
    const updated = solution({
      id: 1,
      name: 'Уведомления в Telegram · год',
      amount: '5000.00',
      period: 'year',
      position: 0,
      price_label: '5 000 ₽ в год',
      updated_at: '2026-11-06T12:00:00',
    });
    const network = renderSolutions([
      { status: 200, body: CATALOG },
      { status: 200, body: updated },
      // После правки экран перечитывает каталог: место строки задаёт сервер.
      { status: 200, body: [updated, HIDDEN, EXTRA_MEMBER] },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );

    const name = screen.getByTestId('operator-solution-name-input');
    await user.clear(name);
    await user.type(name, 'Уведомления в Telegram · год');
    const position = screen.getByTestId('operator-solution-position-input');
    await user.clear(position);
    await user.type(position, '0');
    const amount = screen.getByTestId('operator-solution-amount-input');
    await user.clear(amount);
    await user.type(amount, '5000.00');
    await user.selectOptions(screen.getByTestId('operator-solution-period-input'), 'year');

    await user.click(screen.getByTestId('operator-solution-save'));

    expect(await screen.findByText('Уведомления в Telegram · год')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-solution-name-input')).not.toBeInTheDocument();

    const row = rowByName('Уведомления в Telegram · год');
    // Цену после правки приносит ответ сервера, а не пересчёт на клиенте.
    expect(within(row).getByTestId('operator-solution-price')).toHaveTextContent('5 000 ₽ в год');
    expect(within(row).getByTestId('operator-solution-period')).toHaveTextContent('в год');
    expect(within(row).getByTestId('operator-solution-position')).toHaveTextContent('0');
    expect(within(row).getByTestId('operator-solution-updated')).toHaveTextContent('06.11.2026');

    const patches = bodies(network, 'PATCH');
    expect(patches).toHaveLength(1);
    expect(network.calls[1].url).toBe('/api/solutions/1');
    expect(JSON.parse(patches[0])).toEqual({
      name: 'Уведомления в Telegram · год',
      description: 'Сообщения о событиях, которые вас касаются',
      amount: '5000.00',
      currency: 'RUB',
      period: 'year',
      position: 0,
      is_visible: true,
    });
    // После успешного PATCH каталог перечитан: GET, PATCH и снова GET.
    expect(network.calls).toHaveLength(3);
    expect(network.calls[2].url).toBe('/api/solutions');
  });

  it('после правки «Порядка» строка встаёт на место из ответа сервера', async () => {
    // Кадр 3 макета: правим последнюю строку (`position = 900`) на `0` — она
    // обязана переехать наверх, как только сервер отдаст каталог в новом порядке.
    const moved = solution({ ...EXTRA_MEMBER, position: 0 });
    const network = renderSolutions([
      { status: 200, body: CATALOG },
      { status: 200, body: moved },
      { status: 200, body: [moved, TELEGRAM, HIDDEN] },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    expect(renderedNames()).toEqual([
      'Уведомления в Telegram',
      'Журнал действий',
      'Дополнительные сотрудники',
    ]);

    await user.click(
      within(rowByName('Дополнительные сотрудники')).getByTestId('operator-solution-edit'),
    );
    const position = screen.getByTestId('operator-solution-position-input');
    await user.clear(position);
    await user.type(position, '0');
    await user.click(screen.getByTestId('operator-solution-save'));

    // Порядок пересортировывает сервер, а не экран: пришло первым — стоит первым.
    await waitFor(() =>
      expect(renderedNames()).toEqual([
        'Дополнительные сотрудники',
        'Уведомления в Telegram',
        'Журнал действий',
      ]),
    );
    expect(JSON.parse(bodies(network, 'PATCH')[0])).toMatchObject({ position: 0 });
    // Правка не подменяет строку по индексу, а перечитывает каталог целиком.
    expect(network.calls).toHaveLength(3);
  });

  it('пустое описание уходит как null', async () => {
    const withoutDescription = solution({ id: 1, description: null });
    const network = renderSolutions([
      { status: 200, body: CATALOG },
      { status: 200, body: withoutDescription },
      { status: 200, body: [withoutDescription, HIDDEN, EXTRA_MEMBER] },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    await user.clear(screen.getByTestId('operator-solution-description-input'));
    await user.click(screen.getByTestId('operator-solution-save'));

    await waitFor(() => expect(bodies(network, 'PATCH')).toHaveLength(1));
    expect(JSON.parse(bodies(network, 'PATCH')[0])).toEqual({
      name: 'Уведомления в Telegram',
      description: null,
      amount: '500.00',
      currency: 'RUB',
      period: 'month',
      position: 10,
      is_visible: true,
    });
    await waitFor(() =>
      expect(
        within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-description'),
      ).toHaveTextContent('—'),
    );
  });

  it('если каталог после правки не перечитался, строка остаётся из ответа PATCH', async () => {
    // Сеть упала на втором GET: правка уже сохранена, и терять её на экране нельзя.
    const updated = solution({ id: 1, name: 'Уведомления в Telegram · год' });
    const network = renderSolutions([
      { status: 200, body: CATALOG },
      { status: 200, body: updated },
      { reject: true },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    const name = screen.getByTestId('operator-solution-name-input');
    await user.clear(name);
    await user.type(name, 'Уведомления в Telegram · год');
    await user.click(screen.getByTestId('operator-solution-save'));

    expect(await screen.findByText('Уведомления в Telegram · год')).toBeInTheDocument();
    expect(network.calls).toHaveLength(3);
    // Экран не показывает отказ загрузки: каталог на месте, обновилось только имя.
    expect(screen.queryByTestId('operator-solutions-error')).not.toBeInTheDocument();
  });

  it('нечисловой порядок не отправляет: объясняет словами', async () => {
    const network = renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    const position = screen.getByTestId('operator-solution-position-input');
    await user.clear(position);
    await user.type(position, 'первым');
    await user.click(screen.getByTestId('operator-solution-save'));

    expect(screen.getByText('Порядок — целое число')).toBeInTheDocument();
    expect(position).toHaveAttribute('aria-invalid', 'true');
    expect(bodies(network, 'PATCH')).toHaveLength(0);
    // Форма остаётся развёрнутой: введённое не потеряно.
    expect(screen.getByTestId('operator-solution-name-input')).toBeInTheDocument();
  });

  it('«Удалить» двухшаговое: запрос уходит только после «Подтвердить»', async () => {
    const network = renderSolutions([{ status: 200, body: CATALOG }, { status: 204 }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Уведомления в Telegram');
    await user.click(within(row).getByTestId('operator-solution-delete'));

    // Запроса ещё нет: первый шаг только спрашивает подтверждение.
    expect(within(row).getByTestId('operator-solution-delete-confirm')).toBeInTheDocument();
    expect(within(row).getByTestId('operator-solution-delete-decline')).toBeInTheDocument();
    expect(network.calls).toHaveLength(1);

    await user.click(within(row).getByTestId('operator-solution-delete-confirm'));

    // Строка остаётся на месте и становится «Не в каталоге»: DELETE ничего не удаляет.
    await waitFor(() =>
      expect(
        within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-state'),
      ).toHaveTextContent('Не в каталоге'),
    );
    expect(screen.getAllByTestId('operator-solution-row')).toHaveLength(3);
    expect(screen.getByTestId('operator-solutions-count')).toHaveTextContent(
      '3 решения · 1 в каталоге',
    );

    // На месте «Удалить» — «Опубликовать», а «Удалить» больше нет.
    expect(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-publish'),
    ).toBeInTheDocument();
    expect(
      within(rowByName('Уведомления в Telegram')).queryByTestId('operator-solution-delete'),
    ).not.toBeInTheDocument();

    const deletes = network.calls.filter((call) => call.init.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe('/api/solutions/1');
    // Тела у DELETE нет.
    expect(deletes[0].init.body).toBeUndefined();
  });

  it('«Не надо» возвращает строку в прежний вид без запроса', async () => {
    const network = renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Уведомления в Telegram');
    await user.click(within(row).getByTestId('operator-solution-delete'));
    await user.click(within(row).getByTestId('operator-solution-delete-decline'));

    expect(within(row).getByTestId('operator-solution-delete')).toBeInTheDocument();
    expect(within(row).queryByTestId('operator-solution-delete-confirm')).not.toBeInTheDocument();
    expect(network.calls).toHaveLength(1);
  });

  it('«Опубликовать» отправляет PATCH с одним полем is_visible', async () => {
    const network = renderSolutions([
      { status: 200, body: CATALOG },
      { status: 200, body: solution({ ...HIDDEN, is_visible: true }) },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(within(rowByName('Журнал действий')).getByTestId('operator-solution-publish'));

    await waitFor(() =>
      expect(
        within(rowByName('Журнал действий')).getByTestId('operator-solution-state'),
      ).toHaveTextContent('В каталоге'),
    );
    expect(
      within(rowByName('Журнал действий')).getByTestId('operator-solution-delete'),
    ).toBeInTheDocument();

    const patches = bodies(network, 'PATCH');
    expect(patches).toHaveLength(1);
    expect(network.calls[1].url).toBe('/api/solutions/2');
    expect(JSON.parse(patches[0])).toEqual({ is_visible: true });
  });

  it('на отправке кнопка неактивна и говорит «Сохраняем…», поля не сброшены', async () => {
    renderSolutions([
      { status: 200, body: CATALOG },
      () =>
        new Promise(() => {
          // Ответ на PATCH не приходит: проверяем состояние отправки.
        }),
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    const name = screen.getByTestId('operator-solution-name-input');
    await user.clear(name);
    await user.type(name, 'Уведомления в Telegram · новое');
    await user.click(screen.getByTestId('operator-solution-save'));

    const save = screen.getByTestId('operator-solution-save');
    await waitFor(() => expect(save).toBeDisabled());
    expect(save).toHaveTextContent('Сохраняем…');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('operator-solution-cancel')).toBeDisabled();
    // Введённое остаётся на месте, пока идёт запрос.
    expect(screen.getByTestId('operator-solution-name-input')).toHaveValue(
      'Уведомления в Telegram · новое',
    );
  });

  it('пока форма отправляется, кнопки строки заперты', async () => {
    renderSolutions([
      { status: 200, body: CATALOG },
      () =>
        new Promise(() => {
          // Ответ на PATCH не приходит: проверяем, что строку не отправить дважды.
        }),
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    await user.click(screen.getByTestId('operator-solution-save'));

    // Кнопка раскрытия формы остаётся доступной, «Удалить» на время запроса заперта.
    await waitFor(() =>
      expect(
        within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-delete'),
      ).toBeDisabled(),
    );
  });

  it('409 на занятое имя: текст дословно, форма открыта, поле с aria-invalid', async () => {
    const network = renderSolutions([
      { status: 200, body: CATALOG },
      { status: 409, body: { detail: 'Решение с таким названием уже есть' } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    const name = screen.getByTestId('operator-solution-name-input');
    await user.clear(name);
    await user.type(name, 'ЖУРНАЛ ДЕЙСТВИЙ');
    await user.click(screen.getByTestId('operator-solution-save'));

    const error = await screen.findByTestId('operator-solution-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('Решение с таким названием уже есть');
    // Введённое значение не сбрасывается.
    expect(screen.getByTestId('operator-solution-name-input')).toHaveValue('ЖУРНАЛ ДЕЙСТВИЙ');
    expect(screen.getByTestId('operator-solution-name-input')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByTestId('operator-solution-name-input')).toHaveAttribute(
      'aria-describedby',
      'solution-error',
    );
    // Список не перезагружался: после загрузки и PATCH всего два запроса.
    expect(network.calls).toHaveLength(2);
  });

  it('422 на валюту: текст дословно, виноватое поле помечено', async () => {
    renderSolutions([
      { status: 200, body: CATALOG },
      {
        status: 422,
        body: {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'currency'],
              msg: 'Value error, Валюта должна состоять из 3 заглавных латинских букв',
            },
          ],
        },
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    const currency = screen.getByTestId('operator-solution-currency-input');
    await user.clear(currency);
    await user.type(currency, 'руб');
    await user.click(screen.getByTestId('operator-solution-save'));

    // Приставку `Value error, ` снимает клиент: контракт требует ровно этот текст.
    expect(await screen.findByTestId('operator-solution-error')).toHaveTextContent(
      'Валюта должна состоять из 3 заглавных латинских букв',
    );
    expect(currency).toHaveValue('руб');
    expect(currency).toHaveAttribute('aria-invalid', 'true');
  });

  it('422 на порядок: текст сервера дословно, поле «Порядок» помечено', async () => {
    renderSolutions([
      { status: 200, body: CATALOG },
      {
        status: 422,
        body: {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'position'],
              msg: 'Value error, Порядок не может быть отрицательным',
            },
          ],
        },
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );
    const position = screen.getByTestId('operator-solution-position-input');
    await user.clear(position);
    await user.type(position, '-5');
    await user.click(screen.getByTestId('operator-solution-save'));

    // Отрицательное число уходит на сервер как есть: правило живёт в основном API.
    expect(await screen.findByTestId('operator-solution-error')).toHaveTextContent(
      'Порядок не может быть отрицательным',
    );
    expect(position).toHaveAttribute('aria-invalid', 'true');
  });

  it('отказ удаления показывает detail дословно и оставляет строку в каталоге', async () => {
    renderSolutions([
      { status: 200, body: CATALOG },
      { status: 404, body: { detail: 'Решение не найдено' } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Уведомления в Telegram');
    await user.click(within(row).getByTestId('operator-solution-delete'));
    await user.click(within(row).getByTestId('operator-solution-delete-confirm'));

    expect(await screen.findByTestId('operator-solution-error')).toHaveTextContent(
      'Решение не найдено',
    );
    expect(within(row).getByTestId('operator-solution-state')).toHaveTextContent('В каталоге');
    expect(within(row).getByTestId('operator-solution-delete')).toBeInTheDocument();
  });

  it('после «Подтвердить» фокус остаётся в строке', async () => {
    renderSolutions([{ status: 200, body: CATALOG }, { status: 204 }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Уведомления в Telegram');
    await user.click(within(row).getByTestId('operator-solution-delete'));
    await user.click(within(row).getByTestId('operator-solution-delete-confirm'));

    // Нажатая «Подтвердить» исчезла из DOM — фокус возвращается в ту же строку.
    const edit = within(row).getByTestId('operator-solution-edit');
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });

  it('после «Не надо» фокус остаётся в строке', async () => {
    renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Уведомления в Telegram');
    await user.click(within(row).getByTestId('operator-solution-delete'));
    await user.click(within(row).getByTestId('operator-solution-delete-decline'));

    // «Не надо» исчезла из DOM: без возврата фокуса Tab начал бы обход сначала.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row).getByTestId('operator-solution-edit')),
    );
  });

  it('после «Отмена» фокус остаётся в строке', async () => {
    renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    const row = rowByName('Уведомления в Telegram');
    await user.click(within(row).getByTestId('operator-solution-edit'));
    await user.click(screen.getByTestId('operator-solution-cancel'));

    // Форма закрылась вместе с кнопкой «Отмена» — фокус возвращается в строку.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row).getByTestId('operator-solution-edit')),
    );
  });

  it('у каждого поля формы есть label', async () => {
    renderSolutions([{ status: 200, body: CATALOG }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-solutions');
    await user.click(
      within(rowByName('Уведомления в Telegram')).getByTestId('operator-solution-edit'),
    );

    for (const id of [
      'operator-solution-name-input',
      'operator-solution-description-input',
      'operator-solution-amount-input',
      'operator-solution-currency-input',
      'operator-solution-period-input',
      'operator-solution-position-input',
      'operator-solution-visible-input',
    ]) {
      expect(screen.getByTestId(id)).toHaveAccessibleName();
    }
  });
});
