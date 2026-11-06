import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { OrganizationCard } from './OrganizationCard';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

const DETAILS = {
  id: 131,
  name: 'ООО «Северный дом»',
  inn: '7716234567',
  kpp: '771601001',
  ogrn: '1237700123456',
  address: '127254, г. Москва, ул. Руставели, д. 14, корп. 2',
  created_at: '2026-03-14T10:00:00',
  members_count: 12,
  dormitories_count: 3,
};

/** Состояние подписки: действующий тариф на 5 мест, 3 докуплено, три права. */
const SUBSCRIPTION = {
  tariff: {
    id: 21,
    name: 'Домовой · 6 месяцев',
    period: 'half_year',
    max_members: 5,
    price_label: '60 000 ₽ за 6 месяцев',
    ends_at: '2027-06-30T20:59:59.999999Z',
    paid_until: '2027-06-30',
    is_live: true,
  },
  days_left: 236,
  next: null,
  extra_seats: 3,
  member_limit: 8,
  solutions: [
    {
      code: 'telegram_notifications',
      name: 'Уведомления в Telegram',
      expires_at: '2027-02-14T20:59:59.999999Z',
      paid_until: '2027-02-14',
      is_live: true,
    },
    {
      code: 'solution_journal',
      name: 'Журнал действий',
      expires_at: null,
      paid_until: null,
      is_live: true,
    },
    {
      code: 'extra_seats',
      name: 'Дополнительные сотрудники',
      expires_at: '2026-10-31T20:59:59.999999Z',
      paid_until: '2026-10-31',
      is_live: false,
    },
  ],
};

