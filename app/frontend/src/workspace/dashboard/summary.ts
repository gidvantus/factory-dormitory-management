import type { DormitoryMetrics } from './data';

/** Частичный итог не подменяет общую текучку. Нулевое значение остаётся нулём. */
export function totalTurnover(dormitories: DormitoryMetrics[]): number | null {
  if (!dormitories.length || dormitories.some((item) => item.turnover === null)) return null;
  return dormitories.reduce((sum, item) => sum + item.turnover!, 0);
}

export function reportReady(dormitory: DormitoryMetrics, date: string): boolean | null {
  const readiness = dormitory.report_readiness;
  return readiness?.report_date === date ? readiness.is_ready : null;
}

const colors = [
  { color: '#2d8069', tint: '#e1efe8' },
  { color: '#427caf', tint: '#e0edf8' },
  { color: '#9b6544', tint: '#fae7d9' },
  { color: '#7a65ab', tint: '#eae3f7' },
];

/** Цвет привязан к объекту и не меняется при перестановке блоков. */
export function itemTone(id: string): (typeof colors)[number] {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}
