import type { Block, PersonnelData } from '../../api/personnel';
import type { CustomTabOptions } from '../../api/client';
import { defaultTabOptions } from '../../workspace/dormitories/customTabOptions';
import type { ListCriteria } from '../../workspace/personnel/employeeListFilters';
import { defaultBlocks } from '../../workspace/personnel/helpers';
import { Sandbox } from '../constructor-sandbox/store';
import type { CalculationRule } from './calculationTypes';
import type { CalculationSource } from './calculationTypes';
import { validateCalculations } from './calculations';

export type TabKind = 'employees' | 'table' | 'blocks' | 'planning';
export type ColumnKind = 'employee' | 'text' | 'number' | 'date' | 'select' | 'checkbox';
export type Column = {
  id: string;
  name: string;
  kind: ColumnKind;
  options: string[];
  required: boolean;
  archived: boolean;
  rule?: CalculationRule;
  manualSettings?: { kind: ColumnKind; required: boolean };
};
export type RecordRow = {
  id: string;
  values: Record<string, string | boolean>;
  dayValues?: Record<string, string>;
  name?: string;
  rule?: CalculationRule;
  includeInTotals?: boolean;
};
export type PersonnelTab = {
  id: string;
  name: string;
  description: string;
  kind: TabKind;
  builtin: boolean;
  hidden: boolean;
  archived: boolean;
  parentId: string | null;
  isGroup: boolean;
  tableOptions: CustomTabOptions;
  dateColumnId: string | null;
  criteria: ListCriteria;
  fields: string[];
  columns: Column[];
  rows: RecordRow[];
  blocks: Block[];
  actions: { search: boolean; filters: boolean; export: boolean; add: boolean; remove: boolean };
};
export type DemoState = { version: 3; tabs: PersonnelTab[]; defaultTab: string };
export const STORAGE_KEY = 'domovoy-personnel-tab-builder-v1';
export const kindNames: Record<TabKind, string> = {
  employees: 'Список сотрудников',
  table: 'Своя таблица',
  blocks: 'Рабочие блоки',
  planning: 'План заездов',
};
export const columnNames: Record<ColumnKind, string> = {
  employee: 'Сотрудник из реестра',
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  select: 'Выпадающий список',
  checkbox: 'Чекбокс',
};
export function newColumn(): Column {
  return {
    id: crypto.randomUUID(),
    name: '',
    kind: 'text',
    options: [],
    required: false,
    archived: false,
  };
}
export function newTab(): PersonnelTab {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    kind: 'employees',
    builtin: false,
    hidden: false,
    archived: false,
    parentId: null,
    isGroup: false,
    tableOptions: { ...defaultTabOptions },
    dateColumnId: null,
    criteria: { filter: 'all', dormitory: null, days: 7, query: '', scope: [], column_filters: [] },
    fields: ['personnel_number', 'phone', 'shift_end'],
    columns: [newColumn()],
    rows: [],
    blocks: structuredClone(defaultBlocks.slice(0, 2)),
    actions: { search: true, filters: true, export: true, add: true, remove: true },
  };
}
export function seedData(): PersonnelData {
  const data = new Sandbox().personnel;
  data.today = '2026-11-02';
  return data;
}
export function emptyBuilderState(): DemoState {
  return {
    version: 3,
    defaultTab: 'workspace',
    tabs: (
      [
        ['workspace', 'Рабочая поверхность', 'blocks'],
        ['employees', 'Сотрудники', 'employees'],
        ['planning', 'План заездов', 'planning'],
      ] as const
    ).map(([id, name, kind]) => ({ ...newTab(), id, name, kind, builtin: true })),
  };
}
export function initialState(): DemoState {
  const workspace: PersonnelTab = {
    ...newTab(),
    id: 'workspace',
    name: 'Рабочая поверхность',
    kind: 'blocks',
    builtin: true,
    blocks: structuredClone(defaultBlocks),
  };
  const employees: PersonnelTab = {
    ...newTab(),
    id: 'employees',
    name: 'Сотрудники',
    builtin: true,
  };
  const planning: PersonnelTab = {
    ...newTab(),
    id: 'planning',
    name: 'План заездов',
    kind: 'planning',
    builtin: true,
  };
  const ending: PersonnelTab = {
    ...newTab(),
    id: 'ending',
    name: 'Заканчивается вахта',
    description: 'Сотрудники, у которых вахта заканчивается в ближайшие 7 дней.',
    criteria: { ...newTab().criteria, filter: 'ending' },
    fields: ['phone', 'shift_end'],
  };
  const documents: PersonnelTab = {
    ...newTab(),
    id: 'documents',
    name: 'Учёт документов',
    kind: 'table',
    description: 'Отдельная таблица для работы кадровой службы.',
    columns: [
      { ...newColumn(), id: 'employee', name: 'Сотрудник', kind: 'employee', required: true },
      { ...newColumn(), id: 'document', name: 'Документ', required: true },
      {
        ...newColumn(),
        id: 'status',
        name: 'Статус',
        kind: 'select',
        options: ['Ожидаем', 'Получен', 'Нужно обновить'],
      },
      { ...newColumn(), id: 'date', name: 'Действует до', kind: 'date' },
      { ...newColumn(), id: 'checked', name: 'Проверен', kind: 'checkbox' },
    ],
    rows: [
      {
        id: 'document-1',
        values: {
          employee: 'employee-0',
          document: 'Медицинская книжка',
          status: 'Нужно обновить',
          date: '2026-11-10',
          checked: false,
        },
      },
      {
        id: 'document-2',
        values: {
          employee: 'employee-1',
          document: 'Удостоверение',
          status: 'Получен',
          date: '2027-04-15',
          checked: true,
        },
      },
      {
        id: 'document-3',
        values: {
          employee: 'employee-2',
          document: 'Справка',
          status: 'Ожидаем',
          date: '',
          checked: false,
        },
      },
    ],
  };
  return {
    version: 3,
    tabs: [
      workspace,
      employees,
      planning,
      ending,
      documents,
      timesheetExample(),
      ...calculationExamples(),
    ],
    defaultTab: 'ending',
  };
}
export function loadState(): DemoState {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as
      (Omit<DemoState, 'version'> & { version: number }) | null;
    if (
      (value?.version === 1 || value?.version === 2 || value?.version === 3) &&
      Array.isArray(value.tabs) &&
      ['workspace', 'employees', 'planning'].every((id) =>
        value.tabs.some((tab) => tab.id === id && tab.builtin),
      ) &&
      value.tabs.every(
        (tab) =>
          typeof tab.id === 'string' &&
          typeof tab.name === 'string' &&
          kindNames[tab.kind] &&
          tab.criteria &&
          Array.isArray(tab.fields) &&
          Array.isArray(tab.columns) &&
          Array.isArray(tab.rows) &&
          Array.isArray(tab.blocks) &&
          tab.actions,
      )
    )
      return {
        ...value,
        version: 3,
        tabs: [
          ...value.tabs.map((tab) => ({
            ...tab,
            parentId: tab.parentId ?? null,
            isGroup: tab.isGroup ?? false,
            dateColumnId: tab.dateColumnId ?? null,
            tableOptions: {
              ...defaultTabOptions,
              ...(tab.tableOptions ?? {
                add_row: tab.actions.add,
                row_actions: tab.actions.remove,
              }),
            },
          })),
          ...(value.version === 1 && !value.tabs.some((tab) => tab.id === 'timesheet')
            ? [timesheetExample()]
            : []),
          ...(value.version < 3 && !value.tabs.some((tab) => tab.id === 'demo-calculations')
            ? calculationExamples()
            : []),
        ],
      };
  } catch {
    /* Повреждённый или недоступный локальный пример заменяется исходным. */
  }
  return initialState();
}
export function move<T>(items: T[], index: number, step: -1 | 1): T[] {
  const other = index + step;
  if (other < 0 || other >= items.length) return items;
  const next = [...items];
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}
export function validateTab(
  tab: PersonnelTab,
  tabs: PersonnelTab[],
  data?: PersonnelData,
  sources?: CalculationSource[],
): string {
  const normalize = (value: string): string =>
    value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
  if (!normalize(tab.name)) return 'Укажите название подвкладки.';
  if (tabs.some((item) => item.id !== tab.id && normalize(item.name) === normalize(tab.name)))
    return 'Подвкладка с таким названием уже есть, включая скрытые и архивные.';
  if (tab.kind === 'table') {
    const columns = tab.columns.filter((column) => !column.archived);
    if (!columns.length) return 'Добавьте хотя бы один столбец.';
    if (columns.some((column) => !normalize(column.name))) return 'Заполните названия столбцов.';
    if (new Set(columns.map((column) => normalize(column.name))).size !== columns.length)
      return 'Названия столбцов должны отличаться.';
    if (
      columns.some(
        (column) =>
          column.rule?.mode !== 'link' &&
          column.kind === 'select' &&
          !column.options.some((option) => option.trim()),
      )
    )
      return 'Добавьте варианты для каждого выпадающего списка.';
    if (
      tab.tableOptions.table_format === 'list' &&
      tab.tableOptions.period_mode !== 'none' &&
      !columns.some((column) => column.id === tab.dateColumnId && column.kind === 'date')
    )
      return 'Выберите действующий столбец даты для фильтрации периода.';
  }
  if (tab.kind === 'blocks' && !tab.blocks.length) return 'Выберите хотя бы один рабочий блок.';
  if (data && tab.kind === 'table')
    return validateCalculations([...tabs.filter((item) => item.id !== tab.id), tab], data, sources);
  return '';
}

