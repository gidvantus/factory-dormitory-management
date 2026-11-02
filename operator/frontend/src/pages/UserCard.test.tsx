import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { UserCard } from './UserCard';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

const USER = {
  id: 142,
  email: 'e.zhuravleva@vostok-stroy.ru',
  full_name: 'Журавлёва Екатерина Сергеевна',
  is_active: true,
  organization_id: 7,
  organization_name: 'ООО «Восток-Строй»',
  role: 'owner',
  created_at: '2026-02-12T10:00:00',
};

/** Карточка в настоящем роутере: переход «К списку» проверяем по подмене. */
function renderCard(steps: MockStep[], id = '142') {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={[`/users/${id}`]}>
        <Routes>
          <Route path="/users/:id" element={<UserCard />} />
          <Route path="/users" element={<p data-testid="list-probe">Список пользователей</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

/** Открыть карточку и дождаться просмотра. */
async function renderLoaded(steps: MockStep[]) {
  const network = renderCard(steps);
  await screen.findByTestId('operator-user-card');
  return network;
}

describe('карточка пользователя кабинета оператора', () => {
  it('показывает ФИО, реквизиты, состояние и дату создания', async () => {
    const network = await renderLoaded([{ status: 200, body: USER }]);

    expect(screen.getByTestId('operator-user-full-name')).toHaveTextContent(
      'Журавлёва Екатерина Сергеевна',
    );
    expect(screen.getByTestId('operator-user-email')).toHaveTextContent(
      'e.zhuravleva@vostok-stroy.ru',
    );
    expect(screen.getByTestId('operator-user-organization')).toHaveTextContent(
      'ООО «Восток-Строй»',
    );
    expect(screen.getByTestId('operator-user-role')).toHaveTextContent('Владелец');
    expect(screen.getByTestId('operator-user-active')).toHaveTextContent('Активирован');
    expect(screen.getByText(/Пользователь №142 · создан 12 февраля 2026/)).toBeInTheDocument();
    expect(screen.getByTestId('operator-user-edit')).toBeInTheDocument();
    // Поля ввода в просмотре нет: правится только ФИО и только в правке.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    expect(network.calls[0].url).toBe('/api/users/142');
    expect(network.calls[0].init.credentials).toBe('include');
  });

  it('у неактивированной учётной записи пишет «Не активирован»', async () => {
    await renderLoaded([{ status: 200, body: { ...USER, is_active: false } }]);

    expect(screen.getByTestId('operator-user-active')).toHaveTextContent('Не активирован');
    // Слова «заблокирован» в интерфейсе нет ни в одном регистре.
    expect(screen.queryByText(/заблокирован/i)).not.toBeInTheDocument();
  });

  it('прямой заход на несуществующий номер показывает «Пользователь не найден»', async () => {
    renderCard([{ status: 404, body: { detail: 'Пользователь не найден' } }], '999999');
    const user = userEvent.setup();

    expect(await screen.findByText('Пользователь не найден')).toBeInTheDocument();
    expect(screen.getByText('Пользователь №999999')).toBeInTheDocument();

    await user.click(screen.getByTestId('operator-user-back'));

    expect(await screen.findByTestId('list-probe')).toBeInTheDocument();
  });

  it('отказ загрузки показывает текст detail дословно', async () => {
    renderCard([{ status: 502, body: { detail: 'Основной API недоступен' } }]);

    const error = await screen.findByTestId('operator-user-error');
    expect(error).toHaveTextContent(/^Основной API недоступен$/);
    expect(screen.queryByTestId('operator-user-card')).not.toBeInTheDocument();
  });

  it('сохранение отправляет только ФИО и показывает ответ сервера', async () => {
    const network = await renderLoaded([
      { status: 200, body: USER },
      { status: 200, body: { ...USER, full_name: 'Иванова Екатерина Сергеевна' } },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-user-edit'));
    await user.clear(screen.getByTestId('operator-user-full-name'));
    await user.type(screen.getByTestId('operator-user-full-name'), 'Иванова Екатерина Сергеевна');
    await user.click(screen.getByTestId('operator-user-save'));

    expect(await screen.findByTestId('operator-user-edit')).toBeInTheDocument();
    expect(screen.getByTestId('operator-user-full-name')).toHaveTextContent(
      'Иванова Екатерина Сергеевна',
    );

    const [, patch] = network.calls;
    expect(patch.url).toBe('/api/users/142');
    expect(patch.init.method).toBe('PATCH');
    // В теле ровно одно поле: email, роль, организация и активность не отправляются.
    expect(JSON.parse(String(patch.init.body))).toEqual({
      full_name: 'Иванова Екатерина Сергеевна',
    });
  });

  it('422 показывает «ФИО не может быть пустым» дословно и не сбрасывает введённое', async () => {
    await renderLoaded([
      { status: 200, body: USER },
      {
        status: 422,
        body: {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'full_name'],
              msg: 'Value error, ФИО не может быть пустым',
            },
          ],
        },
      },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-user-edit'));
    await user.clear(screen.getByTestId('operator-user-full-name'));
    await user.type(screen.getByTestId('operator-user-full-name'), ' ');
    await user.click(screen.getByTestId('operator-user-save'));

    const error = await screen.findByTestId('operator-user-error');
    expect(error).toHaveTextContent(/^ФИО не может быть пустым$/);
    expect(error).toHaveAttribute('role', 'alert');
    // Введённое не сбрасывается, поле помечено ошибкой, фокус остаётся в форме.
    expect(screen.getByTestId('operator-user-full-name')).toHaveValue(' ');
    expect(screen.getByTestId('operator-user-full-name')).toHaveAttribute('aria-invalid', 'true');
    expect(error).toHaveFocus();
    // Форма остаётся открытой: правку можно исправить и отправить снова.
    expect(screen.getByTestId('operator-user-cancel')).toBeInTheDocument();
  });

  it('«Отмена» возвращает значение последнего ответа сервера', async () => {
    await renderLoaded([{ status: 200, body: USER }]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-user-edit'));
    await user.clear(screen.getByTestId('operator-user-full-name'));
    await user.type(screen.getByTestId('operator-user-full-name'), 'Черновик');
    await user.click(screen.getByTestId('operator-user-cancel'));

    expect(screen.getByTestId('operator-user-full-name')).toHaveTextContent(
      'Журавлёва Екатерина Сергеевна',
    );

    await user.click(screen.getByTestId('operator-user-edit'));
    expect(screen.getByTestId('operator-user-full-name')).toHaveValue(
      'Журавлёва Екатерина Сергеевна',
    );
  });

  it('на отправке «Сохранить» неактивна и говорит «Сохраняем…»', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    await renderLoaded([{ status: 200, body: USER }, () => pending]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-user-edit'));
    await user.click(screen.getByTestId('operator-user-save'));

    const save = screen.getByTestId('operator-user-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Сохраняем…');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('operator-user-cancel')).toBeEnabled();

    release({ status: 200, body: USER });
    expect(await screen.findByTestId('operator-user-edit')).toBeInTheDocument();
  });
});
