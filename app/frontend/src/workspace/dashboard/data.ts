import type { DateRange } from './dates';

export type Metric = 'attendance' | 'residents' | 'turnover';

export interface DailyMetrics {
  /** Календарный день YYYY-MM-DD; одна запись на день по всем общежитиям. */
  date: string;
  attendance: number | null;
  residents: number | null;
  /** Значение отдельной строки «Текучка» в отчёте за день. */
  turnover: number | null;
}

export interface DormitoryMetrics {
  id: string;
  name: string;
  residents: number | null;
  attendance: number | null;
  /** Сумма отдельного показателя «Текучка» за выбранный период. */
  turnover: number | null;
  vacancies: number | null;
}

export interface DashboardData {
  /** Дата среза численности и выхода; null, если среза ещё нет. */
  snapshotDate: string | null;
  totals: { attendance: number | null; residents: number | null };
  dormitories: DormitoryMetrics[];
  daily: DailyMetrics[];
}

export type DashboardLoader = (range: DateRange, signal: AbortSignal) => Promise<DashboardData>;

export const EMPTY_DASHBOARD: DashboardData = {
  snapshotDate: null,
  totals: { attendance: null, residents: null },
  dormitories: [],
  daily: [],
};

/**
 * Точка подключения будущего API отчётов. До его появления не отправляем запросы
 * на несуществующий endpoint и не выдаём демонстрационные числа за реальные.
 * Адаптер должен вернуть показатели за переданный включительный период.
 */
export const loadDashboard: DashboardLoader = () => Promise.resolve(EMPTY_DASHBOARD);

export const METRICS: { key: Metric; label: string; color: string }[] = [
  { key: 'attendance', label: 'Выход', color: '#2f7d62' },
  { key: 'residents', label: 'Проживающие', color: '#34679e' },
  { key: 'turnover', label: 'Текучка', color: '#9a6531' },
];

export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('ru-RU');
}