export function calculationExamples(): PersonnelTab[] {
  const group: PersonnelTab = {
    ...newTab(),
    id: 'demo-calculations',
    name: 'Примеры расчётов',
    kind: 'table',
    isGroup: true,
    description:
      'Рабочие примеры формул и связей. Измените ставку или часы — результат пересчитается.',
    columns: [{ ...newColumn(), name: 'Показатель' }],
  };
  const rates: PersonnelTab = {
    ...newTab(),
    id: 'demo-rates',
    parentId: group.id,
    name: 'Ставки',
    kind: 'table',
    description: 'Источник ставок для расчёта оплаты. Его записи можно менять.',
    columns: [
      { ...newColumn(), id: 'rate-person', name: 'Сотрудник', kind: 'employee', required: true },
      { ...newColumn(), id: 'hour-price', name: 'Ставка за час', kind: 'number', required: true },
    ],
    rows: [
      { id: 'rate-1', values: { 'rate-person': 'employee-0', 'hour-price': '350' } },
      { id: 'rate-2', values: { 'rate-person': 'employee-1', 'hour-price': '400' } },
    ],
  };
  const payroll: PersonnelTab = {
    ...newTab(),
    id: 'demo-payroll',
    parentId: group.id,
    name: 'Расчёт оплаты',
    kind: 'table',
    description:
      'Ставка подтягивается по сотруднику. Оплата считается по формуле «Часы × Ставка + Доплата».',
    columns: [
      { ...newColumn(), id: 'pay-person', name: 'Сотрудник', kind: 'employee', required: true },
      { ...newColumn(), id: 'pay-hours', name: 'Часы', kind: 'number' },
      { ...newColumn(), id: 'pay-bonus', name: 'Доплата', kind: 'number' },
      {
        ...newColumn(),
        id: 'pay-rate',
        name: 'Ставка',
        kind: 'number',
        rule: {
          mode: 'link',
          expression: '=',
          refs: {},
          link: {
            sourceId: `tab:${rates.id}`,
            operation: 'lookup',
            valueField: 'hour-price',
            sourceRowId: null,
            match: { sourceField: 'rate-person', localColumnId: 'pay-person' },
            filters: [],
            dateField: null,
            empty: 'error',
          },
        },
      },
      {
        ...newColumn(),
        id: 'pay-total',
        name: 'Оплата',
        kind: 'number',
        rule: {
          mode: 'formula',
          expression: '=([Часы]*[Ставка])+[Доплата]',
          refs: { Часы: 'pay-hours', Ставка: 'pay-rate', Доплата: 'pay-bonus' },
          link: null,
        },
      },
    ],
    rows: [
      { id: 'pay-1', values: { 'pay-person': 'employee-0', 'pay-hours': '8', 'pay-bonus': '500' } },
      { id: 'pay-2', values: { 'pay-person': 'employee-1', 'pay-hours': '12', 'pay-bonus': '0' } },
    ],
  };
  const daily: PersonnelTab = {
    ...newTab(),
    id: 'demo-daily',
    parentId: group.id,
    name: 'План и факт',
    kind: 'table',
    description:
      'Формулы и связи рассчитывают каждый день отдельно; зелёные поля заполняются автоматически.',
    tableOptions: {
      ...defaultTabOptions,
      table_format: 'calendar',
      period_mode: 'month',
      clear_list: true,
    },
    columns: [{ ...newColumn(), id: 'metric', name: 'Показатель', kind: 'text' }],
    rows: [
      {
        id: 'day-plan',
        name: 'План',
        values: { metric: 'План' },
        dayValues: { '2026-11-01': '8', '2026-11-02': '8', '2026-11-03': '8' },
        includeInTotals: false,
      },
      {
        id: 'day-fact',
        name: 'Факт',
        values: { metric: 'Факт' },
        dayValues: { '2026-11-01': '7', '2026-11-02': '9', '2026-11-03': '8' },
      },
      {
        id: 'day-difference',
        name: 'Отклонение',
        values: { metric: 'Отклонение' },
        rule: {
          mode: 'formula',
          expression: '=[Факт]-[План]',
          refs: { Факт: 'day-fact', План: 'day-plan' },
          link: null,
        },
        includeInTotals: false,
      },
      {
        id: 'day-arrivals',
        name: 'Ожидается заезд',
        values: { metric: 'Ожидается заезд' },
        rule: {
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
          },
        },
        includeInTotals: false,
      },
    ],
  };
  return [group, rates, payroll, daily];
}

