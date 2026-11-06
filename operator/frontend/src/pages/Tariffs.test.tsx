import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Tariffs } from './Tariffs';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

/** Строка прайса в форме ответа кабинета: поля ровно по контракту постановки. */
function tariff(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name: 'Рост · 3 месяца',
    description: 'Все разделы, расширенная отчётность и статистика.',
    amount: '26700.00',
    currency: 'RUB',
    period: 'quarter',
    unit_label: 'за одно место',
    position: 10,
    is_visible: true,
    max_members: 15,
    tooltip: null,
    group_code: 'rost',
    price_label: '26 700 ₽ за 3 месяца',
    ...overrides,
  };
}

/** Снятая строка прежнего прайса: стоит первой по `position, id`. */
const OLD_HIDDEN = tariff({
  id: 2,
  name: 'Старт (прежний прайс)',
  description: 'До 10 пользователей. Реестр проживающих, комнаты и базовые отчёты.',
  amount: '10000.00',
  period: 'month',
  position: 1,
  is_visible: false,
  max_members: null,
  group_code: null,
  price_label: '10 000 ₽ в месяц',
});

const START_QUARTER = tariff({
  id: 5,
  name: 'Старт · 3 месяца',
  description: 'Реестр проживающих, комнаты и места, базовые отчёты.',
  amount: '13200.00',
  max_members: 5,
  group_code: 'start',
  price_label: '13 200 ₽ за 3 месяца',
});

const START_YEAR = tariff({
  id: 6,
  name: 'Старт · 12 месяцев',
  description: 'Реестр проживающих, комнаты и места, базовые отчёты.',
  amount: '47000.00',
  period: 'year',
  max_members: 5,
  group_code: 'start',
  price_label: '47 000 ₽ в год',
});

const ROST_MONTH = tariff({
  id: 9,
  name: 'Рост',
  amount: '9900.00',
  period: 'month',
  price_label: '9 900 ₽ в месяц',
});

const PRICE_LIST = [OLD_HIDDEN, START_QUARTER, START_YEAR, ROST_MONTH];

