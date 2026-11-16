import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DormitoryArrivalTable } from './DormitoryArrivalTable';
import { ColumnsContext } from './tableColumnsContext';
import { defaultTabOptions } from './customTabOptions';
import { mockFetch } from '../../test/mockFetch';
import type { CustomTab, TableColumn } from '../../api/client';

afterEach(() => vi.unstubAllGlobals());
const tab: CustomTab = {
  id: 2,
  dormitory_id: 37,
  name: 'Заезды',
  table_key: 'custom_2',
  table_created: true,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
  options: {
    ...defaultTabOptions,
    data_source: 'arrival_plan',
    period_mode: 'month',
    arrival_columns: { '1': 'full_name', '2': 'date', '3': 'status' },
  },
};
const columns: TableColumn[] = ['ФИО', 'Дата', 'Статус'].map((name, index) => ({
  id: index + 1,
  table_key: 'custom_2',
  name,
  kind: index === 1 ? 'date' : 'text',
  archived: false,
  position: index,
  options: [],
  builtin_key: null,
}));

it('перечитывает актуальный статус, передаёт выбранные даты и убирает ручной ввод', async () => {
  let status = 'Ожидается';
  const fetch = mockFetch((url) =>
    url.includes('arrival-rows')
      ? {
          status: 200,
          body: [
            {
              id: 'plan:person',
              date: '2026-11-15',
              custom_values: { '1': 'Иван Петров', '2': '2026-11-15', '3': status },
            },
          ],
        }
      : {
          status: 200,
          body: {
            revision: 0,
            state: { rows: [], columns: [], row_colors: {}, column_colors: {} },
          },
        },
  );
  render(
    <ColumnsContext.Provider
      value={{
        dormitoryId: '37',
        table: 'custom_2',
        columns,
        loading: false,
        error: '',
        reload: vi.fn(),
        edit: vi.fn(),
        values: {},
        saved: vi.fn(),
        trackSave: (_key, promise) => promise,
        waitForRowSaves: async () => {},
      }}
    >
      <DormitoryArrivalTable
        dormitoryId="37"
        tab={tab}
        range={{ from: '2026-11-01', to: '2026-11-30' }}
      />
    </ColumnsContext.Provider>,
  );
  expect(await screen.findByText('Иван Петров')).toBeInTheDocument();
  expect(screen.getByText('15.11.2026')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Добавить строку' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(
    fetch.mock.calls.some(([url]) =>
      String(url).endsWith('/tabs/2/arrival-rows?from=2026-11-01&to=2026-11-30&page=1'),
    ),
  ).toBe(true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Обновить' })).toBeEnabled());
  status = 'Не приехал';
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
  expect(await screen.findByText('Не приехал')).toBeInTheDocument();
  expect(screen.queryByText('Ожидается')).not.toBeInTheDocument();
});
