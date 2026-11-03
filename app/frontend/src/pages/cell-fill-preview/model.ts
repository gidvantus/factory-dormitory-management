export type Kind = 'text' | 'date' | 'number';
export type FillMode = 'manual' | 'pick' | 'lookup';
export interface Column {
  id: string;
  name: string;
  kind: Kind;
  mode: FillMode;
  sourceId: string;
  fieldId: string;
  matchColumnId: string;
  update: 'live' | 'copy';
}
export interface Source {
  id: string;
  name: string;
  path: string;
  fields: { id: string; name: string; kind: Kind }[];
  records: { id: string; values: Record<string, string> }[];
}
export interface Row {
  id: string;
  selected: Record<string, string>;
  manual: Record<string, string>;
  copies: Record<string, string>;
}
export interface Demo {
  name: string;
  columns: Column[];
  sources: Source[];
  rows: Row[];
}

export const kindNames: Record<Kind, string> = { text: 'Текст', date: 'Дата', number: 'Число' };
export const modeNames: Record<FillMode, string> = {
  manual: 'Вручную',
  pick: 'Выбор записи',
  lookup: 'Из другой таблицы',
};

export function newColumn(id: string, name = 'Новый столбец', kind: Kind = 'text'): Column {
  return {
    id,
    name,
    kind,
    mode: 'manual',
    sourceId: 'residents',
    fieldId: kind === 'date' ? 'check_in' : 'full_name',
    matchColumnId: 'person',
    update: 'live',
  };
}

export function initialDemo(): Demo {
  return {
    name: 'Отпуск',
    columns: [
      { ...newColumn('person', 'ФИО'), mode: 'pick' },
      { ...newColumn('checkin', 'Дата заселения', 'date'), mode: 'lookup' },
      newColumn('start', 'Начало отпуска', 'date'),
      newColumn('end', 'Конец отпуска', 'date'),
    ],
    sources: [
      {
        id: 'residents',
        name: 'Проживающие',
        path: 'Общежития / Учебное общежитие',
        fields: [
          { id: 'full_name', name: 'ФИО', kind: 'text' },
          { id: 'check_in', name: 'Дата заселения', kind: 'date' },
          { id: 'room', name: 'Комната', kind: 'text' },
          { id: 'number', name: 'Табельный номер', kind: 'number' },
        ],
        records: [
          {
            id: 'resident-1',
            values: {
              full_name: 'Иванов Алексей Сергеевич',
              check_in: '2026-09-14',
              room: '204',
              number: '1042',
            },
          },
          {
            id: 'resident-2',
            values: {
              full_name: 'Петрова Анна Викторовна',
              check_in: '2026-10-02',
              room: '307',
              number: '1087',
            },
          },
          {
            id: 'resident-3',
            values: {
              full_name: 'Смирнов Дмитрий Олегович',
              check_in: '2026-10-18',
              room: '205',
              number: '1123',
            },
          },
          {
            id: 'resident-4',
            values: {
              full_name: 'Иванов Алексей Сергеевич',
              check_in: '2026-10-27',
              room: '101',
              number: '1196',
            },
          },
        ],
      },
      {
        id: 'employees',
        name: 'Сотрудники',
        path: 'Персонал',
        fields: [
          { id: 'full_name', name: 'ФИО', kind: 'text' },
          { id: 'shift_start', name: 'Начало вахты', kind: 'date' },
          { id: 'shift_end', name: 'Конец вахты', kind: 'date' },
          { id: 'number', name: 'Табельный номер', kind: 'number' },
        ],
        records: [
          {
            id: 'employee-1',
            values: {
              full_name: 'Иванов Алексей Сергеевич',
              shift_start: '2026-09-14',
              shift_end: '2026-11-14',
              number: '1042',
            },
          },
          {
            id: 'employee-2',
            values: {
              full_name: 'Петрова Анна Викторовна',
              shift_start: '2026-10-02',
              shift_end: '2026-12-02',
              number: '1087',
            },
          },
        ],
      },
    ],
    rows: [
      {
        id: 'row-1',
        selected: { person: 'resident-1' },
        manual: { start: '2026-11-09', end: '2026-11-23' },
        copies: {},
      },
      {
        id: 'row-2',
        selected: { person: 'resident-2' },
        manual: { start: '2026-11-16', end: '2026-11-30' },
        copies: {},
      },
    ],
  };
}