export function timesheetExample(): PersonnelTab {
  return {
    ...newTab(),
    id: 'timesheet',
    name: 'Учёт смен',
    kind: 'table',
    description: 'Ручной учёт по дням: строки сохраняются между месяцами.',
    tableOptions: {
      ...defaultTabOptions,
      table_format: 'calendar',
      period_mode: 'month',
      clear_list: true,
    },
    columns: [
      { ...newColumn(), id: 'shift-person', name: 'Сотрудник', kind: 'employee', required: true },
      { ...newColumn(), id: 'shift-task', name: 'Работа', kind: 'text' },
    ],
    rows: [
      {
        id: 'shift-1',
        values: { 'shift-person': 'employee-0', 'shift-task': 'Дневная смена' },
        dayValues: { '2026-11-01': '8', '2026-11-02': '8', '2026-11-03': '6' },
      },
      {
        id: 'shift-2',
        values: { 'shift-person': 'employee-1', 'shift-task': 'Ночная смена' },
        dayValues: { '2026-11-01': '12', '2026-11-02': 'В', '2026-11-03': '12' },
      },
    ],
  };
}

export function cloneTable(
  source: PersonnelTab,
  name = '',
  includeRows = false,
  targetId?: string,
): PersonnelTab {
  const ids = new Map(source.columns.map((column) => [column.id, crypto.randomUUID()]));
  const rows = new Map(source.rows.map((row) => [row.id, crypto.randomUUID()]));
  const target = newTab();
  if (targetId) target.id = targetId;
  const remap = (
    rule: CalculationRule | undefined,
    axis: 'column' | 'row',
  ): CalculationRule | undefined =>
    rule
      ? {
          ...structuredClone(rule),
          refs: Object.fromEntries(
            Object.entries(rule.refs).map(([name, id]) => [
              name,
              (axis === 'column' ? ids : rows).get(id) ?? id,
            ]),
          ),
          link: rule.link
            ? {
                ...structuredClone(rule.link),
                sourceId:
                  rule.link.sourceId === `tab:${source.id}`
                    ? `tab:${target.id}`
                    : rule.link.sourceId,
                valueField:
                  rule.link.sourceId === `tab:${source.id}`
                    ? (ids.get(rule.link.valueField) ?? rule.link.valueField)
                    : rule.link.valueField,
                sourceRowId:
                  rule.link.sourceId === `tab:${source.id}`
                    ? (rows.get(rule.link.sourceRowId ?? '') ?? null)
                    : rule.link.sourceRowId,
                dateField:
                  rule.link.sourceId === `tab:${source.id}`
                    ? (ids.get(rule.link.dateField ?? '') ?? rule.link.dateField)
                    : rule.link.dateField,
                filters: rule.link.filters.map((filter) => ({
                  ...filter,
                  field:
                    rule.link!.sourceId === `tab:${source.id}`
                      ? (ids.get(filter.field) ?? filter.field)
                      : filter.field,
                })),
                match: rule.link.match
                  ? {
                      sourceField:
                        rule.link.sourceId === `tab:${source.id}`
                          ? (ids.get(rule.link.match.sourceField) ?? rule.link.match.sourceField)
                          : rule.link.match.sourceField,
                      localColumnId:
                        ids.get(rule.link.match.localColumnId) ?? rule.link.match.localColumnId,
                    }
                  : null,
              }
            : null,
        }
      : undefined;
  return {
    ...target,
    name,
    kind: 'table',
    description: source.description,
    actions: { ...source.actions },
    tableOptions: { ...source.tableOptions },
    dateColumnId: ids.get(source.dateColumnId ?? '') ?? null,
    columns: source.columns.map((column) => ({
      ...structuredClone(column),
      id: ids.get(column.id)!,
      rule: remap(column.rule, 'column'),
    })),
    rows: includeRows
      ? source.rows.map((row, index) => ({
          id: rows.get(row.id)!,
          name: row.name || `Строка ${index + 1}`,
          values: {},
          dayValues: {},
          rule: remap(row.rule, 'row'),
          includeInTotals: row.includeInTotals,
        }))
      : [],
  };
}

