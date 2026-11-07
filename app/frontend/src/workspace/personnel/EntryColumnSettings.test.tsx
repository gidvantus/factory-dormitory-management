import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type { Binding } from '../../api/personnel';
import { IdentityDialog } from './IdentityDialog';

afterEach(() => vi.restoreAllMocks());
const columns: Binding['columns'] = [
  { id: 12, name: 'Фамилия', kind: 'text', builtin_key: null },
  { id: 13, name: 'Контакт', kind: 'number', builtin_key: null, can_convert_to_text: true },
  { id: 14, name: 'Другой столбец', kind: 'text', builtin_key: null },
  { id: 15, name: 'Связанный', kind: 'text', builtin_key: null, has_fill: true },
];
function mockCheck(): void {
  vi.spyOn(personnelApi, 'check').mockResolvedValue({
    candidates: [],
    check_token: 'a'.repeat(64),
  });
}

it('выбирает назначения в модальном окне, сохраняет один раз и использует их при добавлении', async () => {
  mockCheck();
  let fields: Record<string, number> = {};
  let items = structuredClone(columns);
  vi.spyOn(personnelApi, 'binding').mockImplementation(async () => ({ fields, columns: items }));
  const save = vi
    .spyOn(personnelApi, 'saveBinding')
    .mockImplementation(async (_dorm, _table, next) => {
      fields = next;
      items = items.map((column) => (column.id === 13 ? { ...column, kind: 'text' } : column));
      return { ok: true };
    });
  const create = vi
    .spyOn(personnelApi, 'createRecord')
    .mockResolvedValue({ row_id: 1, employee_id: 'employee' });
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const { unmount } = render(
    <IdentityDialog dormitoryId="37" tableKey="residents" onClose={vi.fn()} onSaved={onSaved} />,
  );
  await user.type(screen.getByLabelText('ФИО'), 'Петров Пётр');
  await user.type(screen.getByLabelText('Телефон', { exact: true }), '+79001234567');
  const add = screen.getByRole('button', { name: 'Создать новую карточку' });
  expect(add).toBeDisabled();
  expect(screen.queryByRole('option', { name: 'Связанный' })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Столбец для ФИО'), '12');
  await user.selectOptions(screen.getByLabelText('Столбец для телефона'), '13');
  expect(screen.getByText(/числовой столбец телефона будет переведён/)).toBeInTheDocument();
  expect(add).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Сохранить назначение столбцов' }));
  expect(save).toHaveBeenCalledWith('37', 'residents', { full_name: 12, phone: 13 }, true);
  await waitFor(() => expect(add).toBeEnabled());
  await user.click(add);
  expect(create).toHaveBeenCalledWith(
    37,
    'residents',
    expect.objectContaining({ full_name: 'Петров Пётр', phone: '+79001234567' }),
    {},
    { full_name: 12, phone: 13 },
  );
  expect(onSaved).toHaveBeenCalledWith('employee');
  unmount();
  render(
    <IdentityDialog
      dormitoryId="37"
      tableKey="residents"
      initial={{ full_name: 'Следующий сотрудник' }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Создать новую карточку' })).toBeEnabled(),
  );
  expect(save).toHaveBeenCalledTimes(1);
  await user.click(screen.getByText('Куда записывать ФИО и телефон'));
  await user.selectOptions(screen.getByLabelText('Столбец для ФИО'), '14');
  expect(screen.getByRole('button', { name: 'Создать новую карточку' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Сохранить назначение столбцов' }));
  expect(save).toHaveBeenLastCalledWith('37', 'residents', { full_name: 14, phone: 13 }, false);
});

it('не создаёт скрытую запись при недоступном столбце и повторяет загрузку после ошибки', async () => {
  mockCheck();
  vi.spyOn(personnelApi, 'binding')
    .mockRejectedValueOnce(new ApiError(503, 'Не удалось загрузить столбцы'))
    .mockResolvedValue({ fields: { full_name: 99 }, columns });
  const create = vi.spyOn(personnelApi, 'createRecord');
  const user = userEvent.setup();
  render(
    <IdentityDialog
      dormitoryId="37"
      tableKey="residents"
      initial={{ full_name: 'Петров Пётр' }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить столбцы');
  expect(screen.getByRole('button', { name: 'Создать новую карточку' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
  expect(
    await screen.findByRole('option', { name: 'Столбец убран или недоступен' }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('ФИО')).toHaveValue('Петров Пётр');
  expect(screen.getByRole('button', { name: 'Создать новую карточку' })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});
