import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import type { InflowActionPreview, InflowRow } from '../../api/client';
import { mockTableFetch } from '../../test/tableColumns';
import { InflowActionDialog } from './InflowActionDialog';
import { InflowTable } from './InflowTable';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const row: InflowRow = {
  id: 5,
  full_name: 'Иванов Иван',
  employee_id: 'person',
  personnel_number: null,
  settlement_date: '2026-10-14',
  shift_count: 30,
  citizenship: 'РФ',
  notes: null,
};
const reason = {
  id: 101,
  table_key: 'outflow' as const,
  builtin_key: 'reason',
  name: 'Причина',
  kind: 'text' as const,
  position: 0,
  archived: false,
  options: [],
};
const date = {
  ...reason,
  id: 102,
  builtin_key: 'departure_date',
  name: 'Дата выезда',
  kind: 'date' as const,
};
const plan: InflowActionPreview = {
  destination: 'residents',
  preview_token: 'a'.repeat(64),
  matched_columns: ['ФИО', 'Кол-во смен'],
  warnings: [{ column: 'Гражданство', reason: 'Нет столбца назначения' }],
  empty_columns: ['Телефон'],
  fields: null,
  departure_date: null,
};

it('заселяет и оставляет строку притока с заблокированными действиями', async () => {
  mockTableFetch((url) =>
    url.includes('/inflow?') ? { status: 200, body: [row] } : { status: 404 },
  );
  vi.spyOn(api, 'previewInflowAction').mockResolvedValue(plan);
  const process = vi.spyOn(api, 'processInflow').mockResolvedValue({
    destination: 'residents',
    row_id: 8,
    inflow: {
      ...row,
      processed_as: 'residents',
      processed_row_id: 8,
      processed_at: '2026-10-14T10:00:00Z',
    },
  });
  render(<InflowTable dormitoryId="7" range={{ from: '2026-10-01', to: '2026-10-31' }} />);
  const user = userEvent.setup();
  const source = await screen.findByTestId('inflow-row-5');
  await user.click(within(source).getByRole('button', { name: 'Заселить' }));
  const dialog = await screen.findByRole('dialog', { name: 'Заселить из притока' });
  expect(dialog).toHaveTextContent('Заселить сотрудника «Иванов Иван»?');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Подтвердить' })).toBeEnabled(),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(process).toHaveBeenCalledWith('7', 5, 'settle', plan.preview_token, {});
  expect(source).toHaveTextContent('Заселён');
  expect(within(source).getByRole('button', { name: 'Заселить' })).toBeDisabled();
  expect(within(source).getByRole('button', { name: 'В отток' })).toBeDisabled();
});

it('запрашивает причину и дату, сохраняет черновик после ошибки и обновляет изменённый снимок', async () => {
  const outflow = {
    ...plan,
    destination: 'outflow' as const,
    fields: {
      reason_column: reason,
      departure_column: date,
      reasons: [{ value: 'Уволился', label: 'Уволился' }],
    },
  };
  vi.spyOn(api, 'previewInflowAction')
    .mockResolvedValueOnce(outflow)
    .mockResolvedValue({ ...outflow, preview_token: 'b'.repeat(64) });
  const process = vi
    .spyOn(api, 'processInflow')
    .mockRejectedValueOnce(new ApiError(409, 'Столбцы изменились'))
    .mockResolvedValue({
      destination: 'outflow',
      row_id: 8,
      inflow: { ...row, processed_as: 'outflow' },
    });
  const saved = vi.fn();
  render(
    <InflowActionDialog
      dormitoryId="7"
      row={row}
      action="outflow"
      onClose={vi.fn()}
      onProcessed={saved}
    />,
  );
  const user = userEvent.setup();
  const reasonInput = await screen.findByLabelText('Причина оттока');
  const button = screen.getByRole('button', { name: 'Подтвердить' });
  expect(button).toBeDisabled();
  await user.selectOptions(reasonInput, 'Уволился');
  await user.clear(screen.getByLabelText('Дата оттока'));
  await user.type(screen.getByLabelText('Дата оттока'), '2026-10-20');
  await user.click(button);
  await waitFor(() => expect(api.previewInflowAction).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByLabelText('Причина оттока')).toHaveValue('Уволился');
  expect(screen.getByLabelText('Дата оттока')).toHaveValue('2026-10-20');
  await user.click(button);
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(process).toHaveBeenLastCalledWith('7', 5, 'outflow', 'b'.repeat(64), {
    reason: 'Уволился',
    departure_date: '2026-10-20',
  });
});

it('при отсутствии столбцов скрывает поля оттока и объясняет, что добавить', async () => {
  vi.spyOn(api, 'previewInflowAction').mockResolvedValue({
    ...plan,
    destination: 'outflow',
    fields: { reason_column: null, departure_column: null, reasons: [] },
  });
  render(
    <InflowActionDialog
      dormitoryId="7"
      row={row}
      action="outflow"
      onClose={vi.fn()}
      onProcessed={vi.fn()}
    />,
  );
  expect(await screen.findByText(/Причина недоступна/)).toBeInTheDocument();
  expect(screen.getByText(/Дата оттока недоступна/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Причина оттока')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Дата оттока')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Подтвердить' })).toBeEnabled();
});
