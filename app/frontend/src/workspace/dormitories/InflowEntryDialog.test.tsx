import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import type { InflowEntryForm, InflowRow, TableColumn } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import { InflowEntryDialog } from './InflowEntryDialog';

afterEach(() => vi.restoreAllMocks());

const column = (
  id: number,
  name: string,
  kind: TableColumn['kind'],
  builtin_key: string | null = null,
): TableColumn => ({
  id,
  name,
  kind,
  builtin_key,
  table_key: 'residents',
  position: id,
  archived: false,
  options: [],
});
const form: InflowEntryForm = {
  schema_token: 'a'.repeat(64),
  month: '2026-10-01',
  hostels: [{ id: 6, name: 'Корпус 1' }],
  columns: [
    column(1, 'Имя сотрудника', 'text', 'full_name'),
    column(2, 'Телефон для связи', 'text', 'phone'),
    column(3, 'Корпус', 'hostel', 'hostel_id'),
    column(4, 'Начало вахты', 'date', 'shift_start'),
    column(5, 'Конец вахты', 'date', 'shift_end'),
    column(6, 'Комната', 'text'),
    column(7, 'Размер', 'number'),
    column(8, 'Допуск', 'checkbox'),
    { ...column(9, 'Отдел', 'select'), options: [{ id: 'shop', label: 'Цех', archived: false }] },
  ],
};
const result: InflowRow = {
  id: 10,
  employee_id: 'person',
  full_name: 'Иванов Иван',
  personnel_number: null,
  settlement_date: null,
  citizenship: null,
  notes: null,
  shift_count: null,
};

function renderDialog(): ReturnType<typeof render> {
  return render(
    <InflowEntryDialog dormitoryId="7" month="2026-10-01" onClose={vi.fn()} onSaved={vi.fn()} />,
  );
}

it('показывает действующие поля и отправляет все типы значений вместе с проверенной личностью', async () => {
  vi.spyOn(api, 'inflowEntryForm').mockResolvedValue(form);
  vi.spyOn(personnelApi, 'check').mockResolvedValue({
    check_token: 'b'.repeat(64),
    candidates: [],
  });
  const create = vi.spyOn(api, 'createInflowEntry').mockResolvedValue(result);
  renderDialog();
  const user = userEvent.setup();
  const dialog = await screen.findByTestId('personnel-identity');
  expect(within(dialog).queryByLabelText('Табельный номер')).not.toBeInTheDocument();
  await user.type(within(dialog).getByLabelText('Имя сотрудника'), 'Иванов Иван');
  await user.type(within(dialog).getByLabelText('Телефон для связи'), '+79001234567');
  await user.selectOptions(within(dialog).getByLabelText('Корпус'), '6');
  fireEvent.change(within(dialog).getByLabelText('Начало вахты'), {
    target: { value: '2026-10-15' },
  });
  fireEvent.change(within(dialog).getByLabelText('Конец вахты'), {
    target: { value: '2026-11-14' },
  });
  await user.type(within(dialog).getByLabelText('Комната'), '205');
  await user.type(within(dialog).getByLabelText('Размер'), '42.5');
  await user.click(within(dialog).getByLabelText('Допуск'));
  await user.selectOptions(within(dialog).getByLabelText('Отдел'), 'shop');
  const save = within(dialog).getByRole('button', { name: 'Создать новую карточку' });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith('7', {
      month: '2026-10-01',
      schema_token: form.schema_token,
      identity: {
        full_name: 'Иванов Иван',
        phone: '+79001234567',
        personnel_number: null,
        mode: 'new',
        employee_id: null,
        check_token: 'b'.repeat(64),
      },
      values: {
        '1': 'Иванов Иван',
        '2': '+79001234567',
        '3': 6,
        '4': '2026-10-15',
        '5': '2026-11-14',
        '6': '205',
        '7': '42.5',
        '8': true,
        '9': 'shop',
      },
    }),
  );
});

it('после изменения столбцов обновляет форму и сохраняет введённые значения по ID', async () => {
  vi.spyOn(api, 'inflowEntryForm')
    .mockResolvedValueOnce(form)
    .mockResolvedValue({
      ...form,
      schema_token: 'c'.repeat(64),
      columns: [
        ...form.columns
          .filter((col) => col.id !== 7)
          .map((col) => (col.id === 6 ? { ...col, name: 'Номер комнаты' } : col)),
        column(10, 'Новые сведения', 'text'),
      ],
    });
  vi.spyOn(personnelApi, 'check').mockResolvedValue({
    check_token: 'b'.repeat(64),
    candidates: [],
  });
  const create = vi
    .spyOn(api, 'createInflowEntry')
    .mockRejectedValueOnce(new ApiError(409, 'Столбцы изменились'))
    .mockResolvedValue(result);
  renderDialog();
  const user = userEvent.setup();
  const dialog = await screen.findByTestId('personnel-identity');
  await user.type(within(dialog).getByLabelText('Имя сотрудника'), 'Иванов Иван');
  await user.type(within(dialog).getByLabelText('Комната'), '205');
  const save = within(dialog).getByRole('button', { name: 'Создать новую карточку' });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Столбцы изменились');
  expect(within(dialog).getByLabelText('Номер комнаты')).toHaveValue('205');
  expect(within(dialog).queryByLabelText('Размер')).not.toBeInTheDocument();
  await user.type(within(dialog).getByLabelText('Новые сведения'), 'Новое');
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1]![1]).toEqual(
    expect.objectContaining({
      schema_token: 'c'.repeat(64),
      values: expect.objectContaining({ '6': '205', '10': 'Новое' }),
    }),
  );
  expect(create.mock.calls[1]![1].values).not.toHaveProperty('7');
});