export function dormitoryTableTemplates(): { label: string; tab: PersonnelTab }[] {
  return new Sandbox().dorms.flatMap((dorm) =>
    dorm.settings.tabs
      .filter((tab) => tab.table_created)
      .map((source) => {
        const tab = newTab();
        tab.kind = 'table';
        tab.name = source.name;
        tab.columns = dorm.settings.tables[source.table_key]
          .filter((column) => !['action', 'hostel'].includes(column.kind))
          .map((column) => ({
            id: String(column.id),
            name: column.name,
            kind: column.kind as ColumnKind,
            required: false,
            archived: column.archived,
            options: column.options
              .filter((option) => !option.archived)
              .map((option) => option.label),
          }));
        tab.tableOptions = { ...defaultTabOptions, ...source.options };
        tab.dateColumnId = source.options?.date_column_id
          ? String(source.options.date_column_id)
          : null;
        return { label: `${source.name} — ${dorm.info.name}`, tab };
      }),
  );
}

export function isTabVisible(tab: PersonnelTab, tabs: PersonnelTab[]): boolean {
  if (tab.hidden || tab.archived) return false;
  const parent = tab.parentId ? tabs.find((item) => item.id === tab.parentId) : null;
  return !tab.parentId || (!!parent && !parent.hidden && !parent.archived);
}

export function reorderTabs(tabs: PersonnelTab[], id: string, step: -1 | 1): PersonnelTab[] {
  const tab = tabs.find((item) => item.id === id);
  if (!tab || tab.builtin) return tabs;
  const siblings = tabs.filter(
    (item) => !item.builtin && !item.archived && item.parentId === tab.parentId,
  );
  const next = move(
    siblings,
    siblings.findIndex((item) => item.id === id),
    step,
  );
  let index = 0;
  return tabs.map((item) =>
    siblings.some((sibling) => sibling.id === item.id) ? next[index++] : item,
  );
}

export function tableDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`),
    end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  return Array.from(
    { length: Math.min(366, Math.round((end - start) / 86400000) + 1) },
    (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10),
  );
}

export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const [year, number] = month.split('-').map(Number);
  return { from, to: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10) };
}
