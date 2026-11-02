import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Users } from './Users';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

const FIRST_PAGE = {
  items: [
    {
      id: 142,
      email: 'e.zhuravleva@vostok-stroy.ru',
      full_name: 'Журавлёва Екатерина Сергеевна',
      is_active: true,
      organization_id: 7,
      organization_name: 'ООО «Восток-Строй»',
      role: 'owner',
      created_at: '2026-02-12T10:00:00',
    },
    {
      id: 137,
      email: 'd.lebedev@ural-byt.ru',
      full_name: 'Лебедев Дмитрий Олегович',
      is_active: false,
      organization_id: 9,
      organization_name: 'ООО «Уральский быт»',
      role: 'manager',
      created_at: '2026-02-10T10:00:00',
    },
    {
      // Учётная запись без организации: `organization_name` и `role` равны null.
      id: 133,
      email: 'a.prokhorov.rabota@yandex.ru',
      full_name: 'Прохоров Алексей Николаевич',
      is_active: true,
      organization_id: null,
      organization_name: null,
      role: null,
      created_at: '2026-02-01T10:00:00',
    },
  ],
  total: 3,
};

/** Список в настоящем роутере: переходы проверяем по подменённым экранам. */
function renderList(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/users']}>
        <Routes>
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id" element={<p data-testid="card-probe">Карточка</p>} />
          <Route path="/" element={<p data-testid="organizations-probe">Организации</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

describe('список пользователей кабинета оператора', () => {
  it('показывает строки, счётчик, роли и «—» вместо пустой организации', async () => {
    const network = renderList([{ status: 200, body: FIRST_PAGE }]);

    expect(await screen.findByTestId('operator-users')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-user-row')).toHaveLength(3);
    expect(screen.getByText('Журавлёва Екатерина Сергеевна')).toBeInTheDocument();
    expect(screen.getByText('3 пользователя')).toBeInTheDocument();
    expect(screen.getByText('Показано 3 из 3')).toBeInTheDocument();
    expect(screen.getByText('Владелец')).toBeInTheDocument();
    expect(screen.getByText('Менеджер')).toBeInTheDocument();
    // Организации и роли нет — тире, а не выдуманное слово.
    expect(screen.getAllByText('—')).toHaveLength(2);
    // Флаг активации: слово, а не только цвет точки.
    expect(screen.getByText('Не активирован')).toBeInTheDocument();
    expect(screen.getAllByText('Активирован')).toHaveLength(2);
    expect(screen.queryByTestId('operator-users-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-users-more')).not.toBeInTheDocument();

    const [call] = network.calls;
    expect(call.url).toBe('/api/users?limit=50&offset=0');
    // Сессия в httpOnly cookie: без credentials браузер её не отправит.
    expect(call.init.credentials).toBe('include');
  });

  it('пока идёт загрузка, показывает строку состояния и не показывает счётчик', () => {
    renderList([
      () =>
        new Promise(() => {
          // Ответ не приходит: проверяем именно состояние загрузки.
        }),
    ]);

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем пользователей…');
    expect(screen.queryByTestId('operator-users')).not.toBeInTheDocument();
    // Счётчик в шапке не показывается: `total` ещё неизвестен.
    expect(screen.queryByText(/^\d+ пользовател/)).not.toBeInTheDocument();
  });

  it('на пустой базе показывает «Пользователей пока нет»', async () => {
    renderList([{ status: 200, body: { items: [], total: 0 } }]);

    expect(await screen.findByTestId('operator-users-empty')).toBeInTheDocument();
    expect(screen.getByText('Пользователей пока нет')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ пользовател/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-users')).not.toBeInTheDocument();
  });

  it('на промахе поиска показывает «Ничего не найдено» и отправляет search', async () => {
    const network = renderList([
      { status: 200, body: FIRST_PAGE },
      { status: 200, body: { items: [], total: 0 } },
    ]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-users');
    await user.type(screen.getByTestId('operator-users-search'), 'щукин');

    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
    expect(
      screen.getByText(
        'По запросу «щукин» никого нет. Поиск идёт по ФИО и email, регистр не важен.',
      ),
    ).toBeInTheDocument();
    // Запрос остаётся в поле — оператор видит, что именно искал.
    expect(screen.getByTestId('operator-users-search')).toHaveValue('щукин');

    const search = network.calls[1];
    expect(decodeURIComponent(search.url)).toBe('/api/users?limit=50&offset=0&search=щукин');
  });

  it('отказ загрузки показывает текст detail дословно', async () => {
    renderList([{ status: 502, body: { detail: 'Основной API недоступен' } }]);

    const error = await screen.findByTestId('operator-users-error');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('operator-users')).not.toBeInTheDocument();
  });

  it('«Показать ещё» дописывает вторую страницу и исчезает на total', async () => {
    const network = renderList([
      { status: 200, body: { items: FIRST_PAGE.items.slice(0, 2), total: 3 } },
      { status: 200, body: { items: [FIRST_PAGE.items[2]], total: 3 } },
    ]);
    const user = userEvent.setup();

    const more = await screen.findByTestId('operator-users-more');
    expect(screen.getByText('Показано 2 из 3')).toBeInTheDocument();

    await user.click(more);

    expect(await screen.findByText('Прохоров Алексей Николаевич')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-user-row')).toHaveLength(3);
    expect(screen.getByText('Показано 3 из 3')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-users-more')).not.toBeInTheDocument();

    expect(network.calls[1].url).toBe('/api/users?limit=50&offset=2');
  });

  it('«Открыть» ведёт на карточку пользователя', async () => {
    renderList([{ status: 200, body: FIRST_PAGE }]);
    const user = userEvent.setup();

    const [open] = await screen.findAllByTestId('operator-user-open');
    await user.click(open);

    expect(await screen.findByTestId('card-probe')).toBeInTheDocument();
  });

  it('навигация ведёт на оба раздела и помечает текущий', async () => {
    renderList([{ status: 200, body: FIRST_PAGE }]);
    const user = userEvent.setup();

    const users = await screen.findByTestId('operator-nav-users');
    expect(users).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('operator-nav-organizations')).not.toHaveAttribute('aria-current');

    await user.click(screen.getByTestId('operator-nav-organizations'));

    expect(await screen.findByTestId('organizations-probe')).toBeInTheDocument();
  });
});