/** Карточка в настоящем роутере: переход «К списку» проверяем по подмене. */
function renderCard(steps: MockStep[], id = '131') {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={[`/organizations/${id}`]}>
        <Routes>
          <Route path="/organizations/:id" element={<OrganizationCard />} />
          <Route path="/" element={<p data-testid="list-probe">Список организаций</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Открыть карточку и дождаться просмотра. */
async function renderLoaded(steps: MockStep[]) {
  const network = renderCard(steps);
  await screen.findByTestId('operator-organization-card');
  return network;
}

/**
 * Открыть карточку с подпиской.
 *
 * Панель грузит своё состояние отдельным запросом, поэтому в очереди ответов
 * у неё своя строка — сразу после карточки и до действий пользователя.
 */
async function renderReady(subscription: unknown = SUBSCRIPTION, rest: MockStep[] = []) {
  const network = await renderLoaded([
    { status: 200, body: DETAILS },
    { status: 200, body: subscription },
    ...rest,
  ]);
  await screen.findByTestId('operator-subscription-tariff-name');
  return network;
}

/** Ответы карточки и панели — по порядку их запросов. */
function cardAndSubscription(rest: MockStep[] = []): MockStep[] {
  return [{ status: 200, body: DETAILS }, { status: 200, body: SUBSCRIPTION }, ...rest];
}

describe('карточка организации кабинета оператора', () => {
  it('показывает реквизиты, счётчики и дату создания', async () => {
    const network = await renderLoaded(cardAndSubscription());

    expect(screen.getByTestId('operator-organization-name')).toHaveTextContent(
      'ООО «Северный дом»',
    );
    expect(screen.getByTestId('operator-organization-inn')).toHaveTextContent('7716234567');
    expect(screen.getByTestId('operator-organization-kpp')).toHaveTextContent('771601001');
    expect(screen.getByTestId('operator-organization-ogrn')).toHaveTextContent('1237700123456');
    expect(screen.getByTestId('operator-organization-address')).toHaveTextContent(
      '127254, г. Москва, ул. Руставели, д. 14, корп. 2',
    );
    expect(screen.getByText(/Организация №131 · создана 14 марта 2026/)).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('участников')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('общежития')).toBeInTheDocument();
    expect(screen.getByTestId('operator-organization-edit')).toBeInTheDocument();

    expect(network.calls[0].url).toBe('/api/organizations/131');
    expect(network.calls[0].init.credentials).toBe('include');
  });

  it('в шапке загруженной карточки остаётся навигация разделов', async () => {
    await renderLoaded(cardAndSubscription());

    // Шапка одна на все состояния экрана: после загрузки переключатель
    // разделов не должен пропадать — иначе из карточки не уйти в «Пользователи».
    expect(screen.getByTestId('operator-nav-organizations')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('operator-nav-users')).toBeInTheDocument();
    expect(screen.getByTestId('operator-logout')).toBeInTheDocument();
  });

  it('прямой заход на несуществующий номер показывает «Организация не найдена» и «К списку»', async () => {
    renderCard([{ status: 404, body: { detail: 'Организация не найдена' } }], '999999');
    const user = userEvent.setup();

    expect(await screen.findByText('Организация не найдена')).toBeInTheDocument();
    expect(screen.getByText('Организация №999999')).toBeInTheDocument();

    await user.click(screen.getByTestId('operator-organization-back'));

    expect(await screen.findByTestId('list-probe')).toBeInTheDocument();
  });

  it('отказ загрузки показывает текст detail дословно', async () => {
    renderCard([{ status: 502, body: { detail: 'Основной API недоступен' } }]);

    const error = await screen.findByTestId('operator-organization-error');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(screen.queryByTestId('operator-organization-card')).not.toBeInTheDocument();
  });

  it('сохранение отправляет все пять полей и показывает ответ сервера', async () => {
    const network = await renderReady(SUBSCRIPTION, [
      { status: 200, body: { ...DETAILS, inn: '7716123456', address: 'Ленинградский пр-т, 1' } },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-organization-edit'));
    await user.clear(screen.getByTestId('operator-organization-inn'));
    await user.type(screen.getByTestId('operator-organization-inn'), '7716123456');
    await user.clear(screen.getByTestId('operator-organization-address'));
    await user.type(screen.getByTestId('operator-organization-address'), 'Ленинградский пр-т, 1');
    await user.click(screen.getByTestId('operator-organization-save'));

    expect(await screen.findByTestId('operator-organization-edit')).toBeInTheDocument();
    expect(screen.getByTestId('operator-organization-inn')).toHaveTextContent('7716123456');
    expect(screen.getByTestId('operator-organization-address')).toHaveTextContent(
      'Ленинградский пр-т, 1',
    );

    const [patch] = network.calls.filter((call) => call.init.method === 'PATCH');
    expect(patch.url).toBe('/api/organizations/131');
    expect(JSON.parse(String(patch.init.body))).toEqual({
      name: 'ООО «Северный дом»',
      inn: '7716123456',
      kpp: '771601001',
      ogrn: '1237700123456',
      address: 'Ленинградский пр-т, 1',
    });
  });

  it('409 на занятый ИНН показывает текст дословно и не сбрасывает введённое', async () => {
    await renderLoaded(
      cardAndSubscription([{ status: 409, body: { detail: 'Организация с таким ИНН уже есть' } }]),
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-organization-edit'));
    await user.clear(screen.getByTestId('operator-organization-inn'));
    await user.type(screen.getByTestId('operator-organization-inn'), '7716123456');
    await user.click(screen.getByTestId('operator-organization-save'));

    const error = await screen.findByTestId('operator-organization-error');
    expect(error).toHaveTextContent(/^Организация с таким ИНН уже есть$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('operator-organization-inn')).toHaveValue('7716123456');
    // Форма остаётся открытой: правку можно исправить и отправить снова.
    expect(screen.getByTestId('operator-organization-cancel')).toBeInTheDocument();
  });

  it('422 на пустое название показывает текст основного API дословно', async () => {
    await renderLoaded(
      cardAndSubscription([
        {
          status: 422,
          body: {
            detail: [
              {
                type: 'value_error',
                loc: ['body', 'name'],
                msg: 'Value error, Название не может быть пустым',
              },
            ],
          },
        },
      ]),
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-organization-edit'));
    await user.clear(screen.getByTestId('operator-organization-name'));
    await user.click(screen.getByTestId('operator-organization-save'));

    const error = await screen.findByTestId('operator-organization-error');
    expect(error).toHaveTextContent(/^Название не может быть пустым$/);
  });

  it('«Отмена» возвращает значения последнего ответа сервера', async () => {
    await renderLoaded(cardAndSubscription());
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-organization-edit'));
    await user.clear(screen.getByTestId('operator-organization-name'));
    await user.type(screen.getByTestId('operator-organization-name'), 'Черновик');
    await user.click(screen.getByTestId('operator-organization-cancel'));

    expect(screen.getByTestId('operator-organization-name')).toHaveTextContent(
      'ООО «Северный дом»',
    );

    await user.click(screen.getByTestId('operator-organization-edit'));
    expect(screen.getByTestId('operator-organization-name')).toHaveValue('ООО «Северный дом»');
  });

  it('на отправке «Сохранить» неактивна и говорит «Сохраняем…»', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    await renderLoaded(cardAndSubscription([() => pending]));
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-organization-edit'));
    await user.click(screen.getByTestId('operator-organization-save'));

    const save = screen.getByTestId('operator-organization-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Сохраняем…');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('operator-organization-cancel')).toBeEnabled();

    release({ status: 200, body: DETAILS });
    expect(await screen.findByTestId('operator-organization-edit')).toBeInTheDocument();
  });
});

describe('панель «Тариф и расширения»', () => {
  it('грузится своим запросом и не блокирует реквизиты', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    const network = await renderLoaded([{ status: 200, body: DETAILS }, () => pending]);

    expect(network.calls[1].url).toBe('/api/organizations/131/subscription');
    const loading = screen.getByTestId('operator-subscription-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Загружаем тариф…');
    // Реквизиты выше уже на экране: панель грузится отдельно от карточки.
    expect(screen.getByTestId('operator-organization-inn')).toHaveTextContent('7716234567');

    release({ status: 200, body: SUBSCRIPTION });
    expect(await screen.findByTestId('operator-subscription-tariff-name')).toHaveTextContent(
      'Домовой · 6 месяцев',
    );
  });

  it('отказ загрузки показывает detail дословно, «Повторить» перечитывает состояние', async () => {
    const network = await renderLoaded([
      { status: 200, body: DETAILS },
      { status: 502, body: { detail: 'Основной API недоступен' } },
      { status: 200, body: SUBSCRIPTION },
    ]);
    const user = userEvent.setup();

    const error = await screen.findByTestId('operator-subscription-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(screen.getByTestId('operator-organization-inn')).toHaveTextContent('7716234567');

    await user.click(screen.getByTestId('operator-subscription-retry'));

    expect(await screen.findByTestId('operator-subscription-tariff-name')).toHaveTextContent(
      'Домовой · 6 месяцев',
    );
    expect(network.calls.at(-1)?.url).toBe('/api/organizations/131/subscription');
  });

  it('действующий тариф: название, срок, остаток дней и разложение мест', async () => {
    await renderLoaded(cardAndSubscription());
    await screen.findByTestId('operator-subscription-tariff-name');

    expect(screen.getByTestId('operator-subscription-tariff-name')).toHaveTextContent(
      'Домовой · 6 месяцев',
    );
    expect(screen.getByTestId('operator-subscription-tariff-state')).toHaveTextContent(
      /^действует$/,
    );
    expect(screen.getByTestId('operator-subscription-tariff-until')).toHaveTextContent(
      'по 30.06.2027',
    );
    expect(screen.getByText('236')).toBeInTheDocument();
    expect(screen.getByText('дней осталось')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('мест: 5 по тарифу и 3 докуплено')).toBeInTheDocument();
  });

  it('оплаченный вперёд слот — отдельной строкой только для чтения', async () => {
    await renderReady({
      ...SUBSCRIPTION,
      next: {
        tariff: {
          ...SUBSCRIPTION.tariff,
          id: 22,
          name: 'Домовой · 12 месяцев',
          max_members: 10,
        },
        ends_at: '2028-06-30T20:59:59.999999Z',
        paid_until: '2028-06-30',
      },
    });

    const next = screen.getByTestId('operator-subscription-next');
    expect(next).toHaveTextContent('Оплачен вперёд:');
    expect(next).toHaveTextContent('Домовой · 12 месяцев, по 30.06.2028');
    // Будущий слот не правится и не снимается: кнопок внутри строки нет.
    expect(next.querySelector('button')).toBeNull();
  });

  it('истёкший тариф: «не действует», дата окончания и неактивное снятие', async () => {
    await renderReady({
      ...SUBSCRIPTION,
      tariff: { ...SUBSCRIPTION.tariff, paid_until: '2026-10-31', is_live: false },
      days_left: 0,
    });

    expect(screen.getByTestId('operator-subscription-tariff-state')).toHaveTextContent(
      /^не действует$/,
    );
    expect(screen.getByTestId('operator-subscription-tariff-until')).toHaveTextContent(
      'срок истёк 31.10.2026',
    );
    expect(screen.getByTestId('operator-subscription-tariff-deactivate')).toBeDisabled();
    // У истёкшего тарифа блока остатка нет: ноль ничего не добавляет.
    expect(screen.queryByText('дней осталось')).not.toBeInTheDocument();
  });

  it('бессрочный тариф говорит «бессрочно» и не рисует остаток дней', async () => {
    await renderReady({
      ...SUBSCRIPTION,
      tariff: { ...SUBSCRIPTION.tariff, ends_at: null, paid_until: null },
      extra_seats: 0,
      member_limit: 5,
    });

    expect(screen.getByTestId('operator-subscription-tariff-until')).toHaveTextContent('бессрочно');
    expect(screen.queryByText('дней осталось')).not.toBeInTheDocument();
    expect(screen.getByText('мест по тарифу')).toBeInTheDocument();
  });

  it('пустое состояние: «Тариф не назначен» и «Расширений нет»', async () => {
    await renderReady({
      tariff: null,
      days_left: 0,
      next: null,
      extra_seats: 0,
      member_limit: null,
      solutions: [],
    });

    expect(screen.getByTestId('operator-subscription-tariff-name')).toHaveTextContent(
      'Тариф не назначен',
    );
    expect(screen.getByTestId('operator-subscription-solutions-empty')).toHaveTextContent(
      'Расширений нет',
    );
    expect(screen.queryByTestId('operator-subscription-tariff-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-subscription-tariff-deactivate')).not.toBeInTheDocument();
  });

  it('расширения: действует по дате, бессрочно, не действует; у недействующего снятие неактивно', async () => {
    await renderLoaded(cardAndSubscription());
    await screen.findByTestId('operator-subscription-solutions');

    const states = screen.getAllByTestId('operator-subscription-solution-state');
    expect(states[0]).toHaveTextContent('действует по 14.02.2027');
    expect(states[1]).toHaveTextContent('бессрочно');
    expect(states[2]).toHaveTextContent('не действует');

    const buttons = screen.getAllByTestId('operator-subscription-solution-deactivate');
    expect(buttons[0]).toBeEnabled();
    expect(buttons[2]).toBeDisabled();
  });

  it('правка срока отправляет paid_until и показывает дату из ответа, а не из поля', async () => {
    const network = await renderLoaded(
      cardAndSubscription([
        {
          status: 200,
          body: { ...SUBSCRIPTION, tariff: { ...SUBSCRIPTION.tariff, paid_until: '2028-06-30' } },
        },
      ]),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('operator-subscription-tariff-edit'));
    const input = screen.getByTestId('operator-subscription-tariff-until-input');
    expect(input).toHaveValue('2027-06-30');
    fireEvent.change(input, { target: { value: '2027-01-15' } });
    await user.click(screen.getByTestId('operator-subscription-tariff-save'));

    expect(await screen.findByTestId('operator-subscription-tariff-edit')).toBeInTheDocument();
    expect(screen.getByTestId('operator-subscription-tariff-until')).toHaveTextContent(
      'по 30.06.2028',
    );

    const [patch] = network.calls.filter((call) => call.init.method === 'PATCH');
    expect(patch.url).toBe('/api/organizations/131/subscription');
    expect(JSON.parse(String(patch.init.body))).toEqual({ paid_until: '2027-01-15' });
    // Повторного чтения после действия нет: экран взял состояние из ответа.
    expect(network.calls.filter((call) => call.init.method === 'PATCH')).toHaveLength(1);
    expect(network.calls).toHaveLength(3);
  });

  it('отказ правки показывается дословно, значение не сбрасывается, поле помечено aria-invalid', async () => {
    await renderLoaded(
      cardAndSubscription([
        {
          status: 422,
          body: {
            detail: [
              {
                type: 'value_error',
                loc: ['body', 'paid_until'],
                msg: 'Value error, Укажите срок действия в формате ГГГГ-ММ-ДД',
              },
            ],
          },
        },
      ]),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('operator-subscription-tariff-edit'));
    fireEvent.change(screen.getByTestId('operator-subscription-tariff-until-input'), {
      target: { value: '2027-01-15' },
    });
    await user.click(screen.getByTestId('operator-subscription-tariff-save'));

    const error = await screen.findByTestId('operator-subscription-action-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(/^Укажите срок действия в формате ГГГГ-ММ-ДД$/);
    expect(screen.getByTestId('operator-subscription-tariff-until-input')).toHaveValue(
      '2027-01-15',
    );
    expect(screen.getByTestId('operator-subscription-tariff-until-input')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // Форма остаётся открытой: срок можно исправить и отправить снова.
    expect(screen.getByTestId('operator-subscription-tariff-cancel')).toBeInTheDocument();
  });

  it('на отправке срока «Сохранить» неактивна, поле заблокировано и говорит «Сохраняем…»', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    await renderLoaded(cardAndSubscription([() => pending]));
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('operator-subscription-tariff-edit'));
    await user.click(screen.getByTestId('operator-subscription-tariff-save'));

    const save = screen.getByTestId('operator-subscription-tariff-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Сохраняем…');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('operator-subscription-tariff-until-input')).toBeDisabled();

    release({ status: 200, body: SUBSCRIPTION });
    expect(await screen.findByTestId('operator-subscription-tariff-edit')).toBeInTheDocument();
  });

  it('снятие тарифа двухшаговое: запрос уходит только с «Подтвердить»', async () => {
    const network = await renderLoaded(
      cardAndSubscription([
        {
          status: 200,
          body: {
            ...SUBSCRIPTION,
            tariff: { ...SUBSCRIPTION.tariff, paid_until: '2026-11-06', is_live: false },
            days_left: 0,
          },
        },
      ]),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('operator-subscription-tariff-deactivate'));
    expect(
      screen.getByTestId('operator-subscription-tariff-deactivate-confirm'),
    ).toBeInTheDocument();
    // Пока подтверждения нет, запроса нет.
    expect(network.calls).toHaveLength(2);

    await user.click(screen.getByTestId('operator-subscription-tariff-deactivate-decline'));
    expect(screen.getByTestId('operator-subscription-tariff-deactivate')).toBeInTheDocument();
    expect(network.calls).toHaveLength(2);

    await user.click(screen.getByTestId('operator-subscription-tariff-deactivate'));
    await user.click(screen.getByTestId('operator-subscription-tariff-deactivate-confirm'));

    expect(await screen.findByText('срок истёк 06.11.2026')).toBeInTheDocument();
    const [call] = network.calls.slice(2);
    expect(call.url).toBe('/api/organizations/131/subscription/deactivate');
    expect(call.init.method).toBe('POST');
    // Состояние взято из ответа: повторного чтения нет.
    expect(network.calls).toHaveLength(3);
  });

  it('снятие права на расширение двухшаговое и обновляет строку ответом', async () => {
    const afterDeactivate = {
      ...SUBSCRIPTION,
      solutions: SUBSCRIPTION.solutions.map((right) =>
        right.code === 'telegram_notifications' ? { ...right, is_live: false } : right,
      ),
    };
    const network = await renderLoaded(
      cardAndSubscription([{ status: 200, body: afterDeactivate }]),
    );
    const user = userEvent.setup();

    await screen.findByTestId('operator-subscription-solutions');
    const buttons = screen.getAllByTestId('operator-subscription-solution-deactivate');
    await user.click(buttons[0]);
    expect(
      screen.getByTestId('operator-subscription-solution-deactivate-confirm'),
    ).toBeInTheDocument();
    expect(network.calls).toHaveLength(2);

    await user.click(screen.getByTestId('operator-subscription-solution-deactivate-confirm'));

    const states = await screen.findAllByTestId('operator-subscription-solution-state');
    expect(states[0]).toHaveTextContent('не действует');
    const [call] = network.calls.slice(2);
    expect(call.url).toBe('/api/organizations/131/solutions/telegram_notifications/deactivate');
    expect(call.init.method).toBe('POST');
  });

  it('отказ действия показывается под кнопками тарифа дословно', async () => {
    await renderLoaded(
      cardAndSubscription([{ status: 502, body: { detail: 'Основной API недоступен' } }]),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('operator-subscription-tariff-deactivate'));
    await user.click(screen.getByTestId('operator-subscription-tariff-deactivate-confirm'));

    const error = await screen.findByTestId('operator-subscription-action-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    // Отказ не мешает остальному экрану: расширения и кнопки тарифа на месте.
    expect(screen.getByTestId('operator-subscription-tariff-deactivate')).toBeInTheDocument();
    expect(screen.getByTestId('operator-subscription-solutions')).toBeInTheDocument();
  });
});
