import { describe, expect, it } from 'vitest';
import {
  bindFormula,
  calculationSources,
  createCalculationEngine,
  dependents,
  displayFormula,
  referenceTargets,
  sourceUsers,
  validateCalculations,
} from './calculations';
import {
  calculationExamples,
  cloneTable,
  initialState,
  loadState,
  newColumn,
  newTab,
  seedData,
  STORAGE_KEY,
} from './model';
import type { CalculationRule, LinkRule } from './calculationTypes';

const linkRule = (patch: Partial<LinkRule>): CalculationRule => ({
  mode: 'link',
  expression: '=',
  refs: {},
  link: {
    sourceId: 'arrivals',
    operation: 'sum',
    valueField: 'count',
    sourceRowId: null,
    match: null,
    filters: [],
    dateField: 'date',
    empty: 'zero',
    ...patch,
  },
});
function example() {
  const tabs = calculationExamples();
  return { tabs, data: seedData(), rates: tabs[1], payroll: tabs[2], daily: tabs[3] };
}

describe('Формулы и связи персональных таблиц', () => {
  it('считает несколько действий, цепочку связей и немедленно использует новые значения источника', () => {
    const { tabs, data, rates, payroll } = example();
    expect(validateCalculations(tabs, data)).toBe('');
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-total'),
    ).toEqual({ value: 3300 });
    rates.rows[0].values['hour-price'] = '500';
    payroll.rows[0].values['pay-hours'] = '9';
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-total'),
    ).toEqual({ value: 5000 });
  });
  it('сохраняет привязки после переименования и перестановки полей и строк', () => {
    const { tabs, data, payroll, daily } = example();
    payroll.columns.find((column) => column.id === 'pay-hours')!.name = 'Отработано';
    payroll.columns.reverse();
    daily.rows[1].name = 'Факт смены';
    daily.rows.reverse();
    const column = payroll.columns.find((column) => column.id === 'pay-total')!;
    expect(displayFormula(column.rule!, referenceTargets(payroll, 'column', data))).toBe(
      '=([Отработано]*[Ставка])+[Доплата]',
    );
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], column.id).value,
    ).toBe(3300);
    const delta = daily.rows.find((row) => row.id === 'day-difference')!;
    expect(createCalculationEngine(tabs, data).day(daily, delta, '2026-11-02').value).toBe(1);
    expect(
      bindFormula('=[Дубль]', [
        { id: 'a', name: 'Дубль' },
        { id: 'b', name: 'Дубль' },
      ]),
    ).toEqual({});
  });
  it('пересчитывает календарные формулы и связи по дате, включая дни вне текущей даты', () => {
    const { tabs, data, daily } = example();
    data.arrival_plans.push({
      ...data.arrival_plans[0],
      id: 'next',
      date: '2026-11-03',
      count: 12,
    });
    const engine = createCalculationEngine(tabs, data);
    expect(engine.day(daily, daily.rows[2], '2026-11-01').value).toBe(-1);
    expect(engine.day(daily, daily.rows[3], '2026-11-02').value).toBe(5);
    expect(engine.day(daily, daily.rows[3], '2026-11-03').value).toBe(12);
    expect(engine.day(daily, daily.rows[3], '2026-11-04').value).toBe(0);
  });
  it.each([
    ['sum', 750],
    ['average', 375],
    ['min', 350],
    ['max', 400],
    ['count', 2],
  ] as const)('выполняет операцию %s по всем подходящим записям', (operation, expected) => {
    const { tabs, data, payroll } = example();
    payroll.columns[3].rule = linkRule({
      sourceId: 'tab:demo-rates',
      operation,
      valueField: 'hour-price',
      dateField: null,
    });
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-rate').value,
    ).toBe(expected);
    payroll.columns[3].rule!.link!.filters = [
      { field: 'hour-price', operator: 'from', value: '360' },
    ];
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-rate').value,
    ).toBe(operation === 'count' ? 1 : 400);
  });
  it('применяет несколько условий и обе границы периода', () => {
    const { tabs, data, payroll } = example();
    data.arrival_plans.push({ ...data.arrival_plans[0], id: 'next', date: '2026-11-03', count: 7 });
    payroll.columns[3].rule = linkRule({
      filters: [
        { field: 'dormitory', operator: 'equals', value: data.dormitories[0].name },
        { field: 'count', operator: 'from', value: '6' },
      ],
    });
    expect(
      createCalculationEngine(tabs, data, {
        range: { from: '2026-11-02', to: '2026-11-03' },
      }).column(payroll, payroll.rows[0], 'pay-rate').value,
    ).toBe(7);
    expect(
      createCalculationEngine(tabs, data, {
        range: { from: '2026-11-02', to: '2026-11-02' },
      }).column(payroll, payroll.rows[0], 'pay-rate').value,
    ).toBe(0);
  });
  it('показывает неоднозначное совпадение, отсутствие данных, неверное число и деление на ноль', () => {
    const { tabs, data, payroll, rates } = example();
    rates.rows.push({ ...structuredClone(rates.rows[0]), id: 'duplicate' });
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-total').error,
    ).toContain('найдено 2');
    rates.rows = [];
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-rate').error,
    ).toContain('не найдено');
    payroll.columns[3].rule!.link!.empty = 'blank';
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-rate').value,
    ).toBe('');
    payroll.rows[0].values['pay-hours'] = 'Отпуск';
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-total').error,
    ).toContain('не является числом');
    payroll.columns[4].rule = { mode: 'formula', expression: '=1/0', refs: {}, link: null };
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-total').error,
    ).toBe('Деление на ноль');
    payroll.columns[4].rule!.expression = '=window.alert(1)';
    expect(validateCalculations(tabs, data)).toContain('только числа');
  });
  it('выявляет циклы между таблицами, удалённые поля, строки и источники', () => {
    const { tabs, data, payroll, rates, daily } = example();
    rates.columns[1].rule = linkRule({
      sourceId: 'tab:demo-payroll',
      valueField: 'pay-total',
      dateField: null,
    });
    expect(validateCalculations(tabs, data)).toContain('Циклическая зависимость');
    expect(
      createCalculationEngine(tabs, data).column(payroll, payroll.rows[0], 'pay-total').error,
    ).toContain('Циклическая');
    delete rates.columns[1].rule;
    rates.columns[1].archived = true;
    expect(validateCalculations(tabs, data)).toContain('не найден');
    rates.columns[1].archived = false;
    rates.archived = true;
    expect(validateCalculations(tabs, data)).toContain('Источник');
    rates.archived = false;
    daily.rows = daily.rows.filter((row) => row.id !== 'day-fact');
    expect(validateCalculations(tabs, data)).toContain('ссылка [Факт]');
  });
  it('находит пользователей зависимостей, в том числе скрытые вкладки и календарные count-связи', () => {
    const { tabs, payroll } = example();
    payroll.hidden = true;
    expect(sourceUsers(tabs, ['demo-rates'])).toEqual(['Расчёт оплаты → Ставка']);
    expect(dependents(tabs, 'demo-rates', 'column', 'hour-price')).toContain(
      'Расчёт оплаты → Ставка',
    );
    payroll.columns[3].rule = linkRule({
      sourceId: 'tab:demo-daily',
      operation: 'count',
      sourceRowId: 'day-fact',
      dateField: '$date',
    });
    expect(dependents(tabs, 'demo-daily', 'row', 'day-fact')).toContain('Расчёт оплаты → Ставка');
  });
  it('связывает обычную таблицу с календарной строкой и вычисляемыми полями другого списка', () => {
    const { tabs, data, payroll } = example();
    payroll.columns[3].rule = linkRule({
      sourceId: 'tab:demo-daily',
      operation: 'sum',
      sourceRowId: 'day-difference',
      valueField: '$value',
      dateField: '$date',
    });
    expect(
      createCalculationEngine(tabs, data, {
        range: { from: '2026-11-01', to: '2026-11-02' },
      }).column(payroll, payroll.rows[0], 'pay-rate').value,
    ).toBe(0);
    const consumer = {
      ...newTab(),
      kind: 'table' as const,
      columns: [
        {
          ...newColumn(),
          id: 'total',
          name: 'Итог',
          rule: linkRule({
            sourceId: 'tab:demo-payroll',
            valueField: 'pay-total',
            dateField: null,
          }),
        },
      ],
      rows: [{ id: 'all', values: {} }],
    };
    expect(
      createCalculationEngine([...tabs, consumer], data).column(consumer, consumer.rows[0], 'total')
        .value,
    ).toBe(500);
  });
  it('предоставляет действующие поля сотрудников, общежитий, отчёта и размещения и считает их', () => {
    const { tabs, data, payroll } = example();
    const sources = calculationSources(tabs, data);
    for (const kind of ['people', 'table', 'report', 'places'] as const) {
      const source = sources.find(
        (source) => source.kind === kind && (kind !== 'table' || source.id.startsWith('dorm:')),
      )!;
      expect(source).toBeDefined();
      payroll.columns[3].rule = linkRule({
        sourceId: source.id,
        operation: 'count',
        valueField: '',
        dateField: kind === 'report' || kind === 'places' ? '$date' : null,
        sourceRowId: source.rows?.[0]?.id ?? null,
      });
      expect(validateCalculations(tabs, data)).toBe('');
      const value = createCalculationEngine(tabs, data, { day: data.today }).column(
        payroll,
        payroll.rows[0],
        'pay-rate',
      );
      expect(value.error).toBeUndefined();
      expect(value.value).toBeGreaterThan(0);
    }
    expect(
      sources
        .find((source) => source.id === 'people')!
        .fields.some((field) => field.id.startsWith('source:')),
    ).toBe(true);
    const report = sources.find((source) => source.kind === 'report')!;
    payroll.columns[3].rule = linkRule({
      sourceId: report.id,
      valueField: '$value',
      sourceRowId: report.rows![0].id,
      dateField: '$date',
    });
    expect(
      createCalculationEngine(tabs, data, { day: data.today }).column(
        payroll,
        payroll.rows[0],
        'pay-rate',
      ).error,
    ).toBeUndefined();
  });
  it('копирует формулы и сопоставления на новые ID; календарные правила — без дневных данных', () => {
    const { tabs, data, payroll, daily } = example();
    const copied = cloneTable(payroll, 'Оплата 2');
    expect(copied.rows).toEqual([]);
    expect(copied.columns[4].rule!.refs['Часы']).toBe(copied.columns[1].id);
    expect(copied.columns[3].rule!.link!.match!.localColumnId).toBe(copied.columns[0].id);
    copied.rows = [
      { id: 'new', values: { [copied.columns[0].id]: 'employee-0', [copied.columns[1].id]: '8' } },
    ];
    expect(
      createCalculationEngine([...tabs, copied], data).column(
        copied,
        copied.rows[0],
        copied.columns[4].id,
      ).value,
    ).toBe(2800);
    const calendar = cloneTable(daily, 'Календарь 2', true);
    expect(calendar.rows[2].rule!.refs['Факт']).toBe(calendar.rows[1].id);
    expect(calendar.rows.every((row) => Object.keys(row.dayValues!).length === 0)).toBe(true);
    expect(validateCalculations([...tabs, calendar], data)).toBe('');
  });
  it('дополняет версию 2 примерами единожды и сохраняет пользовательские значения', () => {
    const state = initialState();
    state.tabs = state.tabs.filter((tab) => !tab.id.startsWith('demo-'));
    state.tabs.find((tab) => tab.id === 'timesheet')!.rows[0].dayValues!['2026-11-02'] = '17';
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, version: 2 }));
    const next = loadState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    expect(loadState().tabs.filter((tab) => tab.id === 'demo-calculations')).toHaveLength(1);
    expect(next.tabs.find((tab) => tab.id === 'timesheet')!.rows[0].dayValues!['2026-11-02']).toBe(
      '17',
    );
    localStorage.removeItem(STORAGE_KEY);
  });
});
