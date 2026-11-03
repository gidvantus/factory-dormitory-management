import type { PersonnelData } from '../../api/personnel';
import {
  employeeFieldValues,
  employeeListFields,
  employeeFieldOptions,
} from '../../workspace/personnel/employeeListFilters';
import { personName } from '../../workspace/personnel/helpers';
import { calculate, references } from '../constructor-sandbox/formula';
import { Sandbox } from '../constructor-sandbox/store';
import type { Column, PersonnelTab, RecordRow } from './model';
import type {
  CalculationRule,
  CalculationSource,
  CellResult,
  EvaluationContext,
  LinkFilter,
  LinkRule,
  ReferenceTarget,
  Scalar,
} from './calculationTypes';

let demoExternal: Sandbox | undefined;
const externalData = (): Sandbox => (demoExternal ??= new Sandbox());
const criteria = {
  filter: 'all' as const,
  dormitory: null,
  days: 7,
  query: '',
  scope: [],
  column_filters: [],
};
const metrics = [
  ['residents_total', 'Проживает всего'],
  ['residents_m', 'Проживает М'],
  ['residents_f', 'Проживает Ж'],
  ['paid_total', 'Оплачено мест'],
  ['paid_m', 'Оплачено М'],
  ['paid_f', 'Оплачено Ж'],
  ['free_total', 'Свободно мест'],
  ['free_m', 'Свободно М'],
  ['free_f', 'Свободно Ж'],
];
type SourceRecord = { id: string; read: (field: string) => Scalar[] };
const normalize = (value: Scalar): string =>
  String(value ?? '')
    .trim()
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е');
const fail = (message: string): never => {
  throw new Error(message);
};
export function isComputed(rule?: CalculationRule): boolean {
  return !!rule && rule.mode !== 'manual';
}
export function rowTitle(tab: PersonnelTab, row: RecordRow, data: PersonnelData): string {
  if (row.name?.trim()) return row.name.trim();
  const first = tab.columns.find((column) => !column.archived);
  const raw = first ? row.values[first.id] : '';
  return first?.kind === 'employee' && raw
    ? personName(
        data.employees.find(
          (person) => person.id === raw || person.member_ids.includes(String(raw)),
        ),
      )
    : String(raw || `Строка ${tab.rows.indexOf(row) + 1}`);
}
export function referenceTargets(
  tab: PersonnelTab,
  axis: 'column' | 'row',
  data: PersonnelData,
): ReferenceTarget[] {
  return axis === 'column'
    ? tab.columns
        .filter((column) => !column.archived)
        .map((column) => ({ id: column.id, name: column.name }))
    : tab.rows.map((row) => ({ id: row.id, name: rowTitle(tab, row, data) }));
}
export function bindFormula(
  expression: string,
  targets: ReferenceTarget[],
): Record<string, string> {
  return Object.fromEntries(
    references(expression).flatMap((name) => {
      const matches = targets.filter((target) => target.name === name);
      return matches.length === 1 ? [[name, matches[0].id]] : [];
    }),
  );
}
export function displayFormula(rule: CalculationRule, targets: ReferenceTarget[]): string {
  return rule.expression.replace(/\[([^[\]]+)\]/g, (whole, name: string) => {
    const target = targets.find((item) => item.id === rule.refs[name]);
    return target ? `[${target.name}]` : whole;
  });
}
export function numeric(value: Scalar): number {
  if (value === null || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 'Да') return 1;
  if (value === 'Нет') return 0;
  const number = typeof value === 'number' ? value : Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(number)) return fail(`«${String(value)}» не является числом`);
  return number;
}

