import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CustomTab, TableColumn } from '../../api/client';
import { ApiError, api } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { ManageCustomTabsDialog } from './ManageCustomTabsDialog';
import { CustomTabTable } from './CustomTabTable';
import { currentMonth } from '../dashboard/dates';

const empty: CustomTab = {
  id: 9,
  dormitory_id: 7,
  name: 'Ошибочная',
  table_key: 'custom_9',
  table_created: true,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
};
const populated: CustomTab = {
  ...empty,
  id: 10,
  name: 'Документы',
  table_key: 'custom_10',
  has_data: true,
  delete_block_reason: 'Во вкладке есть записи за всё время.',
};
const columns: TableColumn[] = [
  {
    id: 101,
    table_key: 'custom_10',
    name: 'Статус',
    builtin_key: null,
    kind: 'select',
    position: 0,
    archived: false,
    options: [{ id: 'ready', label: 'Готов', archived: false }],
  },
  {
    id: 102,
    table_key: 'custom_10',
    name: 'Удалить',
    builtin_key: 'action_delete',
    kind: 'action',
    position: 1,
    archived: false,
    options: [],
  },
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function manager(overrides = {}): ReturnType<typeof render> {
  return render(
    <ManageCustomTabsDialog
      dormitoryId="7"
      onClose={vi.fn()}
      onLoaded={vi.fn()}
      onChanged={vi.fn()}
      onDeleted={vi.fn()}
      onOpen={vi.fn()}
      beforeChange={async () => undefined}
      {...overrides}
    />,
  );
}

it('проверяет свежие данные, удаляет пустую вкладку после подтверждения и показывает серверную ошибку', async () => {
  let deletion = 0;
  const onDeleted = vi.fn();
  const onLoaded = vi.fn();
  const fetch = mockFetch((url, init) => {
    if (url.endsWith('/tabs')) return { status: 200, body: [empty, populated] };
    if (url.endsWith('/tabs/9') && init?.method === 'DELETE')
      return ++deletion === 1
        ? { status: 409, body: { detail: 'Данные появились в другом окне.' } }
        : { status: 204 };
    return { status: 404 };
  });
  manager({ onDeleted, onLoaded });
  const user = userEvent.setup();
  const first = await screen.findByTestId('manage-tab-9');
  const second = screen.getByTestId('manage-tab-10');
  expect(within(second).getByRole('button', { name: 'Удалить' })).toBeDisabled();
  expect(onLoaded).toHaveBeenCalledWith([empty, populated]);
  await user.click(within(first).getByRole('button', { name: 'Удалить' }));
  expect(screen.getByText(/Удалить пустую вкладку «Ошибочная»/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  await user.click(screen.getByTestId('manage-tab-9').querySelectorAll('button')[2]);
  await user.click(screen.getByRole('button', { name: 'Удалить вкладку' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Данные появились в другом окне.');
  expect(onDeleted).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Удалить вкладку' }));
  await waitFor(() => expect(screen.queryByTestId('manage-tab-9')).not.toBeInTheDocument());
  expect(onDeleted).toHaveBeenCalledWith(9);
});

it('ожидает сохранения ячеек перед скрытием и блокирует повторное нажатие до ответа', async () => {
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const beforeChange = vi.fn(() => pending);
  const close = vi.fn(),
    changed = vi.fn();
  mockFetch((url, init) => {
    if (url.endsWith('/tabs')) return { status: 200, body: [populated] };
    expect(JSON.parse(String(init?.body))).toEqual({ is_active: false });
    return { status: 200, body: { ...populated, is_active: false } };
  });
  const patch = vi.spyOn(api, 'setCustomTabActive');
  manager({ beforeChange, onClose: close, onChanged: changed });
  const user = userEvent.setup();
  await user.click(
    within(await screen.findByTestId('manage-tab-10')).getByRole('button', { name: 'Скрыть' }),
  );
  expect(screen.getByText(/Данные сохранятся и продолжат учитываться/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Скрыть вкладку' }));
  expect(beforeChange).toHaveBeenCalledWith(10);
  expect(patch).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Сохраняем…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Закрыть окно' })).toBeDisabled();
  finishSave();
  await waitFor(() => expect(changed).toHaveBeenCalledWith({ ...populated, is_active: false }));
  expect(patch).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Скрыта · только просмотр')).toBeInTheDocument();
});

it('не скрывает вкладку при ошибке сохранения и позволяет восстановить скрытую', async () => {
  const beforeChange = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(422, 'Сначала исправьте ячейку.'))
    .mockResolvedValue(undefined);
  let hidden = false;
  mockFetch((url, init) => {
    if (url.endsWith('/tabs')) return { status: 200, body: [populated] };
    hidden = !JSON.parse(String(init?.body)).is_active;
    return { status: 200, body: { ...populated, is_active: !hidden } };
  });
  manager({ beforeChange });
  const user = userEvent.setup();
  await user.click(
    within(await screen.findByTestId('manage-tab-10')).getByRole('button', { name: 'Скрыть' }),
  );
  await user.click(screen.getByRole('button', { name: 'Скрыть вкладку' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Сначала исправьте ячейку.');
  expect(hidden).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Скрыть вкладку' }));
  await user.click(await screen.findByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(screen.getByText('Активна')).toBeInTheDocument());
  expect(hidden).toBe(false);
});

it('повторяет неудачную загрузку списка и показывает скрытые вкладки для просмотра', async () => {
  let attempt = 0;
  const open = vi.fn();
  mockFetch(() =>
    ++attempt === 1
      ? { status: 503, body: { detail: 'Ошибка загрузки' } }
      : { status: 200, body: [{ ...populated, is_active: false }] },
  );
  manager({ onOpen: open });
  const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка загрузки');
  await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
  await user.click(await screen.findByRole('button', { name: 'Просмотреть' }));
  expect(open).toHaveBeenCalledWith({ ...populated, is_active: false });
});

it('открывает скрытую таблицу без возможности изменять строки, значения и столбцы', async () => {
  const fetch = mockFetch((url) => {
    if (url.includes('/personnel/bindings/'))
      return { status: 200, body: { fields: {}, columns: [] } };
    return url.endsWith('/columns')
      ? { status: 200, body: columns }
      : { status: 200, body: [{ id: 20, custom_values: { '101': 'ready' } }] };
  });
  render(
    <CustomTabTable
      range={currentMonth()}
      dormitoryId="7"
      tab={{ ...populated, is_active: false }}
      onChanged={vi.fn()}
    />,
  );
  expect(await screen.findByLabelText('Статус, строка 20')).toHaveValue('ready');
  expect(screen.getByLabelText('Статус, строка 20')).toBeDisabled();
  expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Удалить' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '+ Добавить столбец' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Настроить столбцы' })).not.toBeInTheDocument();
  expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('убирает скрытую вкладку из навигации, позволяет просмотреть и восстановить её', async () => {
  let item = { ...populated, is_active: false };
  mockFetch((url, init) => {
    if (url === '/api/me')
      return {
        status: 200,
        body: { email: 'test@example.com', full_name: 'Тест', is_active: true },
      };
    if (url === '/api/dormitories/7')
      return { status: 200, body: { id: 7, name: 'Северное', client_name: 'Клиент' } };
    if (url.endsWith('/tabs')) return { status: 200, body: [item] };
    if (url.endsWith('/settings')) {
      if (init?.method === 'PUT') item = { ...item, is_active: true };
      return {
        status: 200,
        body: {
          revision: 'a'.repeat(64),
          tabs: [item],
          sections: [],
          tables: { custom_10: columns.map((column) => ({ ...column, used_by: [] })) },
          rules: [],
        },
      };
    }
    if (url.endsWith('/columns')) return { status: 200, body: columns };
    if (url.includes('/personnel/bindings/'))
      return { status: 200, body: { fields: {}, columns: [] } };
    if (url.endsWith('/tabs/10/rows'))
      return { status: 200, body: [{ id: 20, custom_values: { '101': 'ready' } }] };
    if (url.includes('/report?')) return { status: 200, body: { rows: [] } };
    return { status: 404 };
  });
  renderApp('/cabinet/dormitories/7/report');
  const user = userEvent.setup();
  const manage = await screen.findByRole('button', { name: 'Настроить' });
  await waitFor(() => expect(manage).toBeEnabled());
  expect(screen.queryByTestId('dormitory-custom-tab-10')).not.toBeInTheDocument();
  await user.click(manage);
  await user.click(await screen.findByRole('button', { name: /Документы/ }));
  await user.click(screen.getByRole('button', { name: 'Открыть таблицу ↗' }));
  expect(await screen.findByLabelText('Статус, строка 20')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Настроить' }));
  await user.click(await screen.findByRole('button', { name: 'Восстановить вкладку' }));
  await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await screen.findByText('Изменения сохранены');
  expect(await screen.findByTestId('dormitory-custom-tab-10')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await user.click(screen.getByRole('button', { name: 'Закрыть окно' }));
  expect(screen.getByLabelText('Статус, строка 20')).toBeEnabled();
  expect(screen.getByRole('button', { name: '+ Добавить строку' })).toBeEnabled();
});
