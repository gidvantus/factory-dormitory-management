import { request } from './client';
import type { CatalogDormitory, WidgetConfig, WidgetResult } from './dashboardBlocks';
import type { DateRange } from '../workspace/dashboard/dates';

export type StatisticsDisplay = 'number' | 'line' | 'bar' | 'area' | 'pie' | 'table';
export type StatisticsAggregation = 'sum' | 'average' | 'last' | 'max';
export interface StatisticsBlock {
  id: string;
  name: string;
  display: StatisticsDisplay;
  aggregation: StatisticsAggregation;
  breakdown: 'date' | 'dormitory';
  selected_dormitory_ids: number[];
  query: WidgetConfig;
}
export interface StatisticsReport {
  id: number;
  name: string;
  description: string;
  visibility: 'personal' | 'shared';
  revision: number;
  blocks: StatisticsBlock[];
  created_by_id: number | null;
  created_by_name: string;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
}
export type ReportInput = Pick<StatisticsReport, 'name' | 'description' | 'visibility' | 'blocks'>;
export interface StatisticsResult extends Omit<WidgetResult, 'id' | 'items'> {
  id: string;
  items: { dormitory_id: number; label: string; is_archived: boolean; value: number | null }[];
}
export interface StatisticsData {
  revision: number;
  from_date: string;
  to_date: string;
  through_date: string | null;
  results: StatisticsResult[];
}
const queryRange = (range: DateRange): URLSearchParams =>
  new URLSearchParams({ from: range.from, to: range.to });
export const statisticsApi = {
  sources: (signal?: AbortSignal): Promise<CatalogDormitory[]> =>
    request('/statistics/sources', { signal }),
  reports: (signal?: AbortSignal): Promise<StatisticsReport[]> =>
    request('/statistics/reports', { signal }),
  report: (id: string, signal?: AbortSignal): Promise<StatisticsReport> =>
    request(`/statistics/reports/${encodeURIComponent(id)}`, { signal }),
  create: (input: ReportInput): Promise<StatisticsReport> =>
    request('/statistics/reports', { method: 'POST', body: JSON.stringify(input) }),
  save: (id: number, input: ReportInput & { revision: number }): Promise<StatisticsReport> =>
    request(`/statistics/reports/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  remove: (id: number, revision: number): Promise<void> =>
    request(`/statistics/reports/${id}?revision=${revision}`, { method: 'DELETE' }),
  data: (
    id: string,
    range: DateRange,
    dormitoryId: string,
    signal?: AbortSignal,
  ): Promise<StatisticsData> => {
    const query = queryRange(range);
    if (dormitoryId !== 'all') query.set('dormitory_id', dormitoryId);
    return request(`/statistics/reports/${encodeURIComponent(id)}/data?${query}`, { signal });
  },
  preview: (
    block: StatisticsBlock,
    range: DateRange,
    signal?: AbortSignal,
  ): Promise<StatisticsResult> =>
    request(`/statistics/preview?${queryRange(range)}`, {
      method: 'POST',
      body: JSON.stringify(block),
      signal,
    }),
};
