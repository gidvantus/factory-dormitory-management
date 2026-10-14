import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type { PaymentKind, Resident, ResidentPaymentResult } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type { Employee, IdentityChoice, PersonnelData, Source } from '../../api/personnel';
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
  it('открывает карточку по ФИО поверх таблицы и сохраняет исправление связи внутри карточки', async () => {
    const resident = { ...blank, full_name: 'Иванов Иван', employee_id: 'first' };
    const record: Source = {
      dormitory_id: 7,
      table_key: 'residents',
      row_id: 3,
      source_name: 'Проживающие',
      values: { full_name: resident.full_name, shift_start: '2026-10-01', shift_end: '2026-10-30' },
    };
    const person = (id: string, name: string, sources: Source[]): Employee => ({
      id,
      member_ids: [id],
      full_name: name,
      personnel_number: null,
      phone: null,
      identity_status: 'confirmed',
      current: sources,
      sources,
      history_dormitory_ids: [7],
      variants: {},
    });
    let data: PersonnelData = {
      today: '2026-10-14',
      dormitories: [{ id: 7, name: 'Северное', client_name: 'Завод', is_archived: false }],
      employees: [person('first', 'Иванов Иван', [record]), person('second', 'Иванов Илья', [])],
      plans: [],
      arrival_plans: [],
      decisions: [],
      preferences: { revision: 0, blocks: [], lists: [] },
    };
    vi.spyOn(api, 'tableColumns').mockResolvedValue(defaultColumns('residents'));
    vi.spyOn(api, 'residents').mockResolvedValue({ residents: [resident], hostels: [] });
    vi.spyOn(personnelApi, 'workspace').mockImplementation(async () => data);
    vi.spyOn(personnelApi, 'detail').mockImplementation(async (id) => ({
      employee_id: id,
      events: [],
      notes: [],
      merges: [],
    }));
    vi.spyOn(personnelApi, 'check').mockResolvedValue({
      check_token: 'a'.repeat(64),
      candidates: data.employees.map((employee) => ({
        ...employee,
        dormitories: ['Северное'],
        score: 40,
        evidence: ['Совпадает фамилия'],
        differences: [],
      })),
    });
    const link = vi.spyOn(personnelApi, 'link').mockImplementation(async () => {
      data = {
        ...data,
        employees: [person('first', 'Иванов Иван', []), person('second', 'Иванов Илья', [record])],
      };
      return { employee_id: 'second' };
    });
    function Location(): JSX.Element {
      return <output data-testid="location">{useLocation().pathname}</output>;
    }
    render(
      <MemoryRouter initialEntries={['/cabinet/dormitories/7/residents']}>
        <ResidentsTable dormitoryId="7" />
        <Location />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const row = await screen.findByTestId('resident-3');
    expect(
      within(row).queryByText(/Карточка|Изменить связь|Связать с сотрудником/),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole('link', { name: 'Иванов Иван' }));
    let dialog = await screen.findByTestId('personnel-profile');
    expect(row).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/cabinet/dormitories/7/residents');
    await user.click(within(dialog).getByRole('button', { name: 'Изменить связь' }));
    dialog = screen.getByTestId('personnel-identity');
    await user.click(await within(dialog).findByRole('radio', { name: /Иванов Илья/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Использовать карточку' }));
    await screen.findByRole('heading', { name: 'Иванов Илья' });
    expect(link).toHaveBeenCalledWith(
      7,
      'residents',
      3,
      expect.objectContaining({ mode: 'existing', employee_id: 'second' }),
    );
    await user.click(
      within(screen.getByTestId('personnel-profile')).getByRole('button', { name: /Закрыть/ }),
    );
    expect(within(row).getByRole('link', { name: 'Иванов Иван' })).toHaveAttribute(
      'href',
      '/cabinet/personnel?employee=second',
    );
  });

  it('редактирует ФИО карандашом, сохраняет черновик при ошибке и повторяет сохранение по Enter', async () => {
    const resident = { ...blank, full_name: 'Иванов Иван', employee_id: 'first' };
    vi.spyOn(api, 'tableColumns').mockResolvedValue(defaultColumns('residents'));
    vi.spyOn(api, 'residents').mockResolvedValue({ residents: [resident], hostels: [] });
    const save = vi
      .spyOn(api, 'updateResident')
      .mockRejectedValueOnce(new ApiError(503, 'Ошибка сохранения'))
      .mockResolvedValueOnce({ ...resident, full_name: 'Иванов Илья' });
    render(<ResidentsTable dormitoryId="7" />);
    const user = userEvent.setup();
    const row = await screen.findByTestId('resident-3');
    await user.click(within(row).getByRole('button', { name: 'Редактировать ФИО, строка 1' }));
    const input = within(row).getByRole('textbox', { name: 'ФИО, строка 1' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Иванов Илья');
    await user.tab();
    expect(await within(row).findByRole('alert')).toHaveAttribute('title', 'Ошибка сохранения');
    expect(input).toHaveValue('Иванов Илья');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(await within(row).findByRole('link', { name: 'Иванов Илья' })).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('7', 3, expect.any(String), 'full_name', 'Иванов Илья');
  });

  it('создаёт строку по ФИО и телефону без табельного номера, сохраняет поля и удаляет после подтверждения', async () => {
    let resident: Resident | null = null;
    const created: IdentityChoice[] = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/residents?') && !init?.method) {
        return {
          status: 200,
          body: { residents: resident ? [resident] : [], hostels: [{ id: 9, name: 'Хостел 1' }] },
        };
      }
      if (url.endsWith('/api/personnel/check'))
        return { status: 200, body: { candidates: [], check_token: 'a'.repeat(64) } };
      if (url.endsWith('/api/personnel/records') && init?.method === 'POST') {
        const { identity } = JSON.parse(String(init.body)) as { identity: IdentityChoice };
        created.push(identity);
        resident = {
          ...blank,
          full_name: identity.full_name,
          phone: identity.phone,
          personnel_number: identity.personnel_number,
        };
        return {
          status: 201,
          body: { row_id: 3, employee_id: '00000000-0000-4000-8000-000000000001' },
        };
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
    const identity = await screen.findByRole('dialog');
    expect(within(identity).queryByLabelText('Табельный номер')).not.toBeInTheDocument();
    await user.type(within(identity).getByLabelText('ФИО'), 'Иванова Мария');
    await user.type(within(identity).getByLabelText('Телефон'), '+7 (900) 123-45-67');
    const saveIdentity = within(identity).getByRole('button', {
      name: 'Создать новую карточку',
    });
    await waitFor(() => expect(saveIdentity).toBeEnabled());
    await user.click(saveIdentity);
    const row = await screen.findByTestId('resident-3');
    expect(created).toEqual([
      expect.objectContaining({
        full_name: 'Иванова Мария',
        phone: '+7 (900) 123-45-67',
        personnel_number: null,
      }),
    ]);
    expect(within(row).getByRole('link', { name: 'Иванова Мария' })).toBeInTheDocument();
    expect(within(row).getByRole('textbox', { name: 'Т/н, строка 1' })).toHaveValue('');
    expect(within(row).getByRole('rowheader')).toHaveTextContent('1');
    await user.selectOptions(within(row).getByRole('combobox', { name: 'Пол, строка 1' }), 'Ж');
    await user.type(within(row).getByRole('textbox', { name: 'Т/н, строка 1' }), '123');
    await user.click(within(row).getByRole('button', { name: 'Редактировать ФИО, строка 1' }));
    await user.clear(within(row).getByRole('textbox', { name: 'ФИО, строка 1' }));
    await user.type(
      within(row).getByRole('textbox', { name: 'ФИО, строка 1' }),
      'Иванова Мария Петровна',
    );
    await user.tab();
    await user.selectOptions(
      within(row).getByRole('combobox', { name: 'Место проживания, строка 1' }),
      '9',
    );
    await waitFor(() => expect(resident?.hostel_id).toBe(9));
    expect((resident as Resident | null)?.full_name).toBe('Иванова Мария Петровна');
    expect((resident as Resident | null)?.personnel_number).toBe('123');
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
