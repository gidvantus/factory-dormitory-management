import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Resident } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { ResidentsTable } from './ResidentsTable';

afterEach(() => vi.unstubAllGlobals());

const blank: Resident = {
  id: 3,
  gender: null,
  personnel_number: null,
  full_name: null,
  hostel_id: null,
  hostel_name: null,
  shift_start: null,
  shift_count: null,
  shift_end: null,
  phone: null,
  medical_book: null,
  notes: null,
};

describe('Проживающие', () => {
  it('создаёт строку, сохраняет поля и удаляет только после подтверждения', async () => {
    let resident: Resident | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/residents?') && !init?.method) {
        return {
          status: 200,
          body: { residents: resident ? [resident] : [], hostels: [{ id: 9, name: 'Хостел 1' }] },
        };
      }
      if (url.endsWith('/api/dormitories/7/residents') && init?.method === 'POST') {
        resident = { ...blank };
        return { status: 201, body: resident };
      }
      if (url.includes('/api/dormitories/7/residents/3?') && init?.method === 'PATCH') {
        const change = JSON.parse(String(init.body)) as Partial<Resident>;
        resident = {
          ...resident!,
          ...change,
          hostel_name: change.hostel_id === 9 ? 'Хостел 1' : resident!.hostel_name,
        };
        return { status: 200, body: resident };
      }
      if (url.endsWith('/api/dormitories/7/residents/3') && init?.method === 'DELETE') {
        resident = null;
        return { status: 204, body: undefined };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(<ResidentsTable dormitoryId="7" />);
    await user.click(await screen.findByRole('button', { name: /Добавить строку/ }));
    const row = await screen.findByTestId('resident-3');
    expect(within(row).getByRole('rowheader')).toHaveTextContent('1');
    await user.selectOptions(within(row).getByRole('combobox', { name: 'Пол, строка 1' }), 'Ж');
    await user.type(within(row).getByRole('textbox', { name: 'ФИО, строка 1' }), 'Иванова Мария');
    await user.tab();
    await user.selectOptions(
      within(row).getByRole('combobox', { name: 'Место проживания, строка 1' }),
      '9',
    );
    await waitFor(() => expect(resident?.hostel_id).toBe(9));
    expect((resident as Resident | null)?.full_name).toBe('Иванова Мария');
    expect(within(row).getByRole('button', { name: 'Записать' })).toBeDisabled();
    await user.click(within(row).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить проживающего?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByTestId('resident-3')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Удалить' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить строку' }),
    );
    await waitFor(() => expect(screen.queryByTestId('resident-3')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith('/residents/3') && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