/** Раздел в настоящем роутере: навигация и переходы — часть проверки. */
function renderTariffs(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/tariffs']}>
        <Routes>
          <Route path="/tariffs" element={<Tariffs />} />
          <Route path="/users" element={<p data-testid="users-probe">Пользователи</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Строка прайса по названию: действия проверяются внутри неё. */
function rowByName(name: string): HTMLElement {
  const row = screen
    .getAllByTestId('operator-tariff-row')
    .find((element) => within(element).queryByTestId('operator-tariff-name')?.textContent === name);
  if (row === undefined) {
    throw new Error(`Строки тарифа «${name}» нет в прайсе`);
  }
  return row;
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

describe('раздел «Тарифы» кабинета оператора', () => {
  it('показывает весь прайс, счётчик и состояние строк', async () => {
    const network = renderTariffs([{ status: 200, body: PRICE_LIST }]);

    expect(await screen.findByTestId('operator-tariffs')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-tariff-row')).toHaveLength(4);
    // Счётчик считает и снятые строки: прайс — это все строки, «в прайсе» — подпись продажи.
    expect(screen.getByTestId('operator-tariffs-count')).toHaveTextContent('4 тарифа · 3 в прайсе');

    const hidden = rowByName('Старт (прежний прайс)');
    expect(within(hidden).getByTestId('operator-tariff-state')).toHaveTextContent('Не в прайсе');
    expect(within(hidden).getByTestId('operator-tariff-members')).toHaveTextContent(
      'без ограничения',
    );
    // Цену и период печатает сервер: строку экран не пересобирает.
    expect(within(hidden).getByTestId('operator-tariff-price')).toHaveTextContent(
      '10 000 ₽ в месяц',
    );
    expect(within(hidden).getByTestId('operator-tariff-period')).toHaveTextContent('в месяц');

    const quarter = rowByName('Старт · 3 месяца');
    expect(within(quarter).getByTestId('operator-tariff-state')).toHaveTextContent('В прайсе');
    expect(within(quarter).getByTestId('operator-tariff-period')).toHaveTextContent('за 3 месяца');
    expect(within(quarter).getByTestId('operator-tariff-members')).toHaveTextContent('5');
    expect(within(quarter).getByTestId('operator-tariff-description')).toHaveTextContent(
      'Реестр проживающих, комнаты и места, базовые отчёты.',
    );

    const [call] = network.calls;
    expect(call.url).toBe('/api/tariffs');
    // Сессия в httpOnly cookie: без credentials браузер её не отправит.
    expect(call.init.credentials).toBe('include');
  });

  it('у снятой строки нет «Удалить», а у строки в прайсе нет «Опубликовать»', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }]);
    await screen.findByTestId('operator-tariffs');

    const hidden = rowByName('Старт (прежний прайс)');
    expect(within(hidden).getByTestId('operator-tariff-publish')).toBeInTheDocument();
    expect(within(hidden).queryByTestId('operator-tariff-delete')).not.toBeInTheDocument();
    // Правка доступна и снятой строке: вернуть её в прайс можно и правкой.
    expect(within(hidden).getByTestId('operator-tariff-edit')).toBeInTheDocument();

    const visible = rowByName('Рост');
    expect(within(visible).getByTestId('operator-tariff-delete')).toBeInTheDocument();
    expect(within(visible).queryByTestId('operator-tariff-publish')).not.toBeInTheDocument();
  });

  it('навигация помечает «Тарифы» текущим разделом', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }]);
    await screen.findByTestId('operator-tariffs');

    expect(screen.getByTestId('operator-nav-tariffs')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('operator-nav-tariffs')).toHaveTextContent('Тарифы');
  });

  it('пока идёт загрузка, показывает строку состояния и не показывает счётчик', () => {
    renderTariffs([
      () =>
        new Promise(() => {
          // Ответ не приходит: проверяем именно состояние загрузки.
        }),
    ]);

    const loading = screen.getByTestId('operator-tariffs-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Загружаем тарифы…');
    expect(screen.queryByTestId('operator-tariffs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-tariffs-count')).not.toBeInTheDocument();
  });

  it('на пустом прайсе показывает «Тарифов пока нет»', async () => {
    renderTariffs([{ status: 200, body: [] }]);

    expect(await screen.findByTestId('operator-tariffs-empty')).toBeInTheDocument();
    expect(screen.getByText('Тарифов пока нет')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-tariffs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-tariffs-count')).not.toBeInTheDocument();
  });

  it('отказ загрузки показывает detail дословно', async () => {
    renderTariffs([{ status: 502, body: { detail: 'Основной API недоступен' } }]);

    const error = await screen.findByTestId('operator-tariffs-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('Основной API недоступен');
    expect(screen.queryByTestId('operator-tariffs')).not.toBeInTheDocument();
  });

  it('раскрывает форму под строкой с её значениями', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Старт · 3 месяца');
    await user.click(within(row).getByTestId('operator-tariff-edit'));

    expect(screen.getByTestId('operator-tariff-name-input')).toHaveValue('Старт · 3 месяца');
    expect(screen.getByTestId('operator-tariff-description-input')).toHaveValue(
      'Реестр проживающих, комнаты и места, базовые отчёты.',
    );
    expect(screen.getByTestId('operator-tariff-amount-input')).toHaveValue('13200.00');
    expect(screen.getByTestId('operator-tariff-period-input')).toHaveValue('quarter');
    expect(screen.getByTestId('operator-tariff-members-input')).toHaveValue('5');
    // Открытая форма помечена на самой кнопке: скринридер читает состояние.
    expect(within(row).getByTestId('operator-tariff-edit')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('«Отмена» закрывает форму без запроса', async () => {
    const network = renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));
    await user.click(screen.getByTestId('operator-tariff-cancel'));

    expect(screen.queryByTestId('operator-tariff-name-input')).not.toBeInTheDocument();
    expect(network.calls).toHaveLength(1);
  });

  it('«Сохранить» отправляет все пять полей и обновляет строку без перезагрузки', async () => {
    const updated = tariff({
      id: 9,
      name: 'Рост · квартал',
      amount: '26700.00',
      price_label: '26 700 ₽ за 3 месяца',
      max_members: 20,
    });
    const network = renderTariffs([
      { status: 200, body: PRICE_LIST },
      { status: 200, body: updated },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));

    const name = screen.getByTestId('operator-tariff-name-input');
    await user.clear(name);
    await user.type(name, 'Рост · квартал');
    const amount = screen.getByTestId('operator-tariff-amount-input');
    await user.clear(amount);
    await user.type(amount, '26700.00');
    await user.selectOptions(screen.getByTestId('operator-tariff-period-input'), 'quarter');
    const members = screen.getByTestId('operator-tariff-members-input');
    await user.clear(members);
    await user.type(members, '20');

    await user.click(screen.getByTestId('operator-tariff-save'));

    expect(await screen.findByText('Рост · квартал')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-tariff-name-input')).not.toBeInTheDocument();

    const row = rowByName('Рост · квартал');
    // Цену после правки приносит ответ сервера, а не пересчёт на клиенте.
    expect(within(row).getByTestId('operator-tariff-price')).toHaveTextContent(
      '26 700 ₽ за 3 месяца',
    );
    expect(within(row).getByTestId('operator-tariff-period')).toHaveTextContent('за 3 месяца');
    expect(within(row).getByTestId('operator-tariff-members')).toHaveTextContent('20');

    const patches = bodies(network, 'PATCH');
    expect(patches).toHaveLength(1);
    expect(network.calls[1].url).toBe('/api/tariffs/9');
    expect(JSON.parse(patches[0])).toEqual({
      name: 'Рост · квартал',
      description: 'Все разделы, расширенная отчётность и статистика.',
      amount: '26700.00',
      period: 'quarter',
      max_members: 20,
    });
    // Список не перезагружался: после загрузки и PATCH всего два запроса.
    expect(network.calls).toHaveLength(2);
  });

  it('пустое описание и пустое количество пользователей уходят как null', async () => {
    const network = renderTariffs([
      { status: 200, body: PRICE_LIST },
      {
        status: 200,
        body: tariff({ id: 9, name: 'Рост', max_members: null, description: null }),
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));

    await user.clear(screen.getByTestId('operator-tariff-description-input'));
    await user.clear(screen.getByTestId('operator-tariff-members-input'));
    await user.click(screen.getByTestId('operator-tariff-save'));

    await waitFor(() => expect(bodies(network, 'PATCH')).toHaveLength(1));
    expect(JSON.parse(bodies(network, 'PATCH')[0])).toEqual({
      name: 'Рост',
      description: null,
      amount: '9900.00',
      period: 'month',
      max_members: null,
    });
  });

  it('нечисловое количество пользователей не отправляет: объясняет словами', async () => {
    const network = renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));
    const members = screen.getByTestId('operator-tariff-members-input');
    await user.clear(members);
    await user.type(members, 'много');
    await user.click(screen.getByTestId('operator-tariff-save'));

    expect(
      screen.getByText('Количество пользователей — целое число или пусто'),
    ).toBeInTheDocument();
    expect(members).toHaveAttribute('aria-invalid', 'true');
    expect(bodies(network, 'PATCH')).toHaveLength(0);
    // Форма остаётся развёрнутой: введённое не потеряно.
    expect(screen.getByTestId('operator-tariff-name-input')).toBeInTheDocument();
  });

  it('«Удалить» двухшаговое: запрос уходит только после «Подтвердить»', async () => {
    const network = renderTariffs([{ status: 200, body: PRICE_LIST }, { status: 204 }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Старт · 3 месяца');
    await user.click(within(row).getByTestId('operator-tariff-delete'));

    // Запроса ещё нет: первый шаг только спрашивает подтверждение.
    expect(within(row).getByTestId('operator-tariff-delete-confirm')).toBeInTheDocument();
    expect(within(row).getByTestId('operator-tariff-delete-decline')).toBeInTheDocument();
    expect(network.calls).toHaveLength(1);

    await user.click(within(row).getByTestId('operator-tariff-delete-confirm'));

    // Строка остаётся на месте и становится «Не в прайсе»: DELETE ничего не удаляет.
    await waitFor(() =>
      expect(
        within(rowByName('Старт · 3 месяца')).getByTestId('operator-tariff-state'),
      ).toHaveTextContent('Не в прайсе'),
    );
    expect(screen.getAllByTestId('operator-tariff-row')).toHaveLength(4);
    expect(screen.getByTestId('operator-tariffs-count')).toHaveTextContent('4 тарифа · 2 в прайсе');

    const publishes = within(rowByName('Старт · 3 месяца')).getAllByTestId(
      'operator-tariff-publish',
    );
    expect(publishes).toHaveLength(1);
    expect(
      within(rowByName('Старт · 3 месяца')).queryByTestId('operator-tariff-delete'),
    ).not.toBeInTheDocument();

    const deletes = network.calls.filter((call) => call.init.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toBe('/api/tariffs/5');
    // Тела у DELETE нет.
    expect(deletes[0].init.body).toBeUndefined();
  });

  it('«Не надо» возвращает строку в прежний вид без запроса', async () => {
    const network = renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Рост');
    await user.click(within(row).getByTestId('operator-tariff-delete'));
    await user.click(within(row).getByTestId('operator-tariff-delete-decline'));

    expect(within(row).getByTestId('operator-tariff-delete')).toBeInTheDocument();
    expect(within(row).queryByTestId('operator-tariff-delete-confirm')).not.toBeInTheDocument();
    expect(network.calls).toHaveLength(1);
  });

  it('«Опубликовать» отправляет PATCH с одним полем is_visible', async () => {
    const network = renderTariffs([
      { status: 200, body: PRICE_LIST },
      {
        status: 200,
        body: tariff({
          id: 2,
          name: 'Старт (прежний прайс)',
          is_visible: true,
          max_members: null,
          price_label: '10 000 ₽ в месяц',
        }),
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(
      within(rowByName('Старт (прежний прайс)')).getByTestId('operator-tariff-publish'),
    );

    await waitFor(() =>
      expect(
        within(rowByName('Старт (прежний прайс)')).getByTestId('operator-tariff-state'),
      ).toHaveTextContent('В прайсе'),
    );
    expect(
      within(rowByName('Старт (прежний прайс)')).getByTestId('operator-tariff-delete'),
    ).toBeInTheDocument();

    const patches = bodies(network, 'PATCH');
    expect(patches).toHaveLength(1);
    expect(network.calls[1].url).toBe('/api/tariffs/2');
    expect(JSON.parse(patches[0])).toEqual({ is_visible: true });
  });

  it('на отправке кнопка неактивна и говорит «Сохраняем…», поля не сброшены', async () => {
    renderTariffs([
      { status: 200, body: PRICE_LIST },
      () =>
        new Promise(() => {
          // Ответ на PATCH не приходит: проверяем состояние отправки.
        }),
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));
    const name = screen.getByTestId('operator-tariff-name-input');
    await user.clear(name);
    await user.type(name, 'Рост · новый');
    await user.click(screen.getByTestId('operator-tariff-save'));

    const save = screen.getByTestId('operator-tariff-save');
    await waitFor(() => expect(save).toBeDisabled());
    expect(save).toHaveTextContent('Сохраняем…');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('operator-tariff-cancel')).toBeDisabled();
    // Введённое остаётся на месте, пока идёт запрос.
    expect(screen.getByTestId('operator-tariff-name-input')).toHaveValue('Рост · новый');
  });

  it('409 на занятое имя: текст дословно, форма открыта, поле с aria-invalid', async () => {
    const network = renderTariffs([
      { status: 200, body: PRICE_LIST },
      { status: 409, body: { detail: 'Тариф с таким названием уже есть' } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));
    const name = screen.getByTestId('operator-tariff-name-input');
    await user.clear(name);
    await user.type(name, 'СТАРТ');
    await user.click(screen.getByTestId('operator-tariff-save'));

    const error = await screen.findByTestId('operator-tariff-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('Тариф с таким названием уже есть');
    // Введённое значение не сбрасывается.
    expect(screen.getByTestId('operator-tariff-name-input')).toHaveValue('СТАРТ');
    expect(screen.getByTestId('operator-tariff-name-input')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByTestId('operator-tariff-name-input')).toHaveAttribute(
      'aria-describedby',
      'tariff-error',
    );
    // Список не перезагружался: после загрузки и PATCH всего два запроса.
    expect(network.calls).toHaveLength(2);
  });

  it('422 на цену: текст дословно, виноватое поле помечено', async () => {
    renderTariffs([
      { status: 200, body: PRICE_LIST },
      {
        status: 422,
        body: {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'amount'],
              msg: 'Value error, Слишком большая цена',
            },
          ],
        },
      },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));
    const amount = screen.getByTestId('operator-tariff-amount-input');
    await user.clear(amount);
    await user.type(amount, '999999999');
    await user.click(screen.getByTestId('operator-tariff-save'));

    // Приставку `Value error, ` снимает клиент: контракт требует ровно этот текст.
    expect(await screen.findByTestId('operator-tariff-error')).toHaveTextContent(
      'Слишком большая цена',
    );
    expect(amount).toHaveValue('999999999');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
  });

  it('отказ удаления показывает detail дословно и оставляет строку в прайсе', async () => {
    renderTariffs([
      { status: 200, body: PRICE_LIST },
      { status: 404, body: { detail: 'Тариф не найден' } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Рост');
    await user.click(within(row).getByTestId('operator-tariff-delete'));
    await user.click(within(row).getByTestId('operator-tariff-delete-confirm'));

    expect(await screen.findByTestId('operator-tariff-error')).toHaveTextContent('Тариф не найден');
    expect(within(row).getByTestId('operator-tariff-state')).toHaveTextContent('В прайсе');
    expect(within(row).getByTestId('operator-tariff-delete')).toBeInTheDocument();
  });

  it('после «Подтвердить» фокус остаётся в строке', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }, { status: 204 }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Рост');
    await user.click(within(row).getByTestId('operator-tariff-delete'));
    await user.click(within(row).getByTestId('operator-tariff-delete-confirm'));

    // Нажатая «Подтвердить» исчезла из DOM — фокус возвращается в ту же строку.
    const edit = within(row).getByTestId('operator-tariff-edit');
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });

  it('после «Не надо» фокус остаётся в строке', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Рост');
    await user.click(within(row).getByTestId('operator-tariff-delete'));
    await user.click(within(row).getByTestId('operator-tariff-delete-decline'));

    // «Не надо» исчезла из DOM: без возврата фокуса Tab начал бы обход сначала.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row).getByTestId('operator-tariff-edit')),
    );
  });

  it('после «Отмена» фокус остаётся в строке', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    const row = rowByName('Рост');
    await user.click(within(row).getByTestId('operator-tariff-edit'));
    await user.click(screen.getByTestId('operator-tariff-cancel'));

    // Форма закрылась вместе с кнопкой «Отмена» — фокус возвращается в строку.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row).getByTestId('operator-tariff-edit')),
    );
  });

  it('у каждого поля формы есть label', async () => {
    renderTariffs([{ status: 200, body: PRICE_LIST }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-tariffs');
    await user.click(within(rowByName('Рост')).getByTestId('operator-tariff-edit'));

    for (const id of [
      'operator-tariff-name-input',
      'operator-tariff-description-input',
      'operator-tariff-amount-input',
      'operator-tariff-period-input',
      'operator-tariff-members-input',
    ]) {
      expect(screen.getByTestId(id)).toHaveAccessibleName();
    }
  });
});
