import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Dormitory } from '../../api/client';
import { mockTableFetch } from '../../test/tableColumns';
import { renderApp } from '../../test/renderApp';

afterEach(() => vi.unstubAllGlobals());

const initial: Dormitory = {
  id: 7,
  name: 'Северное',
  client_name: 'Клиент А',
  is_archived: false,
  created_at: '2026-10-01T09:00:00Z',
};

function setup(failFirst = false, otherDormitories: Dormitory[] = []) {
  let dormitory = { ...initial };
  let calls = 0;
  return mockTableFetch((url, init) => {
    if (url.endsWith('/api/me'))
      return {
        status: 200,
        body: { email: 'a@example.com', full_name: 'Пользователь', created_at: initial.created_at },
      };
    if (url.endsWith('/api/dormitories/7') && init?.method === 'PATCH') {
      calls += 1;
      if (failFirst && calls === 1)
        return { status: 503, body: { detail: 'Не удалось сохранить' } };
      dormitory = { ...dormitory, ...(JSON.parse(String(init.body)) as Partial<Dormitory>) };
      return { status: 200, body: dormitory };
    }
    if (url.endsWith('/api/dormitories'))
      return { status: 200, body: [dormitory, ...otherDormitories] };
    if (url.endsWith('/api/dormitories/7')) return { status: 200, body: dormitory };
    if (url.endsWith('/api/report-templates')) return { status: 200, body: [] };
    if (url.includes('/api/dormitories/7/report?')) return { status: 200, body: { rows: [] } };
    return { status: 404, body: {} };
  });
}

it('переименовывает карточку, переносит в архив после подтверждения и восстанавливает без потери перехода', async () => {
  const fetchMock = setup();
  const user = userEvent.setup();
  renderApp('/cabinet/dormitories');
  const card = await screen.findByTestId('dormitory-card-7');
  const item = screen.getByTestId('dormitory-item-7');
  expect(within(card).getByRole('button', { name: 'Редактировать' })).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'В архив' })).toBeInTheDocument();
  await user.click(within(item).getByRole('button', { name: 'Редактировать' }));
  let dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Название общежития')).toHaveValue('Северное');
  await user.clear(within(dialog).getByLabelText('Название общежития'));
  await user.type(within(dialog).getByLabelText('Название общежития'), 'Новое');
  await user.clear(within(dialog).getByLabelText('Название клиента'));
  await user.type(within(dialog).getByLabelText('Название клиента'), 'Клиент Б');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(card).toHaveTextContent('Клиент Б');
  expect(card).toHaveTextContent('Новое');
  await user.click(within(item).getByRole('button', { name: 'В архив' }));
  dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('продолжат учитываться на дашборде');
  await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
  expect(card).toHaveAttribute('data-archived', 'false');
  await user.click(within(item).getByRole('button', { name: 'В архив' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Перенести в архив' }),
  );
  await waitFor(() => expect(card).toHaveAttribute('data-archived', 'true'));
  expect(within(card).getByText('Архив')).toBeInTheDocument();
  await user.click(within(card).getByRole('link'));
  const details = await screen.findByTestId('dormitory-details-page');
  expect(
    await within(details).findByRole('heading', { name: 'Общежитие «Новое»' }),
  ).toBeInTheDocument();
  expect(within(details).getByText('Архив', { selector: 'span' })).toBeInTheDocument();
  expect(
    within(details).queryByRole('button', { name: /^(Редактировать|В архив|Восстановить)$/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByTestId('dormitory-back'));
  const returnedCard = await screen.findByTestId('dormitory-card-7');
  expect(returnedCard).toHaveAttribute('data-archived', 'true');
  await user.click(within(returnedCard).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(returnedCard).toHaveAttribute('data-archived', 'false'));
  expect(returnedCard).toHaveTextContent('Клиент Б');
  await user.click(within(returnedCard).getByRole('link'));
  const activeDetails = await screen.findByTestId('dormitory-details-page');
  await within(activeDetails).findByRole('heading', { name: 'Общежитие «Новое»' });
  expect(
    within(activeDetails).queryByRole('button', { name: /^(Редактировать|В архив|Восстановить)$/ }),
  ).not.toBeInTheDocument();
  const changes = fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init!.body)));
  expect(changes).toEqual([
    { name: 'Новое', client_name: 'Клиент Б' },
    { is_archived: true },
    { is_archived: false },
  ]);
});

it('показывает архивные карточки после активных при загрузке, архивировании и восстановлении', async () => {
  setup(false, [
    { ...initial, id: 8, name: 'Архивное', is_archived: true },
    { ...initial, id: 9, name: 'Активное' },
  ]);
  const user = userEvent.setup();
  renderApp('/cabinet/dormitories');
  const card = await screen.findByTestId('dormitory-card-7');
  const list = screen.getByRole('list', { name: 'Список общежитий' });
  const order = () =>
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('data-testid'));
  expect(order()).toEqual(['dormitory-item-7', 'dormitory-item-9', 'dormitory-item-8']);
  await user.click(within(card).getByRole('button', { name: 'В архив' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Перенести в архив' }),
  );
  await waitFor(() =>
    expect(order()).toEqual(['dormitory-item-9', 'dormitory-item-7', 'dormitory-item-8']),
  );
  await user.click(within(card).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() =>
    expect(order()).toEqual(['dormitory-item-7', 'dormitory-item-9', 'dormitory-item-8']),
  );
});

it('не сохраняет пустое название и сохраняет введённый текст при ошибке для повторной попытки', async () => {
  const fetchMock = setup(true);
  const user = userEvent.setup();
  renderApp('/cabinet/dormitories');
  const card = await screen.findByTestId('dormitory-card-7');
  await user.click(within(card).getByRole('button', { name: 'Редактировать' }));
  const dialog = screen.getByRole('dialog');
  const name = within(dialog).getByLabelText('Название общежития');
  await user.clear(name);
  await user.type(name, '   ');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Заполните');
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  await user.clear(name);
  await user.type(name, 'Изменённое');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Не удалось сохранить');
  expect(name).toHaveValue('Изменённое');
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(card).toHaveTextContent('Изменённое');
});