export function calculationSources(
  tabs: PersonnelTab[],
  data: PersonnelData,
  externalSources?: CalculationSource[],
): CalculationSource[] {
  const result: CalculationSource[] = [
    {
      id: 'people',
      name: 'Реестр сотрудников',
      kind: 'people',
      fields: employeeListFields(data, criteria).map((field) => ({
        id: field.id,
        name: field.label,
        kind: field.kind,
        options: ['select', 'checkbox'].includes(field.kind)
          ? employeeFieldOptions(field, data, criteria)
          : undefined,
      })),
    },
    {
      id: 'arrivals',
      name: 'План заездов',
      kind: 'arrivals',
      fields: [
        {
          id: 'dormitory',
          name: 'Общежитие',
          kind: 'select',
          options: data.dormitories.map((dorm) => dorm.name),
        },
        { id: 'date', name: 'Дата заезда', kind: 'date' },
        { id: 'count', name: 'Количество человек', kind: 'number' },
      ],
    },
  ];
  result[0].fields.unshift({
    id: '$employee',
    name: 'Сотрудник (связь по карточке)',
    kind: 'employee',
  });
  for (const tab of tabs.filter((tab) => tab.kind === 'table' && !tab.isGroup && !tab.archived)) {
    const calendar = tab.tableOptions.table_format === 'calendar';
    result.push({
      id: `tab:${tab.id}`,
      name: `${tab.name} — Персонал${tab.hidden ? ' (скрыта)' : ''}`,
      kind: calendar ? 'calendar' : 'table',
      fields: [
        ...tab.columns
          .filter((column) => !column.archived)
          .map((column) => ({
            id: column.id,
            name: column.name,
            kind: column.kind,
            options: column.options,
          })),
        ...(calendar
          ? [
              { id: '$date', name: 'Дата', kind: 'date' as const },
              { id: '$value', name: 'Значение за день', kind: 'number' as const },
            ]
          : []),
      ],
      rows: calendar ? referenceTargets(tab, 'row', data) : undefined,
    });
  }
  if (externalSources)
    return [
      ...result,
      ...externalSources.filter((source) => !['people', 'arrivals'].includes(source.id)),
    ];
  for (const dorm of externalData().dorms) {
    for (const [table, columns] of Object.entries(dorm.settings.tables))
      result.push({
        id: `dorm:${dorm.info.id}:${table}`,
        name: `${dorm.settings.tabs.find((tab) => tab.table_key === table)?.name ?? dorm.settings.sections.find((section) => section.key === table)?.name ?? table} — ${dorm.info.name}`,
        kind: 'table',
        fields: columns
          .filter((column) => !column.archived && !['action', 'hostel'].includes(column.kind))
          .map((column) => ({
            id: String(column.id),
            name: column.name,
            kind: column.kind as Column['kind'],
            options: column.options.map((option) => option.label),
          })),
      });
    result.push({
      id: `report:${dorm.info.id}`,
      name: `Общий отчёт — ${dorm.info.name}`,
      kind: 'report',
      fields: [
        { id: '$date', name: 'Дата', kind: 'date' },
        { id: '$value', name: 'Значение строки', kind: 'number' },
      ],
      rows: dorm.rows.map((row) => ({ id: String(row.id), name: row.name })),
    });
    result.push({
      id: `places:${dorm.info.id}`,
      name: `Размещение персонала — ${dorm.info.name}`,
      kind: 'places',
      fields: [
        { id: '$date', name: 'Дата', kind: 'date' },
        {
          id: '$hostel',
          name: 'Хостел',
          kind: 'select',
          options: dorm.hostels.map((hostel) => hostel.name),
        },
        ...metrics.map(([id, name]) => ({ id, name, kind: 'number' as const })),
      ],
    });
  }
  return result;
}

