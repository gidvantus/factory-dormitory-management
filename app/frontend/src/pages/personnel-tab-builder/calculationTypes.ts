export type Scalar = string | number | boolean | null;
export type LinkOperation = 'lookup' | 'count' | 'sum' | 'average' | 'min' | 'max';
export type LinkFilter = {
  field: string;
  operator: 'equals' | 'contains' | 'not_empty' | 'empty' | 'from' | 'to';
  value: string;
};
export type LinkRule = {
  sourceId: string;
  operation: LinkOperation;
  valueField: string;
  sourceRowId: string | null;
  match: { sourceField: string; localColumnId: string } | null;
  filters: LinkFilter[];
  dateField: string | null;
  empty: 'zero' | 'blank' | 'error';
};
export type CalculationRule = {
  mode: 'manual' | 'formula' | 'link';
  expression: string;
  refs: Record<string, string>;
  link: LinkRule | null;
};
export type ReferenceTarget = { id: string; name: string };
export type SourceField = {
  id: string;
  name: string;
  kind: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'employee';
  options?: string[];
};
export type CalculationSource = {
  id: string;
  name: string;
  fields: SourceField[];
  rows?: ReferenceTarget[];
  kind: 'people' | 'table' | 'calendar' | 'report' | 'places' | 'arrivals';
};
export type EvaluationContext = { day?: string; range?: { from: string; to: string } | null };
export type CellResult = { value: Scalar; error?: string; pending?: boolean };
export const operations: Record<LinkOperation, string> = {
  lookup: 'Одно значение по совпадению',
  count: 'Количество записей',
  sum: 'Сумма',
  average: 'Среднее',
  min: 'Минимум',
  max: 'Максимум',
};
export function manualRule(): CalculationRule {
  return { mode: 'manual', expression: '=', refs: {}, link: null };
}
