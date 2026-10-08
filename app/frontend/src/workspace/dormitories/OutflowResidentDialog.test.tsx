import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { api, ApiError } from '../../api/client';
import type { OutflowRow, Resident, ResidentOutflowPreview } from '../../api/client';
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
const outflow: OutflowRow = {
  id: 9,
  departure_date: null,
  personnel_number: '123',
  full_name: 'Иванов Иван',
  shift_start: null,
  reason: null,
  notes: null,
  additional_info: null,
};

function plan(loss = true): ResidentOutflowPreview {
  return {
    matched_columns: ['ФИО', 'Т/н'],
    warnings: loss
      ? [{ column: 'Личный столбец', reason: 'В таблице «Отток» нет этого столбца' }]
      : [],
    empty_columns: ['Дата выезда', 'Причина'],
    departure_date: null,
    payments_to_delete: { advance: 1, settlement: 2 },
    preview_token: 'a'.repeat(64),
  };
}

function setup(loss = true) {
  mockTableFetch((url) =>
    url.includes('/residents?')
      ? { status: 200, body: { residents: [{ ...resident }], hostels: [] } }
      : { status: 404 },
  );
  const preview = vi.spyOn(api, 'previewResidentOutflow').mockResolvedValue(plan(loss));
  const move = vi.spyOn(api, 'moveResidentToOutflow').mockResolvedValue(outflow);
  return { preview, move };
}

it('показывает только подтверждение, позволяет отменить и переносит при несовпадении столбцов', async () => {
  const { preview, move } = setup();
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  const trigger = within(row).getByRole('button', { name: 'Отток' });
  await user.click(trigger);
  let dialog = screen.getByRole('dialog', { name: 'Перенести в отток' });
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
  expect(dialog).toHaveTextContent('Перенести «Иванов Иван» в «Отток»?');
  expect(dialog).toHaveTextContent('из «Проживающих» и списков аванса и расчёта');
  expect(dialog).not.toHaveTextContent('Личный столбец');
  expect(dialog).not.toHaveTextContent('Дата выезда');
  expect(dialog).not.toHaveTextContent('Удалим записей');
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Перенести в отток' })).toBeEnabled(),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
  expect(move).not.toHaveBeenCalled();
  expect(row).toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Перенести в отток' })).toBeEnabled(),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Перенести в отток' }));
  await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
  expect(move).toHaveBeenCalledWith('7', 3, 'a'.repeat(64), true);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Проживающий перенесён в «Отток». Его записи на аванс и расчёт удалены.',
  );
});

it('блокирует повторные нажатия и закрытие до ответа сервера', async () => {
  const { preview, move } = setup(false);
  preview.mockResolvedValue({ ...plan(false), departure_date: '2026-10-15' });
  let finish!: (value: OutflowRow) => void;
  move.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  await user.click(within(row).getByRole('button', { name: 'Отток' }));
  const dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Перенести в отток' })).toBeEnabled(),
  );
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  const submit = within(dialog).getByRole('button', { name: 'Перенести в отток' });
  await user.click(submit);
  expect(row).toBeInTheDocument();
  expect(submit).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Отмена' })).toBeDisabled();
  await user.click(submit);
  expect(move).toHaveBeenCalledTimes(1);
  expect(move).toHaveBeenCalledWith('7', 3, 'a'.repeat(64), true);
  await act(async () => finish(outflow));
  await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
});

it('при ошибке сохраняет проживающего и позволяет повторить перенос', async () => {
  const { move } = setup(false);
  move.mockRejectedValueOnce(new ApiError(503, 'Не удалось сохранить отток'));
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  await user.click(within(row).getByRole('button', { name: 'Отток' }));
  const dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Перенести в отток' })).toBeEnabled(),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Перенести в отток' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Не удалось сохранить отток');
  expect(row).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Перенести в отток' }));
  await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
});

it('при изменении данных обновляет проверку и ждёт повторного подтверждения кнопкой', async () => {
  const { preview, move } = setup();
  preview.mockResolvedValueOnce(plan()).mockResolvedValue({
    ...plan(),
    payments_to_delete: { advance: 3, settlement: 2 },
    preview_token: 'b'.repeat(64),
  });
  move.mockRejectedValueOnce(new ApiError(409, 'Выплаты изменились. Повторно проверьте отток'));
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  await user.click(
    within(await screen.findByTestId('resident-3')).getByRole('button', { name: 'Отток' }),
  );
  const dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Перенести в отток' })).toBeEnabled(),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Перенести в отток' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Данные изменились. Подтвердите перенос ещё раз.',
  );
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Перенести в отток' })).toBeEnabled(),
  );
  expect(move).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('resident-3')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Перенести в отток' }));
  expect(move.mock.calls[1][2]).toBe('b'.repeat(64));
});

it('дожидается сохранения изменённой ячейки перед сравнением', async () => {
  const { preview } = setup();
  let finish!: (value: Resident) => void;
  vi.spyOn(api, 'updateResident').mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const user = userEvent.setup();
  render(<ResidentsTable dormitoryId="7" />);
  const row = await screen.findByTestId('resident-3');
  const input = within(row).getByRole('textbox', { name: 'ФИО, строка 1' });
  await user.clear(input);
  await user.type(input, 'Новое имя');
  await user.click(within(row).getByRole('button', { name: 'Отток' }));
  expect(preview).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => finish({ ...resident, full_name: 'Новое имя' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Новое имя');
  expect(preview).toHaveBeenCalledTimes(1);
});
