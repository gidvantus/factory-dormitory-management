import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Organizations } from './Organizations';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

const FIRST_PAGE = {
  items: [
    { id: 131, name: 'ООО «Северный дом»', inn: '7716234567', created_at: '2026-03-14T10:00:00' },
    { id: 130, name: null, inn: null, created_at: '2026-03-02T10:00:00' },
  ],
  total: 2,
};

/** Список в настоящем роутере: открытие карточки проверяем по подменённому экрану. */
function renderList(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Organizations />} />
          <Route path="/organizations/:id" element={<p data-testid="card-probe">Карточка</p>} />
          <Route path="/login" element={<p data-testid="login-probe">Форма входа</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

describe('список организаций кабинета оператора', () => {
  it('показывает строки, счётчик и «Без названия» вместо пустого названия', async () => {
    const network = renderList([{ status: 200, body: FIRST_PAGE }]);

    expect(await screen.findByTestId('operator-organizations')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-organization-row')).toHaveLength(2);
    expect(screen.getByText('ООО «Северный дом»')).toBeInTheDocument();
    // Организация-заготовка: `name` и `inn` в API равны null.
    expect(screen.getByText('Без названия')).toBeInTheDocument();
    expect(screen.getByText('2 организации')).toBeInTheDocument();
    expect(screen.getByText('Показано 2 из 2')).toBeInTheDocument();
    expect(screen.getByText('14.03.2026')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-organizations-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operator-organizations-more')).not.toBeInTheDocument();

    const [call] = network.calls;
    expect(call.url).toBe('/api/organizations?limit=50&offset=0');
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

    expect(screen.getByRole('status')).toHaveTextContent('Загружаем организации…');
    expect(screen.queryByTestId('operator-organizations')).not.toBeInTheDocument();
    // Счётчик total в шапке не показывается: он ещё неизвестен.
    expect(screen.queryByText(/^\d+ организаци[яйи]/)).not.toBeInTheDocument();
  });

  it('на пустом ответе показывает «Организаций пока нет»', async () => {
    renderList([{ status: 200, body: { items: [], total: 0 } }]);

    expect(await screen.findByTestId('operator-organizations-empty')).toBeInTheDocument();
    expect(screen.getByText('Организаций пока нет')).toBeInTheDocument();
    expect(screen.getByText('0 организаций')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-organizations')).not.toBeInTheDocument();
  });

  it('отказ загрузки показывает текст detail дословно', async () => {
    renderList([{ status: 502, body: { detail: 'Основной API недоступен' } }]);

    const error = await screen.findByTestId('operator-organizations-error');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('operator-organizations')).not.toBeInTheDocument();
  });

  it('«Показать ещё» дописывает вторую страницу и исчезает на total', async () => {
    const network = renderList([
      { status: 200, body: { items: FIRST_PAGE.items, total: 3 } },
      {
        status: 200,
        body: {
          items: [
            { id: 129, name: 'АО «Общежитие-Сервис»', inn: '5024123456', created_at: '2026-02-21' },
          ],
          total: 3,
        },
      },
    ]);
    const user = userEvent.setup();

    const more = await screen.findByTestId('operator-organizations-more');
    expect(screen.getByText('Показано 2 из 3')).toBeInTheDocument();

    await user.click(more);

    expect(await screen.findByText('АО «Общежитие-Сервис»')).toBeInTheDocument();
    expect(screen.getAllByTestId('operator-organization-row')).toHaveLength(3);
    expect(screen.getByText('Показано 3 из 3')).toBeInTheDocument();
    expect(screen.queryByTestId('operator-organizations-more')).not.toBeInTheDocument();

    expect(network.calls[1].url).toBe('/api/organizations?limit=50&offset=2');
  });

  it('«Открыть» ведёт на карточку организации', async () => {
    renderList([{ status: 200, body: FIRST_PAGE }]);
    const user = userEvent.setup();

    const [open] = await screen.findAllByTestId('operator-organization-open');
    await user.click(open);

    expect(await screen.findByTestId('card-probe')).toBeInTheDocument();
  });

  it('«Выйти» в шапке гасит сессию и возвращает на форму входа', async () => {
    const network = renderList([{ status: 200, body: FIRST_PAGE }, { status: 204 }]);
    const user = userEvent.setup();

    await screen.findByTestId('operator-organizations');
    await user.click(screen.getByTestId('operator-logout'));

    expect(await screen.findByTestId('login-probe')).toBeInTheDocument();
    expect(network.calls[1].url).toBe('/api/auth/logout');
    expect(network.calls[1].init.method).toBe('POST');
  });
});
