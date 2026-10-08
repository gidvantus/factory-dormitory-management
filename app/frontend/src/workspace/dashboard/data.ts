import { api } from '../../api/client';
import type { DateRange } from './dates';

export type Metric = 'attendance' | 'residents' | 'turnover';

export interface DailyMetrics {
  /** Календарный день YYYY-MM-DD; одна запись на день по всем общежитиям. */
  date: string;
  attendance: number | null;
  residents: number | null;
  /** Значение строки «Текучка Итого» за день. */
  turnover: number | null;
}

export interface DormitoryMetrics {
  id: string;
  name: string;
  is_archived?: boolean;
  residents: number | null;
  attendance: number | null;
  /** Значение строки «Текучка Итого» на дату среза. */
  turnover: number | null;
  vacancies: number | null;
}

export interface DashboardData {
  /** Дата среза численности и выхода; null, если среза ещё нет. */
  snapshotDate: string | null;
  totals: { attendance: number | null; residents: number | null };
  dormitories: DormitoryMetrics[];
  clients: { name: string; attendance: number | null }[];
  daily: DailyMetrics[];
}

export type DashboardLoader = (
  range: DateRange,
  signal: AbortSignal,
  dormitoryId?: string | null,
) => Promise<DashboardData>;

export const EMPTY_DASHBOARD: DashboardData = {
  snapshotDate: null,
  totals: { attendance: null, residents: null },
  dormitories: [],
  clients: [],
  daily: [],
};

export const loadDashboard: DashboardLoader = async (range, signal, dormitoryId) => {
  const response = await api.dashboard(range.from, range.to, signal, dormitoryId);
  return {
    snapshotDate: response.snapshot_date,
    totals: response.totals,
    dormitories: response.dormitories,
    clients: response.clients,
    daily: response.daily,
  };
};

export const METRICS: { key: Metric; label: string; color: string }[] = [
  { key: 'attendance', label: 'Выход', color: '#2f7d62' },
  { key: 'residents', label: 'Проживающие', color: '#34679e' },
  { key: 'turnover', label: 'Текучка', color: '#9a6531' },
];

export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('ru-RU');
}
