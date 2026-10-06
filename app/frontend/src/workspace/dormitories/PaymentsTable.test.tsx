import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaymentRow } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { PaymentsTable } from './PaymentsTable';

afterEach(() => vi.unstubAllGlobals());

const blank: PaymentRow = {
  id: 6,
  personnel_number: null,
  full_name: null,
  advance_amount: null,
  settlement_date: null,
};

describe('Выплаты', () => {
  it('добавляет аванс, принимает сумму с копейками и удаляет после подтверждения', async () => {
    let row: PaymentRow | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/dormitories/7/payments/advance') && !init?.method)
        return { status: 200, body: row ? [row] : [] };
      if (url.endsWith('/api/dormitories/7/payments/advance') && init?.method === 'POST') {
        row = { ...blank };
        return { status: 201, body: row };
      }
      if (url.endsWith('/api/dormitories/7/payments/advance/6') && init?.method === 'PATCH') {
        row = { ...row!, ...(JSON.parse(String(init.body)) as Partial<PaymentRow>) };
        return { status: 200, body: row };
      }
      if (url.endsWith('/api/dormitories/7/payments/advance/6') && init?.method === 'DELETE') {
        row = null;
        return { status: 204, body: undefined };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(
      <PaymentsTable
        dormitoryId="7"
        kind="advance"
        range={{ from: '2026-10-01', to: '2026-10-31' }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /Добавить строку/ }));
    const tableRow = await screen.findByTestId('advance-row-6');
    expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(4);
    await user.type(within(tableRow).getByLabelText('Т/н, строка 6'), '123');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Сумма аванса, строка 6'), '1250,50x');
    expect(within(tableRow).getByLabelText('Сумма аванса, строка 6')).toHaveValue('1250,50');
    await user.tab();
    await waitFor(() => expect((row as PaymentRow | null)?.advance_amount).toBe('1250.50'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/advance?'))).toBe(false);
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить строку выплаты?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByTestId('advance-row-6')).toBeInTheDocument();
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить строку' }),
    );
    await waitFor(() => expect(screen.queryByTestId('advance-row-6')).not.toBeInTheDocument());
  });

  it('записывает дату расчёта и запрашивает строки за выбранный период', async () => {
    let row: PaymentRow | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/payments/settlement?') && !init?.method)
        return { status: 200, body: row ? [row] : [] };
      if (url.endsWith('/api/dormitories/7/payments/settlement') && init?.method === 'POST') {
        row = { ...blank };
        return { status: 201, body: row };
      }
      if (url.endsWith('/api/dormitories/7/payments/settlement/6') && init?.method === 'PATCH') {
        row = { ...row!, ...(JSON.parse(String(init.body)) as Partial<PaymentRow>) };
        return { status: 200, body: row };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(
      <PaymentsTable
        dormitoryId="7"
        kind="settlement"
        range={{ from: '2026-10-01', to: '2026-10-31' }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /Добавить строку/ }));
    fireEvent.change(screen.getByLabelText('Дата расчёта, строка 6'), {
      target: { value: '2026-10-15' },
    });
    await waitFor(() => expect((row as PaymentRow | null)?.settlement_date).toBe('2026-10-15'));
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('from=2026-10-01&to=2026-10-31')),
    ).toBe(true);
  });
});
