import { calculate } from '../constructor-sandbox/formula';

export const dormitories = [
  { id: 'north', name: 'Общежитие «Северное»' },
  { id: 'river', name: 'Общежитие «Речное»' },
] as const;

export type Dormitory = (typeof dormitories)[number]['id'];
export type Mode = 'manual' | 'formula' | 'source';
export type FormulaPart = string | { rowId: string | null; name: string };

export const sources = {
  residents: {
    name: 'Проживающие',
    options: { m: 'Мужчины', f: 'Женщины', all: 'Все проживающие' },
  },
  inflow: { name: 'Приток', options: { all: 'Записи за день' } },
  outflow: { name: 'Отток', options: { all: 'Записи за день' } },
  report: { name: 'Общий отчёт', options: { exit: 'Выход Итого', absence: 'Прогульщики' } },
} as const;

export type SourceTable = keyof typeof sources;

export interface Row {
  id: string;
  name: string;
  mode: Mode;
  formula: FormulaPart[];
  source: SourceTable;
  indicator: string;
  highlight?: boolean;
}

export interface Hostel {
  id: string;
  name: string;
  dormitory: Dormitory;
  rows: Row[];
  values: Record<string, Record<number, string>>;
}

export interface Template {
  id: string;
  name: string;
  dormitory: Dormitory;
  rows: Row[];
}

export interface Demo {
  hostels: Hostel[];
  templates: Template[];
}

export const days = [8, 9, 10, 11, 12, 13, 14];
export const sampleDay = 14;
export const modeNames: Record<Mode, string> = {
  manual: 'Ручной ввод',
  formula: 'Формула',
  source: 'Связь с таблицей',
};

export function sourceOptions(source: SourceTable): [string, string][] {
  return Object.entries(sources[source].options);
}

export function demoId(): string {
  return (
    crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-')
  );
}

export function makeRow(id: string = demoId(), name = ''): Row {
  return { id, name, mode: 'manual', formula: [], source: 'residents', indicator: 'all' };
}

export function readFormula(input: string, rows: Row[]): FormulaPart[] {
  return input.split(/(\[[^[\]]+\])/u).map((part) => {
    if (!part.startsWith('[') || !part.endsWith(']')) return part;
    const name = part.slice(1, -1);
    const row = rows.find((item) => item.name.trim() === name);
    return { rowId: row?.id ?? null, name };
  });
}

export function showFormula(parts: FormulaPart[], rows: Row[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      return `[${rows.find((row) => row.id === part.rowId)?.name.trim() || part.name}]`;
    })
    .join('');
}

function formulaExpression(parts: FormulaPart[]): string {
  return parts
    .map((part, index) => (typeof part === 'string' ? part : `[${index}]`))
    .join('')
    .trim();
}

const residents = {
  'north-main': { m: [57, 57, 58, 58, 59, 59, 59], f: [39, 40, 40, 41, 41, 41, 41] },
  'river-main': { m: [22, 24, 24, 24, 24, 25, 25], f: [16, 16, 16, 17, 18, 18, 18] },
};

function linkedValue(hostel: Hostel, row: Row, day: number): number {
  const index = days.indexOf(day);
  if (row.source === 'residents') {
    const sample = residents[hostel.id as keyof typeof residents];
    const men = sample?.m[index] ?? 0;
    const women = sample?.f[index] ?? 0;
    if (row.indicator === 'm') return men;
    if (row.indicator === 'f') return women;
    return men + women;
  }
  const north = hostel.dormitory === 'north';
  if (row.source === 'inflow')
    return (north ? [2, 3, 1, 2, 2, 1, 1] : [0, 2, 0, 1, 1, 2, 0])[index];
  if (row.source === 'outflow')
    return (north ? [1, 2, 0, 1, 1, 1, 1] : [0, 0, 0, 0, 1, 1, 0])[index];
  if (row.indicator === 'absence')
    return (north ? [4, 3, 4, 3, 3, 4, 4] : [0, 1, 0, 0, 0, 1, 1])[index];
  return (north ? [81, 83, 84, 85, 87, 86, 86] : [34, 36, 36, 37, 38, 40, 40])[index];
}

export type Cell = { value: number | null; error?: string };

