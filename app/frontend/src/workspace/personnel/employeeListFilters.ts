import type {
  Employee,
  EmployeeColumnFilter,
  PersonnelData,
  PersonnelSourceColumn,
  SavedList,
  Source,
} from '../../api/personnel';

export type ListCriteria = Omit<SavedList, 'id' | 'name'>;
export type EmployeeListField = {
  id: string;
  label: string;
  kind: PersonnelSourceColumn['kind'];
  table?: string;
  columns?: PersonnelSourceColumn[];
};
const standardFields: EmployeeListField[] = [
  { id: 'residence_status', label: 'Статус проживания', kind: 'select' },
  { id: 'full_name', label: 'Сотрудник / ФИО', kind: 'text' },
  { id: 'personnel_number', label: 'Табельный номер', kind: 'text' },
  { id: 'phone', label: 'Телефон', kind: 'text' },
  { id: 'dormitory', label: 'Общежитие проживания', kind: 'select' },
  { id: 'hostel_name', label: 'Место проживания', kind: 'text' },
  { id: 'shift_start', label: 'Начало вахты', kind: 'date' },
  { id: 'shift_end', label: 'Окончание вахты', kind: 'date' },
];
const normalize = (text: string): string =>
  text.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ');
export const sourceColumnFieldId = (column: PersonnelSourceColumn): string =>
  `source:${column.table_key}:${column.builtin_key ?? normalize(column.name)}:${column.kind}`;

export function sourceInScope(
  source: Pick<Source, 'dormitory_id'>,
  criteria: ListCriteria,
): boolean {
  return (
    (criteria.dormitory == null || source.dormitory_id === criteria.dormitory) &&
    (!criteria.scope.length || criteria.scope.includes(source.dormitory_id))
  );
}
export function employeeListFields(
  data: PersonnelData,
  criteria: ListCriteria,
): EmployeeListField[] {
  const sourceFields = new Map<string, EmployeeListField>();
  for (const column of data.source_columns ?? []) {
    if (!sourceInScope(column, criteria)) continue;
    const id = sourceColumnFieldId(column);
    const existing = sourceFields.get(id);
    if (existing) existing.columns!.push(column);
    else
      sourceFields.set(id, {
        id,
        label: `${column.source_name} · ${column.name}`,
        kind: column.kind,
        table: column.table_key,
        columns: [column],
      });
  }
  return [
    ...standardFields,
    ...[...sourceFields.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru')),
  ];
}
function scalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
function sourceValues(field: EmployeeListField, source: Source): string[] {
  return (field.columns ?? [])
    .filter(
      (column) =>
        column.dormitory_id === source.dormitory_id && column.table_key === source.table_key,
    )
    .map((column) => {
      const raw = column.builtin_key
        ? source.values[column.builtin_key]
        : (source.values.custom_values as Record<string, unknown> | undefined)?.[String(column.id)];
      const text = scalar(raw);
      return column.kind === 'select'
        ? (column.options.find((option) => option.id === text)?.label ?? text)
        : text;
    });
}
export function employeeFieldValues(
  person: Employee,
  field: EmployeeListField,
  data: PersonnelData,
  criteria: ListCriteria,
): string[] {
  const current = person.current.filter((source) => sourceInScope(source, criteria));
  let values: string[];
  if (field.table)
    values = person.sources
      .filter((source) => sourceInScope(source, criteria))
      .flatMap((source) => sourceValues(field, source));
  else if (field.id === 'residence_status')
    values = [current.length ? 'Проживает' : 'Вне общежитий'];
  else if (field.id === 'dormitory')
    values = current.map(
      (source) => data.dormitories.find((dorm) => dorm.id === source.dormitory_id)?.name ?? '',
    );
  else if (field.id === 'full_name' || field.id === 'personnel_number' || field.id === 'phone')
    values = [person[field.id] ?? '', ...(person.variants[field.id] ?? [])];
  else values = current.map((source) => scalar(source.values[field.id]));
  return [...new Set(values.filter((text) => text.trim()))];
}
export function employeeFieldOptions(
  field: EmployeeListField,
  data: PersonnelData,
  criteria: ListCriteria,
): string[] {
  const values = data.employees.flatMap((person) =>
    employeeFieldValues(person, field, data, criteria),
  );
  if (field.id === 'residence_status') values.push('Проживает', 'Вне общежитий');
  if (field.kind === 'checkbox') values.push('Да', 'Нет');
  if (field.kind === 'select')
    values.push(
      ...(field.columns ?? []).flatMap((column) => column.options.map((option) => option.label)),
    );
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
}
export function activeColumnFilter(rule: EmployeeColumnFilter): boolean {
  return rule.operator === 'empty' || rule.operator === 'filled' || !!rule.value.trim();
}
function matchesValues(
  values: string[],
  rule: EmployeeColumnFilter,
  field: EmployeeListField,
): boolean {
  const filled = values.filter((text) => text.trim());
  if (rule.operator === 'empty') return !filled.length;
  if (rule.operator === 'filled') return !!filled.length;
  const expected = normalize(rule.value);
  return filled.some((text) => {
    const actual = normalize(text);
    if (rule.operator === 'contains') {
      if (field.id === 'phone' && /^[+\d\s()-]+$/.test(expected) && /\d/.test(expected))
        return actual.replace(/\D/g, '').includes(expected.replace(/\D/g, ''));
      return actual.includes(expected);
    }
    if (field.kind === 'number') {
      const a = Number(actual.replace(',', '.')),
        b = Number(expected.replace(',', '.'));
      return (
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        (rule.operator === 'equals' ? a === b : rule.operator === 'from' ? a >= b : a <= b)
      );
    }
    if (rule.operator === 'equals') return actual === expected;
    return rule.operator === 'from' ? actual >= expected : actual <= expected;
  });
}
export function columnFilterPredicate(
  data: PersonnelData,
  criteria: ListCriteria,
): (person: Employee) => boolean {
  const fields = new Map(employeeListFields(data, criteria).map((field) => [field.id, field]));
  const rules = (criteria.column_filters ?? []).filter(activeColumnFilter);
  return (person) => {
    const groups = new Map<string, { rule: EmployeeColumnFilter; field: EmployeeListField }[]>();
    for (const rule of rules) {
      const field = fields.get(rule.field);
      if (!field) return false;
      if (!field.table) {
        if (!matchesValues(employeeFieldValues(person, field, data, criteria), rule, field))
          return false;
      } else {
        const group = groups.get(field.table) ?? [];
        group.push({ rule, field });
        groups.set(field.table, group);
      }
    }
    for (const [table, group] of groups) {
      if (
        !person.sources.some(
          (source) =>
            source.table_key === table &&
            sourceInScope(source, criteria) &&
            group.every(
              ({ rule, field }) =>
                field.columns?.some((column) => column.dormitory_id === source.dormitory_id) &&
                matchesValues(sourceValues(field, source), rule, field),
            ),
        )
      )
        return false;
    }
    return true;
  };
}
