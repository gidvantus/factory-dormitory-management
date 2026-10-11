import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { api, ApiError } from '../../api/client';
import type { Dormitory, Resident, ResidentTransferPreview } from '../../api/client';
import { mockTableFetch } from '../../test/tableColumns';
import { ResidentsTable } from './ResidentsTable';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const resident: Resident = {
  id: 3,
  gender: null,
  personnel_number: '123',
  full_name: 'Иванов Иван',
  hostel_id: null,
  hostel_name: null,
  shift_start: null,
  shift_count: null,
  shift_end: null,
  phone: null,
  medical_book: null,
  notes: null,
};
const dormitories: Dormitory[] = [7, 8, 9, 10].map((id) => ({
  id,
  name: `Общежитие ${id}`,
  client_name: `Клиент ${id}`,
  is_archived: id === 9,
  created_at: '2026-10-01T00:00:00Z',
}));

function plan(target = 8, loss = false): ResidentTransferPreview {
  return {
    target_dormitory_id: target,
    matched_columns: loss ? ['ФИО'] : ['ФИО', 'Т/н'],
    warnings: loss ? [{ column: 'Т/н', reason: 'В новом общежитии нет этого столбца' }] : [],
    empty_columns: [],
    preview_token: String(target).repeat(64),
  };
}

function setup() {
  mockTableFetch((url) =>
    url.includes('/residents?')
      ? { status: 200, body: { residents: [{ ...resident }], hostels: [] } }
      : { status: 404 },
  );
  vi.spyOn(api, 'dormitories').mockResolvedValue(dormitories);
  const preview = vi
    .spyOn(api, 'previewResidentTransfer')
    .mockImplementation(async (_source, _resident, target) => plan(target, target === 10));
  const transfer = vi.spyOn(api, 'transferResident').mockResolvedValue(resident);
  return { preview, transfer };
}

it('выбирает другое активное общежитие, переносит строку только после успеха и блокирует повтор во время запроса', async () => {
  const { transfer } = setup();
  let finish!: (value: Resident) => void;
  transfer.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  await user.click(within(row).getByRole('button', { name: 'Перевести' }));
  const dialog = screen.getByRole('dialog', { name: 'Перевести проживающего' });
  const selector = await within(dialog).findByRole('combobox', {
    name: 'В какое общежитие перевести',
  });
  expect(
    within(selector).queryByRole('option', { name: 'Общежитие 7 — Клиент 7' }),
  ).not.toBeInTheDocument();
  expect(
    within(selector).queryByRole('option', { name: 'Общежитие 9 — Клиент 9' }),
  ).not.toBeInTheDocument();
  await user.selectOptions(selector, '8');
  expect(
    await within(dialog).findByText('Все исходные поля совпадают. Данные можно перенести.'),
  ).toBeInTheDocument();
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  const button = within(dialog).getByRole('button', { name: 'Перевести' });
  await user.click(button);
  expect(row).toBeInTheDocument();
  expect(button).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Отмена' })).toBeDisabled();
  await user.click(button);
  expect(transfer).toHaveBeenCalledTimes(1);
  expect(transfer.mock.calls[0][0]).toBe('7');
  expect(transfer.mock.calls[0][1]).toBe(3);
  expect(transfer.mock.calls[0][2]).toBe(8);
  expect(transfer.mock.calls[0][4]).toBe('8'.repeat(64));
  expect(transfer.mock.calls[0][5]).toBe(false);
  await act(async () => finish(resident));
  await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Проживающий переведён в общежитие «Общежитие 8».',
  );
});

it('показывает несовпадающие столбцы, требует подтверждения, отменяет перевод и сохраняет строку при ошибке', async () => {
  const { transfer } = setup();
  transfer
    .mockRejectedValueOnce(new ApiError(503, 'Не удалось перевести'))
    .mockResolvedValue(resident);
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  const trigger = within(row).getByRole('button', { name: 'Перевести' });
  await user.click(trigger);
  let dialog = screen.getByRole('dialog');
  await user.selectOptions(await within(dialog).findByRole('combobox'), '10');
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Т/н: В новом общежитии нет этого столбца',
  );
  expect(within(dialog).getByRole('button', { name: 'Перевести' })).toBeDisabled();
  await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
  expect(transfer).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  expect(row).toBeInTheDocument();
  await user.click(trigger);
  dialog = screen.getByRole('dialog');
  await user.selectOptions(await within(dialog).findByRole('combobox'), '10');
  await user.click(
    await within(dialog).findByRole('checkbox', {
      name: 'Подтверждаю перевод без перечисленных полей',
    }),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Перевести' }));
  expect(await within(dialog).findByText('Не удалось перевести')).toBeInTheDocument();
  expect(within(row).getByRole('textbox', { name: 'Т/н, строка 1' })).toHaveValue('123');
  await user.click(within(dialog).getByRole('button', { name: 'Перевести' }));
  await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
  expect(transfer.mock.calls[1][5]).toBe(true);
});

it('после изменения данных повторяет сравнение и запрашивает новое подтверждение', async () => {
  const { preview, transfer } = setup();
  preview
    .mockResolvedValueOnce(plan())
    .mockResolvedValue({ ...plan(8, true), preview_token: 'a'.repeat(64) });
  transfer
    .mockRejectedValueOnce(
      new ApiError(409, 'Данные или столбцы изменились. Повторно проверьте перевод'),
    )
    .mockResolvedValue(resident);
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  await user.click(
    within(await screen.findByTestId('resident-3')).getByRole('button', { name: 'Перевести' }),
  );
  const dialog = screen.getByRole('dialog');
  await user.selectOptions(await within(dialog).findByRole('combobox'), '8');
  const button = within(dialog).getByRole('button', { name: 'Перевести' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  const checkbox = await within(dialog).findByRole('checkbox');
  expect(checkbox).not.toBeChecked();
  expect(button).toBeDisabled();
  expect(preview).toHaveBeenCalledTimes(2);
  expect(transfer).toHaveBeenCalledTimes(1);
  await user.click(checkbox);
  await user.click(button);
  await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
  expect(transfer.mock.calls[1][4]).toBe('a'.repeat(64));
  expect(transfer.mock.calls[1][5]).toBe(true);
});

it('не подменяет сравнение устаревшим ответом после смены выбранного общежития', async () => {
  const { preview, transfer } = setup();
  let finish!: (value: ResidentTransferPreview) => void;
  preview.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  await user.click(
    within(await screen.findByTestId('resident-3')).getByRole('button', { name: 'Перевести' }),
  );
  const dialog = screen.getByRole('dialog');
  const selector = await within(dialog).findByRole('combobox');
  await user.selectOptions(selector, '8');
  await user.selectOptions(selector, '10');
  await within(dialog).findByRole('checkbox');
  await act(async () => finish(plan(8)));
  expect(selector).toHaveValue('10');
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Т/н');
  expect(within(dialog).getByRole('button', { name: 'Перевести' })).toBeDisabled();
  expect(transfer).not.toHaveBeenCalled();
});

it('дожидается сохранения последнего ввода перед открытием окна перевода', async () => {
  setup();
  let finish!: (value: Resident) => void;
  vi.spyOn(api, 'updateResident').mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  const name = within(row).getByRole('textbox', { name: 'ФИО, строка 1' });
  await user.clear(name);
  await user.type(name, 'Новое имя');
  await user.click(within(row).getByRole('button', { name: 'Перевести' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => finish({ ...resident, full_name: 'Новое имя' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Новое имя')).toBeInTheDocument();
});