export function evaluate(hostel: Hostel, day: number, validate = false): Map<string, Cell> {
  const result = new Map<string, Cell>();
  const byId = new Map(hostel.rows.map((row) => [row.id, row]));
  const evaluating = new Set<string>();

  function read(id: string): number | null {
    if (evaluating.has(id)) throw new Error('Строки ссылаются друг на друга по кругу.');
    const previous = result.get(id);
    if (previous?.error) throw new Error(previous.error);
    if (previous) return previous.value;
    const row = byId.get(id);
    if (!row) throw new Error('Проверьте ссылки на строки в формуле.');
    if (row.mode === 'manual') {
      const raw = hostel.values[id]?.[day];
      return raw ? Number(raw) : null;
    }
    if (row.mode === 'source') return linkedValue(hostel, row, day);

    evaluating.add(id);
    let hasValue = false;
    try {
      const number = calculate(
        formulaExpression(row.formula),
        (reference) => {
          const part = row.formula[Number(reference)];
          if (typeof part !== 'object' || part.rowId === null) {
            throw new Error(
              `Строка «${typeof part === 'object' ? part.name : reference}» не найдена.`,
            );
          }
          const input = read(part.rowId);
          hasValue ||= input !== null;
          return input ?? 0;
        },
        validate,
      );
      return hasValue || !row.formula.some((part) => typeof part !== 'string') ? number : null;
    } finally {
      evaluating.delete(id);
    }
  }

  for (const row of hostel.rows) {
    try {
      result.set(row.id, { value: read(row.id) });
    } catch (error) {
      result.set(row.id, { value: null, error: (error as Error).message });
    }
  }
  return result;
}

export function rowErrors(hostel: Hostel): Map<string, string> {
  const result = new Map<string, string>();
  const calculated = evaluate(hostel, sampleDay, true);
  for (const row of hostel.rows) {
    const normalized = row.name.trim().toLocaleLowerCase('ru');
    const error = !normalized
      ? 'Введите название строки.'
      : /\[|\]/u.test(normalized)
        ? 'Уберите квадратные скобки из названия.'
        : hostel.rows.some(
              (other) =>
                other.id !== row.id && other.name.trim().toLocaleLowerCase('ru') === normalized,
            )
          ? 'Строка с таким названием уже есть.'
          : calculated.get(row.id)?.error;
    if (error) result.set(row.id, error);
  }
  return result;
}

const names: [string, string][] = [
  ['m', 'Проживает М'],
  ['f', 'Проживает Ж'],
  ['total', 'Проживает Итого (М+Ж)'],
  ['paid-m', 'Оплачено мест М'],
  ['paid-f', 'Оплачено мест Ж'],
  ['paid', 'Оплачено мест Итого'],
  ['free-m', 'Свободных мест М'],
  ['free-f', 'Свободных мест Ж'],
  ['free', 'Свободно мест Итого'],
];

function standardRows(): Row[] {
  const rows = names.map(([id, name]) => makeRow(id, name));
  const formulas: Record<string, string> = {
    total: '=[Проживает М]+[Проживает Ж]',
    paid: '=[Оплачено мест М]+[Оплачено мест Ж]',
    'free-m': '=[Оплачено мест М]-[Проживает М]',
    'free-f': '=[Оплачено мест Ж]-[Проживает Ж]',
    free: '=[Свободных мест М]+[Свободных мест Ж]',
  };
  return rows.map((row) => {
    if (row.id === 'm' || row.id === 'f') return { ...row, mode: 'source', indicator: row.id };
    const input = formulas[row.id];
    return input
      ? {
          ...row,
          mode: 'formula',
          formula: readFormula(input, rows),
          highlight: ['total', 'paid', 'free'].includes(row.id),
        }
      : row;
  });
}

export const initialDemo: Demo = {
  hostels: [
    {
      id: 'north-main',
      name: 'Северный корпус',
      dormitory: 'north',
      rows: standardRows(),
      values: {
        'paid-m': Object.fromEntries(days.map((day) => [day, '64'])),
        'paid-f': Object.fromEntries(days.map((day) => [day, '46'])),
      },
    },
    {
      id: 'river-main',
      name: 'Речной корпус',
      dormitory: 'river',
      rows: standardRows(),
      values: {
        'paid-m': Object.fromEntries(days.map((day) => [day, '28'])),
        'paid-f': Object.fromEntries(days.map((day) => [day, '22'])),
      },
    },
  ],
  templates: [
    { id: 'standard', name: 'Учёт мест по М/Ж', dormitory: 'north', rows: standardRows() },
  ],
};
