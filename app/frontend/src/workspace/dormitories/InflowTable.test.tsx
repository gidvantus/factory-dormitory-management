import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InflowRow } from '../../api/client';
import type { IdentityChoice } from '../../api/personnel';
import { mockTableFetch as mockFetch } from '../../test/tableColumns';
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
  it('создаёт строку по полям проживающих, сохраняет поля и использует верхний период', async () => {
    let row: InflowRow | null = null;
    const created: IdentityChoice[] = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/inflow?') && !init?.method) {
        return { status: 200, body: row ? [row] : [] };
      }
      if (url.endsWith('/api/personnel/check'))
        return { status: 200, body: { candidates: [], check_token: 'a'.repeat(64) } };
      if (url.includes('/inflow/entry-form?'))
        return {
          status: 200,
          body: {
            schema_token: 'b'.repeat(64),
            month: '2026-10-01',
            hostels: [],
            columns: [
              { id: 1, builtin_key: 'full_name', name: 'ФИО', kind: 'text' },
              { id: 2, builtin_key: 'phone', name: 'Номер телефона', kind: 'text' },
              { id: 3, builtin_key: 'personnel_number', name: 'Т/н', kind: 'text' },
            ].map((column, position) => ({
              ...column,
              table_key: 'residents',
              position,
              archived: false,
              options: [],
            })),
          },
        };
      if (url.endsWith('/inflow/entries') && init?.method === 'POST') {
        const { identity } = JSON.parse(String(init.body)) as { identity: IdentityChoice };
        created.push(identity);
        row = {
          ...blank,
          employee_id: '00000000-0000-4000-8000-000000000001',
          full_name: identity.full_name,
          personnel_number: identity.personnel_number,
        };
        return {
          status: 201,
          body: row,
        };
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
    const identity = await screen.findByTestId('personnel-identity');
    expect(within(identity).getByLabelText('Т/н')).not.toBeRequired();
    await user.type(within(identity).getByLabelText('ФИО'), 'Иванов Иван');
    await user.type(within(identity).getByLabelText('Номер телефона'), '+7 (900) 123-45-67');
    const saveIdentity = within(identity).getByRole('button', {
      name: 'Создать новую карточку',
    });
    await waitFor(() => expect(saveIdentity).toBeEnabled());
    await user.click(saveIdentity);
    const tableRow = await screen.findByTestId('inflow-row-5');
    expect(created).toEqual([
      expect.objectContaining({
        full_name: 'Иванов Иван',
        phone: '+7 (900) 123-45-67',
        personnel_number: null,
      }),
    ]);
    expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(9);
    fireEvent.change(within(tableRow).getByLabelText('Дата заселения, строка 5'), {
      target: { value: '2026-10-07' },
    });
    expect(within(tableRow).getByRole('link', { name: 'Иванов Иван' })).toBeInTheDocument();
    await user.click(within(tableRow).getByRole('button', { name: 'Редактировать ФИО, строка 5' }));
    await user.clear(within(tableRow).getByLabelText('ФИО, строка 5'));
    await user.type(within(tableRow).getByLabelText('ФИО, строка 5'), 'Иванов Иван Петрович');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Кол-во смен, строка 5'), '10x');
    expect(within(tableRow).getByLabelText('Кол-во смен, строка 5')).toHaveValue('10');
    await user.tab();
    await waitFor(() => expect((row as InflowRow | null)?.shift_count).toBe(10));
    expect((row as InflowRow | null)?.full_name).toBe('Иванов Иван Петрович');
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
