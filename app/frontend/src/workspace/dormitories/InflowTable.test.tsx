import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InflowRow } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { InflowTable } from './InflowTable';

afterEach(() => vi.unstubAllGlobals());

const blank: InflowRow = {
  id: 5,
  settlement_date: null,
  personnel_number: null,
  full_name: null,
  citizenship: null,
  notes: null,
  shift_count: null,
};

describe('Приток', () => {
  it('создаёт и сохраняет строку, подтверждает удаление и использует верхний период', async () => {
    let row: InflowRow | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/inflow?') && !init?.method) {
        return { status: 200, body: row ? [row] : [] };
      }
      if (url.endsWith('/api/dormitories/7/inflow') && init?.method === 'POST') {
        row = { ...blank };
        return { status: 201, body: row };
      }
      if (url.endsWith('/api/dormitories/7/inflow/5') && init?.method === 'PATCH') {
        row = { ...row!, ...(JSON.parse(String(init.body)) as Partial<InflowRow>) };
        return { status: 200, body: row };
      }
      if (url.endsWith('/api/dormitories/7/inflow/5') && init?.method === 'DELETE') {
        row = null;
        return { status: 204, body: undefined };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(<InflowTable dormitoryId="7" range={{ from: '2026-10-01', to: '2026-10-31' }} />);
    await user.click(await screen.findByRole('button', { name: /Добавить строку/ }));
    const tableRow = await screen.findByTestId('inflow-row-5');
    expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(7);
    fireEvent.change(within(tableRow).getByLabelText('Дата заселения, строка 5'), {
      target: { value: '2026-10-07' },
    });
    await user.type(within(tableRow).getByLabelText('ФИО, строка 5'), 'Иванов Иван');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Кол-во смен, строка 5'), '10x');
    expect(within(tableRow).getByLabelText('Кол-во смен, строка 5')).toHaveValue('10');
    await user.tab();
    await waitFor(() => expect((row as InflowRow | null)?.shift_count).toBe(10));
    expect((row as InflowRow | null)?.full_name).toBe('Иванов Иван');
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить строку притока?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByTestId('inflow-row-5')).toBeInTheDocument();
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить строку' }),
    );
    await waitFor(() => expect(screen.queryByTestId('inflow-row-5')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('from=2026-10-01&to=2026-10-31')),
    ).toBe(true);
  });
});
