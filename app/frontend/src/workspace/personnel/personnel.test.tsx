import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { personnelApi } from '../../api/personnel';
import type { Employee, PersonnelData, Source } from '../../api/personnel';
import { IdentityDialog } from './IdentityDialog';
import { filterPeople, isFavorite } from './helpers';

const source = (
  dorm: number,
  table: Source['table_key'] = 'residents',
  end = '2026-10-15',
): Source => ({
  table_key: table,
  row_id: dorm,
  dormitory_id: dorm,
  source_name: 'Проживающие',
  values: { shift_start: '2026-10-01', shift_end: end },
});
const person = (id: string, current: Source[] = []): Employee => ({
  id,
  member_ids: [id],
  full_name: 'Иванов Иван',
  personnel_number: null,
  phone: null,
  identity_status: 'pending',
  current,
  sources: [...current],
  has_outflow: false,
  history_dormitory_ids: current.map((row) => row.dormitory_id),
  outflow_dormitory_ids: [],
  last_outflow: null,
  variants: {},
});
const data = (employees: Employee[]): PersonnelData => ({
  today: '2026-10-10',
  user_id: 1,
  dormitories: [],
  users: [],
  employees,
  tasks: [],
  plans: [],
  decisions: [],
  matches: [],
  preferences: { revision: 0, blocks: null, lists: [], favorites: [] },
});
const criteria = { filter: 'current' as const, dormitory: null, scope: [], days: 5, query: '' };
afterEach(() => vi.restoreAllMocks());

describe('Отбор сотрудников', () => {
  it('проверяет текущее проживание и срок в пределах тех же общежитий', () => {
    const employee = person('one', [source(1)]);
    employee.sources.push(source(2, 'outflow'));
    const payload = data([employee]);
    expect(filterPeople(payload, { ...criteria, scope: [2] })).toEqual([]);
    expect(filterPeople(payload, { ...criteria, scope: [1], dormitory: 2 })).toEqual([]);
    expect(filterPeople(payload, { ...criteria, filter: 'ending', scope: [1] })).toHaveLength(1);
    employee.current[0].values.shift_end = '2026-10-16';
    expect(filterPeople(payload, { ...criteria, filter: 'ending', scope: [1] })).toEqual([]);
  });
  it('находит историю оттока после удаления исходной строки', () => {
    const employee = {
      ...person('one'),
      has_outflow: true,
      history_dormitory_ids: [2],
      outflow_dormitory_ids: [2],
      last_outflow: { date: '2026-10-01', dormitory_id: 2, reason: 'Вахта завершена' },
    };
    const payload = data([employee]);
    expect(filterPeople(payload, { ...criteria, filter: 'history', dormitory: 2 })).toHaveLength(1);
    expect(filterPeople(payload, { ...criteria, filter: 'history', dormitory: 1 })).toEqual([]);
  });
  it('учитывает прежние данные и избранное после объединения', () => {
    const employee = {
      ...person('primary', [source(1)]),
      member_ids: ['primary', 'previous'],
      variants: { full_name: ['Семёнов И. И.'], phone: ['+7 (912) 123-45-67'] },
    };
    const payload = data([employee]);
    payload.preferences.favorites = ['previous'];
    expect(isFavorite(employee, payload)).toBe(true);
    expect(filterPeople(payload, { ...criteria, query: 'семенов' })).toHaveLength(1);
    expect(filterPeople(payload, { ...criteria, query: '9121234567' })).toHaveLength(1);
  });
});

describe('Выбор личности перед добавлением', () => {
  it('показывает совпадение и сохраняет существующую карточку только после выбора', async () => {
    const candidate = {
      id: '00000000-0000-4000-8000-000000000001',
      full_name: 'Иванов Иван',
      personnel_number: '10',
      phone: null,
      identity_status: 'confirmed' as const,
      dormitories: ['Северное'],
      score: 50,
      evidence: ['Совпадает табельный номер'],
      differences: [],
    };
    vi.spyOn(personnelApi, 'check').mockResolvedValue({
      check_token: 'a'.repeat(64),
      candidates: [candidate],
    });
    const save = vi
      .spyOn(personnelApi, 'createRecord')
      .mockResolvedValue({ row_id: 1, employee_id: candidate.id });
    const user = userEvent.setup();
    render(
      <IdentityDialog
        dormitoryId="1"
        tableKey="residents"
        initial={{ personnel_number: '10' }}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    const radio = await screen.findByRole('radio', { name: /Иванов Иван/ });
    expect(radio).not.toBeChecked();
    expect(save).not.toHaveBeenCalled();
    await user.click(radio);
    await user.click(screen.getByRole('button', { name: 'Использовать карточку' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][2]).toMatchObject({
      mode: 'existing',
      employee_id: candidate.id,
      personnel_number: '10',
      check_token: 'a'.repeat(64),
    });
  });
});
