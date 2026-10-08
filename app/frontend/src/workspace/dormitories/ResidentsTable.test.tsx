import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../../api/client';
import type { PaymentKind, Resident, ResidentPaymentResult } from '../../api/client';
import { defaultColumns, mockTableFetch as mockFetch } from '../../test/tableColumns';
import { ResidentsTable } from './ResidentsTable';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers.indexOf('Запись на расчёт')).toBe(headers.indexOf('Запись на аванс') + 1);
    const registrationButtons = within(row).getAllByRole('button', { name: /Записать на/ });
    expect(registrationButtons).toHaveLength(2);
    registrationButtons.forEach((button) => expect(button).toBeEnabled());
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

  it.each(['advance', 'settlement'] as PaymentKind[])(
    'записывает в %s, сообщает о повторе и позволяет повторить после ошибки',
    async (kind) => {
      mockResident();
      const result = paymentResult();
      const registration = vi
        .spyOn(api, 'registerResidentPayment')
        .mockRejectedValueOnce(new ApiError(503, 'Не удалось записать'))
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({ ...result, created: false });
      const user = userEvent.setup();
      render(<ResidentsTable dormitoryId="7" />);
      const row = await screen.findByTestId('resident-3');
      const destination = kind === 'advance' ? 'аванс' : 'расчёт';
      const button = within(row).getByRole('button', {
        name: `Записать на ${destination}, строка 1`,
      });
      await user.click(button);
      expect(await within(row).findByRole('alert')).toHaveTextContent('Не удалось записать');
      expect(button).toBeEnabled();
      await user.click(button);
      expect(await within(row).findByRole('status')).toHaveTextContent(
        `Записан на ${destination}.`,
      );
      await user.click(button);
      await waitFor(() =>
        expect(within(row).getByRole('status')).toHaveTextContent(`Уже записан на ${destination}.`),
      );
      expect(registration).toHaveBeenCalledTimes(3);
      expect(registration).toHaveBeenLastCalledWith('7', 3, kind);
      expect(row).toBeInTheDocument();
    },
  );

  it('дожидается сохранения ФИО перед записью и блокирует повторное нажатие во время запроса', async () => {
    mockResident();
    let finishSave!: (resident: Resident) => void;
    vi.spyOn(api, 'updateResident').mockImplementation(
      () => new Promise((resolve) => (finishSave = resolve)),
    );
    let finishRegistration!: (result: ResidentPaymentResult) => void;
    const registration = vi
      .spyOn(api, 'registerResidentPayment')
      .mockImplementation(() => new Promise((resolve) => (finishRegistration = resolve)));
    const user = userEvent.setup();
    render(<ResidentsTable dormitoryId="7" />);
    const row = await screen.findByTestId('resident-3');
    await user.type(within(row).getByRole('textbox', { name: 'ФИО, строка 1' }), 'Новое имя');
    const button = within(row).getByRole('button', { name: 'Записать на аванс, строка 1' });
    await user.click(button);
    expect(registration).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    await act(async () => finishSave({ ...blank, full_name: 'Новое имя' }));
    await waitFor(() => expect(registration).toHaveBeenCalledTimes(1));
    await user.click(button);
    expect(registration).toHaveBeenCalledTimes(1);
    await act(async () => finishRegistration(paymentResult()));
    expect(await within(row).findByRole('status')).toHaveTextContent('Записан на аванс.');
    expect(button).toBeEnabled();
  });

  it('дожидается добавленной ячейки, блокирует запись после ошибки сохранения и сообщает о пропущенных значениях', async () => {
    mockResident();
    vi.spyOn(api, 'tableColumns').mockResolvedValue([
      ...defaultColumns('residents'),
      {
        id: 100,
        table_key: 'residents',
        builtin_key: null,
        name: 'Комментарий',
        kind: 'text',
        position: 11,
        options: [],
        archived: false,
      },
    ]);
    let finishSave!: (result: { value: string }) => void;
    vi.spyOn(api, 'saveCustomCell')
      .mockImplementationOnce(() => new Promise((resolve) => (finishSave = resolve)))
      .mockRejectedValueOnce(new ApiError(503, 'Ошибка ячейки'))
      .mockResolvedValueOnce({ value: 'Сохранено' });
    const registration = vi.spyOn(api, 'registerResidentPayment').mockResolvedValue({
      ...paymentResult(),
      skipped_columns: ['Личный статус'],
    });
    const user = userEvent.setup();
    render(<ResidentsTable dormitoryId="7" />);
    const row = await screen.findByTestId('resident-3');
    const input = within(row).getByRole('textbox', { name: 'Комментарий, строка 3' });
    const button = within(row).getByRole('button', { name: 'Записать на расчёт, строка 1' });
    await user.type(input, 'Сохранено');
    await user.click(button);
    expect(registration).not.toHaveBeenCalled();
    await act(async () => finishSave({ value: 'Сохранено' }));
    await waitFor(() => expect(registration).toHaveBeenCalledTimes(1));
    expect(within(row).getByRole('status')).toHaveTextContent('Личный статус');
    await user.type(input, ' ещё');
    await user.click(button);
    await waitFor(() =>
      expect(
        within(row)
          .getAllByRole('alert')
          .some((alert) => alert.textContent?.includes('Сначала исправьте')),
      ).toBe(true),
    );
    expect(registration).toHaveBeenCalledTimes(1);
    await user.click(within(row).getByRole('button', { name: 'Повторить' }));
    await user.click(button);
    await waitFor(() => expect(registration).toHaveBeenCalledTimes(2));
  });
});

function mockResident(): void {
  mockFetch((url) =>
    url.includes('/residents?')
      ? { status: 200, body: { residents: [{ ...blank }], hostels: [] } }
      : { status: 404 },
  );
}

function paymentResult(): ResidentPaymentResult {
  return {
    payment: {
      id: 10,
      personnel_number: null,
      full_name: 'Новое имя',
      advance_amount: null,
      settlement_date: null,
    },
    created: true,
    copied_columns: ['ФИО'],
    skipped_columns: [],
  };
}
