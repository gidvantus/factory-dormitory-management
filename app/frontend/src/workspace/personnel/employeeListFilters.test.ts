import { expect, it } from 'vitest';
import type {
  Employee,
  EmployeeColumnFilter,
  PersonnelData,
  PersonnelSourceColumn,
  Source,
} from '../../api/personnel';
import { filterPeople } from './helpers';
import {
  employeeFieldOptions,
  employeeListFields,
  sourceColumnFieldId,
} from './employeeListFilters';

const criteria = { filter: 'all' as const, dormitory: null, scope: [], days: 5, query: '' };
const columns: PersonnelSourceColumn[] = [
  {
    id: 101,
    dormitory_id: 1,
    table_key: 'residents',
    source_name: 'Проживающие',
    name: 'Статус',
    kind: 'select',
    builtin_key: null,
    options: [
      { id: 'ok', label: 'Допущен', archived: false },
      { id: 'wait', label: 'Ожидает', archived: true },
    ],
  },
  {
    id: 102,
    dormitory_id: 1,
    table_key: 'residents',
    source_name: 'Проживающие',
    name: 'Гражданство',
    kind: 'text',
    builtin_key: null,
    options: [],
  },
  {
    id: 103,
    dormitory_id: 1,
    table_key: 'residents',
    source_name: 'Проживающие',
    name: 'Смены',
    kind: 'number',
    builtin_key: null,
    options: [],
  },
  {
    id: 104,
    dormitory_id: 1,
    table_key: 'residents',
    source_name: 'Проживающие',
    name: 'Проверен',
    kind: 'checkbox',
    builtin_key: null,
    options: [],
  },
  {
    id: 201,
    dormitory_id: 2,
    table_key: 'residents',
    source_name: 'Проживающие',
    name: 'Статус',
    kind: 'select',
    builtin_key: null,
    options: [{ id: 'yes', label: 'Допущен', archived: false }],
  },
];
const source = (id: number, custom: Record<string, unknown>, dorm = 1): Source => ({
  row_id: id,
  dormitory_id: dorm,
  table_key: 'residents',
  source_name: 'Проживающие',
  values: { shift_start: '2026-10-01', shift_end: '2026-10-20', custom_values: custom },
});
const employee = (id: string, current: Source[]): Employee => ({
  id,
  member_ids: [id],
  full_name: id,
  personnel_number: null,
  phone: null,
  identity_status: 'confirmed',
  current,
  sources: current,
  history_dormitory_ids: current.map((item) => item.dormitory_id),
  variants: {},
});
const data: PersonnelData = {
  today: '2026-10-15',
  dormitories: [
    { id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false },
    { id: 2, name: 'Южное', client_name: 'Клиент', is_archived: false },
  ],
  employees: [
    employee('same-row', [source(1, { '101': 'ok', '102': 'РФ', '103': 10, '104': false })]),
    employee('different-rows', [
      source(2, { '101': 'ok', '102': 'Казахстан' }),
      source(3, { '101': 'wait', '102': 'РФ' }),
    ]),
    employee('other-dorm', [source(4, { '201': 'yes' }, 2)]),
    employee('away', []),
  ],
  source_columns: columns,
  plans: [],
  arrival_plans: [],
  preferences: { revision: 0, blocks: null, lists: [] },
};
const rule = (
  column: number,
  value: string,
  operator: EmployeeColumnFilter['operator'] = 'equals',
): EmployeeColumnFilter => ({ field: sourceColumnFieldId(columns[column]), value, operator });

it('объединяет одноимённые столбцы общежитий и сопоставляет статусы по названиям вариантов', () => {
  const fields = employeeListFields(data, criteria);
  const status = fields.filter((field) => field.id === sourceColumnFieldId(columns[0]));
  expect(status).toHaveLength(1);
  expect(employeeFieldOptions(status[0], data, criteria)).toEqual(['Допущен', 'Ожидает']);
  expect(
    filterPeople(data, { ...criteria, column_filters: [rule(0, 'Допущен')] }).map(
      (person) => person.id,
    ),
  ).toEqual(['different-rows', 'other-dorm', 'same-row']);
});
it('проверяет несколько условий одной таблицы в одной записи и соблюдает область общежития', () => {
  const rules = [rule(0, 'Допущен'), rule(1, 'РФ')];
  expect(
    filterPeople(data, { ...criteria, column_filters: rules }).map((person) => person.id),
  ).toEqual(['same-row']);
  expect(
    filterPeople(data, { ...criteria, dormitory: 2, column_filters: [rule(0, 'Допущен')] }).map(
      (person) => person.id,
    ),
  ).toEqual(['other-dorm']);
  expect(
    filterPeople(data, { ...criteria, dormitory: 2, column_filters: [rule(1, '', 'empty')] }),
  ).toEqual([]);
});
it('поддерживает состояние проживания, пустые поля, даты, числа и снятые флажки', () => {
  expect(
    filterPeople(data, {
      ...criteria,
      column_filters: [{ field: 'residence_status', operator: 'equals', value: 'Вне общежитий' }],
    }).map((person) => person.id),
  ).toEqual(['away']);
  expect(
    filterPeople(data, { ...criteria, column_filters: [rule(2, '10.0'), rule(3, 'Нет')] }).map(
      (person) => person.id,
    ),
  ).toEqual(['same-row']);
  expect(
    filterPeople(data, {
      ...criteria,
      column_filters: [{ field: 'shift_end', operator: 'from', value: '2026-10-21' }],
    }),
  ).toEqual([]);
  expect(
    filterPeople(data, { ...criteria, column_filters: [rule(3, '', 'empty')] }).map(
      (person) => person.id,
    ),
  ).toEqual(['different-rows']);
});
it('не подменяет отсутствующий столбец пустым условием и учитывает изменение названий', () => {
  const renamed = { ...data, source_columns: [{ ...columns[0], name: 'Допуск' }] };
  expect(
    employeeListFields(renamed, criteria).some((field) => field.label === 'Проживающие · Допуск'),
  ).toBe(true);
  expect(filterPeople(renamed, { ...criteria, column_filters: [rule(0, 'Допущен')] })).toEqual([]);
  expect(
    filterPeople(data, {
      ...criteria,
      column_filters: [{ field: 'residence_status', operator: 'equals', value: '' }],
    }),
  ).toHaveLength(4);
});
