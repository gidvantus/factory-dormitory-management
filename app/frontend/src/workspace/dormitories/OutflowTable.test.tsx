import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutflowRow } from '../../api/client';
import { mockTableFetch as mockFetch } from '../../test/tableColumns';
import { OutflowTable } from './OutflowTable';

afterEach(() => vi.unstubAllGlobals());

const blank: OutflowRow = {
  id: 8,
  departure_date: null,
  personnel_number: null,
  full_name: null,
  shift_start: null,
  reason: null,
  notes: null,
  additional_info: null,
};

describe('Отток', () => {
  it('создаёт строку, сохраняет поля и удаляет после подтверждения', async () => {
    let row: OutflowRow | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/outflow?') && !init?.method)
        return { status: 200, body: row ? [row] : [] };
      if (url.endsWith('/api/dormitories/7/outflow') && init?.method === 'POST') {
        row = { ...blank };
        return { status: 201, body: row };
      }
      if (url.endsWith('/api/dormitories/7/outflow/8') && init?.method === 'PATCH') {
        row = { ...row!, ...(JSON.parse(String(init.body)) as Partial<OutflowRow>) };
        return { status: 200, body: row };
      }
      if (url.endsWith('/api/dormitories/7/outflow/8') && init?.method === 'DELETE') {
        row = null;
        return { status: 204, body: undefined };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(<OutflowTable dormitoryId="7" range={{ from: '2026-10-01', to: '2026-10-31' }} />);
    await user.click(await screen.findByRole('button', { name: /Добавить строку/ }));
    const tableRow = await screen.findByTestId('outflow-row-8');
    expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(9);
    fireEvent.change(within(tableRow).getByLabelText('Дата выезда, строка 8'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.change(within(tableRow).getByLabelText('Начало вахты, строка 8'), {
      target: { value: '2026-09-01' },
    });
    await user.type(within(tableRow).getByLabelText('ФИО, строка 8'), 'Иванов Иван');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Причина, строка 8'), 'Завершил вахту');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Доп. информация, строка 8'), 'Возврат домой');
    await user.tab();
    await waitFor(() => expect((row as OutflowRow | null)?.additional_info).toBe('Возврат домой'));
    expect(within(tableRow).getByRole('button', { name: 'Выселение' })).toBeDisabled();
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить строку оттока?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByTestId('outflow-row-8')).toBeInTheDocument();
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить строку' }),
    );
    await waitFor(() => expect(screen.queryByTestId('outflow-row-8')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('from=2026-10-01&to=2026-10-31')),
    ).toBe(true);
  });
});
