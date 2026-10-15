import { describe, expect, it } from 'vitest';
import type { Block, Employee, PersonnelData, Source } from '../../api/personnel';
import { blockSource, calendarSeries, workspaceBlockData } from './workspaceBlockData';

const source = (dorm: number, end: string, id = dorm): Source => ({
  table_key: 'residents',
  row_id: id,
  dormitory_id: dorm,
  source_name: 'Проживающие',
  values: { shift_end: end },
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
const block = (kind: Block['kind'], extra: Partial<Block> = {}): Block => ({
  id: kind,
  kind,
  title: kind,
  scope: [],
  days: 5,
  limit: 1,
  wide: false,
  saved_list_id: null,
  ...extra,
});
const data = (): PersonnelData => ({
  today: '2026-10-15',
  dormitories: [
    { id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false },
    { id: 2, name: 'Центральное', client_name: 'Клиент', is_archived: false },
  ],
  employees: [
    employee('Анна', [source(1, '2026-10-17')]),
    employee('Борис', [source(2, '2026-10-20')]),
  ],
  plans: [],
  arrival_plans: [],
  preferences: { revision: 0, blocks: [], lists: [] },
});

describe('Данные инфографики персонала', () => {
  it('считает все заезды в области и периоде, независимо от лимита строк', () => {
    const payload = data();
    payload.arrival_plans = [
      { id: 'one', dormitory_id: 1, date: '2026-10-15', count: 3, names: [], revision: 0 },
      { id: 'two', dormitory_id: 1, date: '2026-10-15', count: 5, names: [], revision: 0 },
      { id: 'three', dormitory_id: 1, date: '2026-10-20', count: 7, names: [], revision: 0 },
      { id: 'outside', dormitory_id: 2, date: '2026-10-15', count: 100, names: [], revision: 0 },
      { id: 'past', dormitory_id: 1, date: '2026-10-14', count: 100, names: [], revision: 0 },
      { id: 'future', dormitory_id: 1, date: '2026-10-21', count: 100, names: [], revision: 0 },
    ];
    const model = workspaceBlockData(block('plans', { scope: [1] }), payload, null);
    expect(model.total).toBe(15);
    expect(model.plans).toHaveLength(3);
    expect(model.series.map((point) => point.count)).toEqual([8, 7]);
    expect(workspaceBlockData(block('plans', { scope: [1] }), payload, 2).total).toBe(0);
  });
  it('показывает подходящую вахту при нескольких источниках, пропуская пустые и прошедшие даты', () => {
    const payload = data();
    payload.employees = [
      employee('Анна', [
        source(1, '', 1),
        source(1, '2026-10-14', 2),
        source(1, '2026-10-18', 3),
        source(2, '2026-10-15', 4),
      ]),
    ];
    const model = workspaceBlockData(block('ending', { scope: [1] }), payload, null);
    expect(model.total).toBe(1);
    expect(blockSource(model.people[0], model.criteria, payload.today)?.row_id).toBe(3);
    expect(model.series).toEqual([{ label: '18 окт.', count: 1 }]);
    payload.employees.push(employee('Борис', [source(1, '2026-10-17', 5)]));
    expect(
      workspaceBlockData(block('ending', { scope: [1] }), payload, null).people.map(
        (person) => person.id,
      ),
    ).toEqual(['Борис', 'Анна']);
  });
  it('не считает одного человека дважды в общем итоге, сохраняя размещения по общежитиям', () => {
    const payload = data();
    payload.employees = [employee('Анна', [source(1, ''), source(1, '', 3), source(2, '')])];
    const model = workspaceBlockData(block('residents'), payload, null);
    expect(model.total).toBe(1);
    expect(model.dorms.map((item) => item.count)).toEqual([1, 1]);
    expect(workspaceBlockData(block('residents'), payload, 2).dorms.map((item) => item.id)).toEqual(
      [2],
    );
  });
  it('поддерживает сохранённый список с его поиском и областью, включая скрытый ранее тип блока', () => {
    const payload = data();
    payload.preferences.lists = [
      {
        id: 'team',
        name: 'Команда',
        filter: 'current',
        days: 7,
        query: 'анна',
        scope: [1],
        dormitory: null,
      },
    ];
    const saved = block('saved', { saved_list_id: 'team' });
    const model = workspaceBlockData(saved, payload, null);
    expect(model.total).toBe(1);
    expect(model.people[0].id).toBe('Анна');
    expect(model.criteria.query).toBe('анна');
    expect(workspaceBlockData(saved, payload, 2).total).toBe(0);
  });
  it('не подменяет удалённый сохранённый список всеми сотрудниками', () => {
    const model = workspaceBlockData(block('saved', { saved_list_id: 'deleted' }), data(), null);
    expect(model.missingList).toBe(true);
    expect(model.total).toBe(0);
    expect(model.people).toEqual([]);
  });
  it('сжимает длинный календарь без потери численности и без NaN на пустых данных', () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      count: i + 1,
    }));
    const series = calendarSeries(events);
    expect(series.length).toBeLessThanOrEqual(5);
    expect(series.reduce((sum, point) => sum + point.count, 0)).toBe(210);
    expect(calendarSeries([])).toEqual([]);
    const acrossYears = calendarSeries([
      { date: '2026-12-31', count: 1 },
      { date: '2027-01-01', count: 2 },
    ]);
    expect(acrossYears[0].label).toContain('2026');
    expect(acrossYears[1].label).toContain('2027');
  });
});
