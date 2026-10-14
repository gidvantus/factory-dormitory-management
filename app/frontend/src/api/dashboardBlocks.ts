import type { CellValue, PlaceMetric, TableColumn, TableKey } from './client';

export interface WidgetFilter {
  column_id: number;
  operator: 'equals' | 'not_empty';
  value: CellValue;
}
export type WidgetSource =
  | { kind: 'report'; dormitory_id: number; row_id: number }
  | { kind: 'places'; dormitory_id: number; metric: PlaceMetric; hostel_id: number | null }
  | { kind: 'arrival_plan'; dormitory_id: number }
  | {
      kind: 'table';
      dormitory_id: number;
      table_key: TableKey;
      value_column_id: number | null;
      date_column_id: number | null;
      group_column_id: number | null;
      filter: WidgetFilter | null;
    };
export interface WidgetConfig {
  name: string;
  display: 'number' | 'list' | 'chart';
  chart_mode?: 'total' | 'dormitories';
  source_kind: WidgetSource['kind'];
  operation: 'count' | 'sum';
  period: 'snapshot' | 'range';
  grouping: 'dormitory' | 'value';
  all_dormitories: boolean;
  excluded_dormitory_ids: number[];
  sources: WidgetSource[];
}
export interface WidgetDefinition {
  id: number;
  config: WidgetConfig;
}
export interface DashboardLayout {
  revision: number;
  order: string[];
  hidden: string[];
  blocks: WidgetDefinition[];
}
export interface WidgetResult {
  id: number;
  value: number | null;
  items: { label: string; value: number | null; is_archived: boolean }[];
  errors: string[];
  daily?: { date: string; value: number | null }[];
  series?: {
    dormitory_id: number;
    label: string;
    is_archived: boolean;
    daily: { date: string; value: number | null }[];
  }[];
}
export interface CatalogSource {
  key: string;
  name: string;
  kind: WidgetSource['kind'];
  columns: TableColumn[];
  rows: { id: number; name: string }[];
  hostels: { id: number; name: string }[];
}
export interface CatalogDormitory {
  id: number;
  name: string;
  is_archived: boolean;
  sources: CatalogSource[];
}
export const DEFAULT_LAYOUT: DashboardLayout = {
  revision: 0,
  order: ['residents', 'turnover', 'attendance', 'reports'],
  hidden: [],
  blocks: [],
};
