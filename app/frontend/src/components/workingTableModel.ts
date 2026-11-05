export const tableColors = [
  { id: 'mint', label: 'Мятный' },
  { id: 'sage', label: 'Шалфейный' },
  { id: 'sky', label: 'Небесный' },
  { id: 'blue', label: 'Голубой' },
  { id: 'lilac', label: 'Сиреневый' },
  { id: 'lavender', label: 'Лавандовый' },
  { id: 'butter', label: 'Ванильный' },
  { id: 'sand', label: 'Песочный' },
  { id: 'peach', label: 'Персиковый' },
  { id: 'rose', label: 'Розовый' },
] as const;
export type TableColor = (typeof tableColors)[number]['id'];
export interface TableViewState {
  rows: string[];
  columns: string[];
  row_colors: Record<string, TableColor>;
  column_colors: Record<string, TableColor>;
}
export interface TableView {
  revision: number;
  state: TableViewState;
}
export const emptyTableView = (): TableView => ({
  revision: 0,
  state: { rows: [], columns: [], row_colors: {}, column_colors: {} },
});

export function orderedKeys(keys: string[], saved: string[]): string[] {
  const available = new Set(keys);
  const known = saved.filter((key) => available.has(key));
  const placed = new Set(known);
  return [...known, ...keys.filter((key) => !placed.has(key))];
}

export function moveKey(keys: string[], source: string, target: string): string[] {
  if (source === target || !keys.includes(source) || !keys.includes(target)) return keys;
  const next = keys.filter((key) => key !== source);
  next.splice(keys.indexOf(target), 0, source);
  return next;
}