export function ruleDependencies(
  tab: PersonnelTab,
  axis: 'column' | 'row',
  rule: CalculationRule | undefined,
  tabs: PersonnelTab[],
): string[] {
  if (!rule || rule.mode === 'manual') return [];
  if (rule.mode === 'formula')
    return Object.values(rule.refs).map((id) => `${tab.id}:${axis}:${id}`);
  const link = rule.link;
  if (!link) return [];
  const result = link.match ? [`${tab.id}:column:${link.match.localColumnId}`] : [];
  if (link.sourceId.startsWith('tab:')) {
    const source = tabs.find((item) => item.id === link.sourceId.slice(4));
    if (source) {
      for (const field of [
        ...(link.operation !== 'count' ? [link.valueField] : []),
        ...link.filters.map((filter) => filter.field),
        ...(link.dateField ? [link.dateField] : []),
        ...(link.match ? [link.match.sourceField] : []),
      ]) {
        if (!field.startsWith('$')) result.push(`${source.id}:column:${field}`);
      }
      if (source.tableOptions.table_format === 'calendar' && link.sourceRowId)
        result.push(`${source.id}:row:${link.sourceRowId}`);
    }
  }
  return [...new Set(result)];
}
export function dependents(
  tabs: PersonnelTab[],
  tabId: string,
  axis: 'column' | 'row',
  id: string,
): string[] {
  const key = `${tabId}:${axis}:${id}`;
  const result: string[] = [];
  for (const tab of tabs.filter((tab) => !tab.archived && !tab.isGroup && tab.kind === 'table')) {
    for (const column of tab.columns.filter((column) => !column.archived))
      if (ruleDependencies(tab, 'column', column.rule, tabs).includes(key))
        result.push(`${tab.name} → ${column.name}`);
    for (const row of tab.rows)
      if (ruleDependencies(tab, 'row', row.rule, tabs).includes(key))
        result.push(`${tab.name} → ${row.name || 'расчётная строка'}`);
  }
  return result;
}
export function sourceUsers(tabs: PersonnelTab[], tabIds: string[]): string[] {
  return tabs
    .filter(
      (tab) => !tab.archived && !tab.isGroup && tab.kind === 'table' && !tabIds.includes(tab.id),
    )
    .flatMap((tab) =>
      [
        ...tab.columns
          .filter((column) => !column.archived)
          .map((column) => ({ name: column.name, rule: column.rule })),
        ...tab.rows.map((row) => ({ name: row.name || 'Строка', rule: row.rule })),
      ]
        .filter(
          (item) =>
            item.rule?.mode === 'link' &&
            tabIds.some((id) => item.rule?.link?.sourceId === `tab:${id}`),
        )
        .map((item) => `${tab.name} → ${item.name}`),
    );
}
export function validateCalculations(
  tabs: PersonnelTab[],
  data: PersonnelData,
  externalSources?: CalculationSource[],
): string {
  const sources = calculationSources(tabs, data, externalSources);
  const edges = new Map<string, string[]>();
  const labels = new Map<string, string>();
  let owner = '';
  try {
    for (const tab of tabs.filter((tab) => !tab.archived && !tab.isGroup && tab.kind === 'table'))
      for (const axis of ['column', 'row'] as const) {
        const targets = referenceTargets(tab, axis, data);
        for (const target of targets) {
          const rule =
            axis === 'column'
              ? tab.columns.find((column) => column.id === target.id)?.rule
              : tab.rows.find((row) => row.id === target.id)?.rule;
          const key = `${tab.id}:${axis}:${target.id}`;
          owner = `${tab.name} → ${target.name}`;
          labels.set(key, `${tab.name} → ${target.name}`);
          if (!rule || rule.mode === 'manual') {
            edges.set(key, []);
            continue;
          }
          if (rule.mode === 'formula') {
            calculate(
              rule.expression,
              (name) => {
                const matches = targets.filter((item) => item.id === rule.refs[name]);
                if (matches.length !== 1) fail(`Не найдена или неоднозначна ссылка [${name}]`);
                return 1;
              },
              true,
            );
          } else {
            const link = rule.link ?? fail('Настройте источник связи');
            const source =
              sources.find((source) => source.id === link.sourceId) ??
              fail('Источник связи не найден или находится в архиве');
            const fields = [
              ...(link.operation !== 'count' ? [link.valueField] : []),
              ...link.filters.map((filter) => filter.field),
              ...(link.dateField ? [link.dateField] : []),
              ...(link.match ? [link.match.sourceField] : []),
            ];
            if (fields.some((field) => !source.fields.some((item) => item.id === field)))
              fail('В источнике не найден один из выбранных столбцов');
            if (source.rows && !source.rows.some((row) => row.id === link.sourceRowId))
              fail('Выберите строку источника');
            if (
              link.match &&
              !tab.columns.some(
                (column) => column.id === link.match!.localColumnId && !column.archived,
              )
            )
              fail('Столбец сопоставления не найден');
            if (
              link.filters.some(
                (filter) =>
                  !['not_empty', 'empty'].includes(filter.operator) && !filter.value.trim(),
              )
            )
              fail('Заполните значение каждого условия связи');
          }
          edges.set(key, ruleDependencies(tab, axis, rule, tabs));
        }
      }
    owner = '';
    const path: string[] = [];
    const done = new Set<string>();
    const visit = (key: string): void => {
      if (path.includes(key))
        fail(
          `Циклическая зависимость: ${[...path.slice(path.indexOf(key)), key].map((item) => labels.get(item) ?? item).join(' → ')}`,
        );
      if (done.has(key)) return;
      path.push(key);
      for (const dependency of edges.get(key) ?? []) {
        if (!edges.has(dependency)) fail(`Недоступная зависимость в ${labels.get(key)}`);
        visit(dependency);
      }
      path.pop();
      done.add(key);
    };
    for (const key of edges.keys()) visit(key);
  } catch (error) {
    return `${owner ? `${owner}: ` : ''}${error instanceof Error ? error.message : 'Проверьте расчёты'}`;
  }
  return '';
}

