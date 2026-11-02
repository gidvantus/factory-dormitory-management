import { render, screen } from '@testing-library/react';
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

describe('карточка организации кабинета оператора', () => {
  it('показывает реквизиты, счётчики и дату создания', async () => {
    const network = await renderLoaded([{ status: 200, body: DETAILS }]);

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
    const network = await renderLoaded([
      { status: 200, body: DETAILS },
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

    const [patch] = network.calls.slice(1);
    expect(patch.url).toBe('/api/organizations/131');
    expect(patch.init.method).toBe('PATCH');
    expect(JSON.parse(String(patch.init.body))).toEqual({
      name: 'ООО «Северный дом»',
      inn: '7716123456',
      kpp: '771601001',
      ogrn: '1237700123456',
      address: 'Ленинградский пр-т, 1',
    });
  });

  it('409 на занятый ИНН показывает текст дословно и не сбрасывает введённое', async () => {
    await renderLoaded([
      { status: 200, body: DETAILS },
      { status: 409, body: { detail: 'Организация с таким ИНН уже есть' } },
    ]);
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
    await renderLoaded([
      { status: 200, body: DETAILS },
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
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-organization-edit'));
    await user.clear(screen.getByTestId('operator-organization-name'));
    await user.click(screen.getByTestId('operator-organization-save'));

    const error = await screen.findByTestId('operator-organization-error');
    expect(error).toHaveTextContent(/^Название не может быть пустым$/);
  });

  it('«Отмена» возвращает значения последнего ответа сервера', async () => {
    await renderLoaded([{ status: 200, body: DETAILS }]);
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
    await renderLoaded([{ status: 200, body: DETAILS }, () => pending]);
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