export function columnError(demo: Demo, column: Column): string {
  if (!column.name.trim()) return 'Укажите название столбца.';
  if (
    demo.columns.some(
      (item) =>
        item.id !== column.id &&
        item.name.trim().toLocaleLowerCase('ru') === column.name.trim().toLocaleLowerCase('ru'),
    )
  )
    return 'Название столбца уже используется.';
  if (column.mode === 'manual') return '';
  const source = demo.sources.find((item) => item.id === column.sourceId);
  if (!source) return 'Выберите таблицу-источник.';
  if (column.mode === 'pick')
    return column.kind === 'text' ? '' : 'Для выбора записи нужен тип «Текст».';
  const match = demo.columns.find((item) => item.id === column.matchColumnId);
  if (!match || match.mode !== 'pick' || match.sourceId !== column.sourceId)
    return 'Выберите столбец с записью из этой же таблицы.';
  const field = source.fields.find((item) => item.id === column.fieldId);
  if (!field || field.kind !== column.kind) return 'Выберите совместимый столбец источника.';
  return '';
}

function sourceValue(demo: Demo, row: Row, column: Column): string {
  if (columnError(demo, column)) return '';
  const recordId = row.selected[column.matchColumnId];
  return (
    demo.sources
      .find((item) => item.id === column.sourceId)
      ?.records.find((item) => item.id === recordId)?.values[column.fieldId] ?? ''
  );
}

export function cellValue(demo: Demo, row: Row, column: Column): string {
  if (column.mode === 'manual') return row.manual[column.id] ?? '';
  if (column.mode === 'pick')
    return (
      demo.sources
        .find((item) => item.id === column.sourceId)
        ?.records.find((item) => item.id === row.selected[column.id])?.values.full_name ?? ''
    );
  if (columnError(demo, column)) return '';
  return column.update === 'copy' ? (row.copies[column.id] ?? '') : sourceValue(demo, row, column);
}

export function selectRecord(demo: Demo, rowId: string, columnId: string, recordId: string): Demo {
  return {
    ...demo,
    rows: demo.rows.map((row) => {
      if (row.id !== rowId) return row;
      const next = {
        ...row,
        selected: { ...row.selected, [columnId]: recordId },
        copies: { ...row.copies },
      };
      for (const column of demo.columns) {
        if (
          column.mode === 'lookup' &&
          column.update === 'copy' &&
          column.matchColumnId === columnId
        )
          next.copies[column.id] = sourceValue(demo, next, column);
      }
      return next;
    }),
  };
}

export function configureColumn(demo: Demo, id: string, patch: Partial<Column>): Demo {
  const previous = demo.columns.find((item) => item.id === id)!;
  const column = { ...previous, ...patch };
  const next = { ...demo, columns: demo.columns.map((item) => (item.id === id ? column : item)) };
  const selectionChanged = previous.mode !== column.mode || previous.sourceId !== column.sourceId;
  const mappingChanged =
    selectionChanged ||
    previous.fieldId !== column.fieldId ||
    previous.matchColumnId !== column.matchColumnId ||
    previous.update !== column.update;
  next.rows = demo.rows.map((row) => {
    const updated = { ...row, selected: { ...row.selected }, copies: { ...row.copies } };
    if (selectionChanged) {
      delete updated.selected[id];
      for (const dependent of next.columns)
        if (dependent.matchColumnId === id) delete updated.copies[dependent.id];
    }
    if (mappingChanged && column.mode === 'lookup' && column.update === 'copy')
      updated.copies[id] = sourceValue(next, updated, column);
    return updated;
  });
  return next;
}

export function updateSource(
  demo: Demo,
  sourceId: string,
  recordId: string,
  fieldId: string,
  value: string,
): Demo {
  return {
    ...demo,
    sources: demo.sources.map((source) =>
      source.id !== sourceId
        ? source
        : {
            ...source,
            records: source.records.map((record) =>
              record.id !== recordId
                ? record
                : { ...record, values: { ...record.values, [fieldId]: value } },
            ),
          },
    ),
  };
}

export function formatValue(value: string, kind: Kind): string {
  return kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value.split('-').reverse().join('.')
    : value;
}
