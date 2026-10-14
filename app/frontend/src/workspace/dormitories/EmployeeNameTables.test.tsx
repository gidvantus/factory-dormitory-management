import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { CustomTab, TableColumn } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type { Employee, PersonnelData, SourceTable } from '../../api/personnel';
import { defaultColumns } from '../../test/tableColumns';
import { ArchiveTable } from './ArchiveTable';
import { CustomTabTable } from './CustomTabTable';
import { InflowTable } from './InflowTable';
import { OutflowTable } from './OutflowTable';
import { SettingsContext } from './settingsContext';

afterEach(() => vi.restoreAllMocks());
const range = { from: '2026-10-01', to: '2026-10-31' };
const tab: CustomTab = {
  id: 9,
  dormitory_id: 7,
  name: 'Документы',
  table_key: 'custom_9',
  table_created: true,
  is_active: true,
  has_data: true,
  delete_block_reason: null,
};
const identity = { full_name: 'Иванов Иван', personnel_number: null, phone: '+79001234567' };
const row = {
  id: 20,
  employee_id: 'person',
  ...identity,
  created_at: '2026-10-14T10:00:00Z',
  settlement_date: null,
  citizenship: null,
  notes: null,
  shift_count: null,
  departure_date: null,
  shift_start: null,
  reason: null,
  additional_info: null,
  custom_values: { '101': identity.full_name, '102': identity.phone },
};

function fixtures(
  table: SourceTable,
  { hidden = false, unbound = false, unlinked = false } = {},
): void {
  const columns: TableColumn[] =
    table === 'inflow' || table === 'outflow'
      ? defaultColumns(table)
      : [
          {
            id: 101,
            table_key: table,
            builtin_key: null,
            name: 'Имя работника',
            kind: 'text',
            position: 0,
            archived: hidden,
            options: [],
          },
          {
            id: 102,
            table_key: table,
            builtin_key: null,
            name: 'Контакт',
            kind: 'text',
            position: 1,
            archived: false,
            options: [],
          },
          {
            id: 103,
            table_key: table,
            builtin_key: 'action_delete',
            name: 'Удалить',
            kind: 'action',
            position: 2,
            archived: false,
            options: [],
          },
        ];
  vi.spyOn(api, 'tableColumns').mockResolvedValue(columns);
  vi.spyOn(api, 'outflowFields').mockResolvedValue({
    reason_column: null,
    departure_column: null,
    reasons: [],
  });
  vi.spyOn(personnelApi, 'binding').mockResolvedValue({
    fields: unbound ? {} : { full_name: 101, phone: 102 },
    columns,
  });
  const record = { ...row, employee_id: unlinked ? null : 'person' };
  vi.spyOn(api, 'inflow').mockResolvedValue([record]);
  vi.spyOn(api, 'outflow').mockResolvedValue([record]);
  vi.spyOn(api, 'archive').mockResolvedValue([record]);
  vi.spyOn(api, 'customTabRows').mockResolvedValue([record]);
  const source = {
    table_key: table,
    row_id: 20,
    dormitory_id: 7,
    source_name: 'Исходная таблица',
    values: { ...identity },
  };
  const employee: Employee = {
    id: 'person',
    member_ids: ['person'],
    ...identity,
    identity_status: 'confirmed',
    current: [],
    sources: [source],
    history_dormitory_ids: [7],
    variants: {},
  };
  const data: PersonnelData = {
    today: '2026-10-14',
    dormitories: [{ id: 7, name: 'Северное', client_name: 'Завод', is_archived: false }],
    employees: [employee],
    plans: [],
    arrival_plans: [],
    decisions: [],
    preferences: { revision: 0, blocks: [], lists: [] },
  };
  vi.spyOn(personnelApi, 'workspace').mockResolvedValue(data);
  vi.spyOn(personnelApi, 'detail').mockResolvedValue({
    employee_id: 'person',
    notes: [],
    events: [],
    merges: [],
  });
}

