import type { PlaceMetric, TableKey } from '../../api/client';
import type { CatalogDormitory, CatalogSource, WidgetSource } from '../../api/dashboardBlocks';
import type {
  StatisticsBlock,
  StatisticsDisplay,
  StatisticsAggregation,
} from '../../api/statistics';

export const displayNames: Record<StatisticsDisplay, string> = {
  number: 'Число',
  line: 'Линейный',
  bar: 'Столбчатый',
  area: 'С областями',
  pie: 'Круговой',
  table: 'Таблица',
};
export const operations: Record<StatisticsAggregation, string> = {
  sum: 'Сумма за период',
  average: 'Среднее за день',
  last: 'На последнюю дату',
  max: 'Максимум за день',
};
export const metrics: Record<PlaceMetric, string> = {
  paid_total: 'Оплачено мест — всего',
  paid_m: 'Оплачено мест М',
  paid_f: 'Оплачено мест Ж',
  residents_total: 'Проживает — всего',
  residents_m: 'Проживает М',
  residents_f: 'Проживает Ж',
  free_total: 'Свободно мест — всего',
  free_m: 'Свободно мест М',
  free_f: 'Свободно мест Ж',
};
export const formatValue = (value: number | null | undefined): string =>
  value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось выполнить запрос. Повторите попытку.';
export function metadata(
  dorm: CatalogDormitory | undefined,
  source: WidgetSource | undefined,
): CatalogSource | undefined {
  return dorm?.sources.find(
    (item) => item.key === (source?.kind === 'table' ? source.table_key : source?.kind),
  );
}
export function sourceFor(dorm: CatalogDormitory, source: CatalogSource): WidgetSource {
  if (source.kind === 'report')
    return { kind: 'report', dormitory_id: dorm.id, row_id: source.rows[0]?.id ?? 0 };
  if (source.kind === 'places')
    return { kind: 'places', dormitory_id: dorm.id, metric: 'residents_total', hostel_id: null };
  return {
    kind: 'table',
    dormitory_id: dorm.id,
    table_key: source.key as TableKey,
    value_column_id: null,
    date_column_id: source.columns.find((col) => col.kind === 'date')?.id ?? null,
    group_column_id: null,
    filter: null,
  };
}
export function newBlock(catalog: CatalogDormitory[]): StatisticsBlock | null {
  const dorm = catalog.find((item) => !item.is_archived) ?? catalog[0];
  const source =
    dorm?.sources.find((item) => item.kind === 'report' && item.rows.length > 0) ??
    dorm?.sources.find((item) => item.kind === 'places') ??
    dorm?.sources[0];
  if (!dorm || !source) return null;
  return {
    id: crypto.randomUUID(),
    name: 'Новый блок',
    display: 'line',
    aggregation: 'sum',
    breakdown: 'date',
    selected_dormitory_ids: [dorm.id],
    query: {
      name: 'Статистика',
      display: 'chart',
      chart_mode: 'dormitories',
      source_kind: source.kind,
      operation: source.kind === 'table' ? 'count' : 'sum',
      period: 'range',
      grouping: 'dormitory',
      all_dormitories: true,
      excluded_dormitory_ids: [],
      sources: [sourceFor(dorm, source)],
    },
  };
}
export function sourceLabel(block: StatisticsBlock, catalog: CatalogDormitory[]): string {
  const source = block.query.sources[0];
  const meta = metadata(
    catalog.find((item) => item.id === source?.dormitory_id),
    source,
  );
  if (!source || !meta) return 'Источник недоступен';
  const metric =
    source.kind === 'report'
      ? meta.rows.find((row) => row.id === source.row_id)?.name
      : source.kind === 'places'
        ? metrics[source.metric]
        : block.query.operation === 'count'
          ? 'Количество строк'
          : meta.columns.find((col) => col.id === source.value_column_id)?.name;
  return `${meta.name} / ${metric ?? 'Показатель недоступен'}`;
}
export function validSource(
  source: WidgetSource | undefined,
  dorm: CatalogDormitory | undefined,
  block: StatisticsBlock,
): boolean {
  const meta = metadata(dorm, source);
  if (!source || !meta) return false;
  if (source.kind === 'report') return meta.rows.some((item) => item.id === source.row_id);
  if (source.kind === 'places')
    return source.hostel_id === null || meta.hostels.some((item) => item.id === source.hostel_id);
  if (
    block.query.operation === 'sum' &&
    !meta.columns.some((item) => item.id === source.value_column_id && item.kind === 'number')
  )
    return false;
  if (
    source.date_column_id !== null &&
    !meta.columns.some((item) => item.id === source.date_column_id && item.kind === 'date')
  )
    return false;
  if (source.filter) {
    const col = meta.columns.find((item) => item.id === source.filter?.column_id);
    if (!col) return false;
    if (source.filter.operator === 'equals') {
      if (source.filter.value === '' || source.filter.value === null) return false;
      if (col.kind === 'select' && !col.options.some((item) => item.id === source.filter?.value))
        return false;
    }
  }
  return true;
}