export function createCalculationEngine(
  tabs: PersonnelTab[],
  data: PersonnelData,
  context: EvaluationContext = {},
) {
  const sources = calculationSources(tabs, data);
  const cache = new Map<string, Scalar>();
  const stack = new Set<string>();
  const guarded = (key: string, action: () => Scalar): Scalar => {
    if (stack.has(key)) return fail('Циклическая зависимость расчётов');
    if (cache.has(key)) return cache.get(key)!;
    if (stack.size > 100) return fail('Слишком длинная цепочка расчётов');
    stack.add(key);
    try {
      const value = action();
      cache.set(key, value);
      return value;
    } finally {
      stack.delete(key);
    }
  };
  const result = (action: () => Scalar): CellResult => {
    try {
      return { value: action() };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : 'Ошибка расчёта' };
    }
  };
  const daysFor = (tab?: PersonnelTab): string[] => {
    if (context.day) return [context.day];
    if (context.range) {
      const from = Date.parse(context.range.from),
        to = Date.parse(context.range.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
      return Array.from({ length: Math.min(366, Math.round((to - from) / 86400000) + 1) }, (_, i) =>
        new Date(from + i * 86400000).toISOString().slice(0, 10),
      );
    }
    return [
      ...new Set(tab?.rows.flatMap((row) => Object.keys(row.dayValues ?? {})) ?? [data.today]),
    ].sort();
  };
  const scalarRecord = (id: string, values: Record<string, Scalar | Scalar[]>): SourceRecord => ({
    id,
    read: (field) => {
      if (!(field in values)) return fail('Столбец источника недоступен');
      const value = values[field];
      return Array.isArray(value) ? value : [value];
    },
  });
  function records(source: CalculationSource, day?: string): SourceRecord[] {
    if (source.id === 'people')
      return data.employees.map((person) => {
        const fields = employeeListFields(data, criteria);
        return scalarRecord(person.id, {
          $employee: person.id,
          ...Object.fromEntries(
            fields.map((field) => [field.id, employeeFieldValues(person, field, data, criteria)]),
          ),
        });
      });
    if (source.id === 'arrivals')
      return data.arrival_plans
        .filter((plan) => !plan.is_archived)
        .map((plan) =>
          scalarRecord(plan.id, {
            dormitory: data.dormitories.find((dorm) => dorm.id === plan.dormitory_id)?.name ?? '',
            date: plan.date,
            count: plan.count,
          }),
        );
    if (source.id.startsWith('tab:')) {
      const tab =
        tabs.find((tab) => tab.id === source.id.slice(4) && !tab.archived) ??
        fail('Таблица-источник недоступна');
      return tab.rows.flatMap((row) =>
        (source.kind === 'calendar' ? (day ? [day] : daysFor(tab)) : [undefined]).map((day) => ({
          id: `${row.id}:${day ?? ''}`,
          read: (field: string): Scalar[] =>
            field === '$row_id'
              ? [row.id]
              : field === '$date'
                ? [day ?? '']
                : field === '$value'
                  ? [rowValue(tab, row, day ?? data.today)]
                  : [columnValue(tab, row, field)],
        })),
      );
    }
    const [, dormId, table] = source.id.split(':');
    const dorm = externalData().dorm(dormId);
    if (source.id.startsWith('dorm:'))
      return (dorm.records[table] ?? []).map((row) => ({
        id: String(row.id),
        read: (field) => {
          const column =
            dorm.settings.tables[table].find(
              (column) => String(column.id) === field && !column.archived,
            ) ?? fail('Столбец общежития недоступен');
          const value = row.values[field];
          return [
            column.kind === 'select'
              ? (column.options.find((option) => option.id === value)?.label ?? String(value ?? ''))
              : (value ?? ''),
          ];
        },
      }));
    if (source.kind === 'report')
      return (day ? [day] : daysFor()).flatMap((day) => {
        const report = externalData().report(dormId, day, day);
        return report.rows.map((row) => ({
          id: `${row.id}:${day}`,
          read: (field: string): Scalar[] =>
            field === '$row_id'
              ? [String(row.id)]
              : field === '$date'
                ? [day]
                : row.errors[day]
                  ? fail(`Ошибка в общем отчёте: ${row.errors[day]}`)
                  : [row.values[day] ?? 0],
        }));
      });
    if (source.kind === 'places')
      return (day ? [day] : daysFor()).flatMap((day) =>
        dorm.hostels.map((hostel) => ({
          id: `${hostel.id}:${day}`,
          read: (field: string): Scalar[] =>
            field === '$date'
              ? [day]
              : field === '$hostel'
                ? [hostel.name]
                : [externalData().placeValue(dormId, field, hostel.id, day)],
        })),
      );
    return fail('Источник недоступен');
  }
  function matches(record: SourceRecord, filter: LinkFilter, source: CalculationSource): boolean {
    const values = record
      .read(filter.field)
      .filter((value) => value !== null && String(value).trim() !== '');
    if (filter.operator === 'empty') return !values.length;
    if (filter.operator === 'not_empty') return !!values.length;
    const field = source.fields.find((field) => field.id === filter.field)!;
    return values.some((value) =>
      filter.operator === 'contains'
        ? normalize(value).includes(normalize(filter.value))
        : filter.operator === 'equals'
          ? field.kind === 'number'
            ? numeric(value) === numeric(filter.value)
            : normalize(value) === normalize(filter.value)
          : field.kind === 'number'
            ? filter.operator === 'from'
              ? numeric(value) >= numeric(filter.value)
              : numeric(value) <= numeric(filter.value)
            : filter.operator === 'from'
              ? String(value) >= filter.value
              : String(value) <= filter.value,
    );
  }
  function linked(tab: PersonnelTab, row: RecordRow, link: LinkRule | null, day?: string): Scalar {
    if (!link) return fail('Связь не настроена');
    const source =
      sources.find((source) => source.id === link.sourceId) ??
      fail('Источник связи удалён или находится в архиве');
    if (source.rows && !source.rows.some((row) => row.id === link.sourceRowId))
      return fail('Строка источника удалена');
    const fields = [
      ...(link.operation !== 'count' ? [link.valueField] : []),
      ...link.filters.map((filter) => filter.field),
      ...(link.dateField ? [link.dateField] : []),
      ...(link.match ? [link.match.sourceField] : []),
    ];
    if (fields.some((id) => !source.fields.some((field) => field.id === id)))
      return fail('Столбец источника удалён или скрыт');
    const local = link.match ? columnValue(tab, row, link.match.localColumnId) : null;
    const targetDay = day ?? context.day;
    const candidates = records(source, targetDay).filter(
      (record) =>
        (!source.rows || record.read('$row_id').includes(link.sourceRowId)) &&
        (!link.match ||
          (local !== null &&
            String(local) !== '' &&
            record
              .read(link.match.sourceField)
              .some((value) => normalize(value) === normalize(local)))) &&
        link.filters.every((filter) => matches(record, filter, source)) &&
        (!link.dateField ||
          record.read(link.dateField).some((value) => {
            const date = String(value ?? '');
            return (
              !!date &&
              (targetDay
                ? date === targetDay
                : context.range
                  ? date >= context.range.from && date <= context.range.to
                  : true)
            );
          })),
    );
    const empty = (): Scalar =>
      link.empty === 'error'
        ? fail('Подходящих записей не найдено')
        : link.empty === 'blank'
          ? ''
          : 0;
    if (link.operation === 'count') return candidates.length;
    if (!candidates.length) return empty();
    if (link.operation === 'lookup') {
      if (candidates.length !== 1)
        return fail(
          `Ожидалась одна запись, найдено ${candidates.length}. Уточните сопоставление или выберите агрегацию`,
        );
      const values = candidates[0]
        .read(link.valueField)
        .filter((value) => value !== null && value !== '');
      if (values.length > 1) return fail('В записи источника несколько значений');
      return values[0] ?? empty();
    }
    const numbers = candidates
      .flatMap((record) => record.read(link.valueField))
      .filter((value) => value !== null && value !== '')
      .map(numeric);
    if (!numbers.length) return empty();
    const value =
      link.operation === 'sum'
        ? numbers.reduce((sum, value) => sum + value, 0)
        : link.operation === 'average'
          ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
          : link.operation === 'min'
            ? Math.min(...numbers)
            : Math.max(...numbers);
    if (!Number.isFinite(value) || Math.abs(value) > 1e15)
      return fail('Результат вне допустимого диапазона');
    return value;
  }
  function apply(
    tab: PersonnelTab,
    row: RecordRow,
    rule: CalculationRule,
    axis: 'column' | 'row',
    day?: string,
  ): Scalar {
    if (rule.mode === 'link') return linked(tab, row, rule.link, day);
    return calculate(rule.expression, (name) => {
      const id = rule.refs[name];
      if (!id) return fail(`Не найдена ссылка [${name}]`);
      if (axis === 'column') return numeric(columnValue(tab, row, id));
      const target = tab.rows.find((row) => row.id === id) ?? fail(`Не найдена строка [${name}]`);
      return numeric(rowValue(tab, target, day ?? data.today));
    });
  }
  function columnValue(tab: PersonnelTab, row: RecordRow, columnId: string): Scalar {
    return guarded(`${tab.id}:column:${row.id}:${columnId}`, () => {
      const column =
        tab.columns.find((column) => column.id === columnId && !column.archived) ??
        fail('Столбец зависимости удалён или скрыт');
      return isComputed(column.rule)
        ? apply(tab, row, column.rule!, 'column')
        : (row.values[column.id] ?? '');
    });
  }
  function rowValue(tab: PersonnelTab, row: RecordRow, day: string): Scalar {
    return guarded(`${tab.id}:row:${row.id}:${day}`, () =>
      isComputed(row.rule) ? apply(tab, row, row.rule!, 'row', day) : (row.dayValues?.[day] ?? ''),
    );
  }
  return {
    sources,
    column: (tab: PersonnelTab, row: RecordRow, columnId: string) =>
      result(() => columnValue(tab, row, columnId)),
    day: (tab: PersonnelTab, row: RecordRow, day: string) => result(() => rowValue(tab, row, day)),
  };
}