function renderTable(table: SourceTable): void {
  const component =
    table === 'inflow' ? (
      <InflowTable dormitoryId="7" range={range} />
    ) : table === 'outflow' ? (
      <OutflowTable dormitoryId="7" range={range} />
    ) : table === 'archive' ? (
      <ArchiveTable dormitoryId="7" range={range} />
    ) : (
      <CustomTabTable dormitoryId="7" tab={tab} onChanged={vi.fn()} />
    );
  function Location(): JSX.Element {
    return <output data-testid="location">{useLocation().pathname}</output>;
  }
  render(
    <MemoryRouter initialEntries={['/table']}>
      <SettingsContext.Provider value={{ open: vi.fn(), revision: 0, readOnly: false }}>
        {component}
        <Location />
      </SettingsContext.Provider>
    </MemoryRouter>,
  );
}

it.each(['inflow', 'outflow', 'archive', 'custom_9'] as const)(
  '%s: открывает карточку по ФИО поверх таблицы и редактирует имя карандашом',
  async (table) => {
    fixtures(table);
    const standard = table === 'inflow' || table === 'outflow';
    const save = standard
      ? vi
          .spyOn(api, table === 'inflow' ? 'updateInflowRow' : 'updateOutflowRow')
          .mockResolvedValue({ ...row, full_name: 'Иванов Илья' })
      : vi.spyOn(api, 'saveCustomCell').mockResolvedValue({ value: 'Иванов Илья' });
    renderTable(table);
    const user = userEvent.setup();
    const name = await screen.findByRole('link', { name: identity.full_name });
    const tableRow = name.closest('tr')!;
    expect(
      within(tableRow).queryByText(/Карточка|Изменить связь|Связать с сотрудником/),
    ).not.toBeInTheDocument();
    await user.click(name);
    const card = await screen.findByTestId('personnel-profile');
    expect(within(card).getByRole('heading', { name: identity.full_name })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Изменить связь' })).toBeInTheDocument();
    expect(tableRow).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/table');
    await user.click(within(card).getByRole('button', { name: /Закрыть/ }));
    expect(name).toHaveFocus();
    const label = standard ? 'ФИО' : 'Имя работника';
    await user.click(
      within(tableRow).getByRole('button', { name: `Редактировать ${label}, строка 20` }),
    );
    const input = within(tableRow).getByRole('textbox', { name: `${label}, строка 20` });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Иванов Илья{Enter}');
    expect(await within(tableRow).findByRole('link', { name: 'Иванов Илья' })).toHaveAttribute(
      'href',
      '/cabinet/personnel?employee=person',
    );
    expect(save).toHaveBeenCalledWith(
      '7',
      ...(standard ? [20, 'full_name', 'Иванов Илья'] : [table, 20, 101, 'Иванов Илья']),
    );
  },
);

it.each(['archive', 'custom_9'] as const)(
  '%s: сохраняет доступ к карточке при скрытом столбце ФИО',
  async (table) => {
    fixtures(table, { hidden: true });
    renderTable(table);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия, строка 20' }));
    await user.click(screen.getByRole('button', { name: 'Открыть сотрудника' }));
    const card = await screen.findByTestId('personnel-profile');
    expect(screen.queryByRole('button', { name: 'Открыть сотрудника' })).not.toBeInTheDocument();
    expect(within(card).getByRole('heading', { name: identity.full_name })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Закрыть/ }));
    expect(screen.getByRole('button', { name: 'Действия, строка 20' })).toHaveFocus();
  },
);

it('находит карточку по исходной строке, если сохранение пользовательской ячейки не вернуло employee_id', async () => {
  fixtures('custom_9', { unlinked: true });
  renderTable('custom_9');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name: identity.full_name }));
  expect(await screen.findByTestId('personnel-profile')).toBeInTheDocument();
  expect(screen.queryByTestId('personnel-identity')).not.toBeInTheDocument();
});

it('не теряет черновик имени в пользовательской таблице после ошибки сохранения', async () => {
  fixtures('custom_9');
  const save = vi
    .spyOn(api, 'saveCustomCell')
    .mockRejectedValueOnce(new ApiError(503, 'Ошибка сохранения'))
    .mockResolvedValueOnce({ value: 'Иванов Илья' });
  renderTable('custom_9');
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Редактировать Имя работника, строка 20' }),
  );
  const input = screen.getByRole('textbox', { name: 'Имя работника, строка 20' });
  await user.clear(input);
  await user.type(input, 'Иванов Илья{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка сохранения');
  expect(input).toHaveValue('Иванов Илья');
  await user.click(input);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('link', { name: 'Иванов Илья' })).toBeInTheDocument();
});
