import type { DailyMetrics, Metric } from './data';
import { dateNumber, isCalendarDate } from './dates';
import type { DateRange } from './dates';

export const CHART = { width: 960, height: 270, left: 50, right: 28, top: 18, bottom: 42 };

export function filteredDays(rows: DailyMetrics[], range: DateRange): DailyMetrics[] {
  return rows
    .filter((row) => isCalendarDate(row.date) && row.date >= range.from && row.date <= range.to)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function chartX(date: string, range: DateRange, width = CHART.width): number {
  const duration = dateNumber(range.to) - dateNumber(range.from);
  const position = duration === 0 ? 0.5 : (dateNumber(date) - dateNumber(range.from)) / duration;
  return CHART.left + position * (width - CHART.left - CHART.right);
}

export function chartY(value: number, max: number): number {
  return CHART.height - CHART.bottom - (value / max) * (CHART.height - CHART.bottom - CHART.top);
}

/** Пропущенный день или null разрывает линию, а не превращается в нулевое значение. */
export function chartSegments(
  rows: DailyMetrics[],
  metric: Metric,
  range: DateRange,
  max: number,
  width = CHART.width,
): string[] {
  const paths: string[] = [];
  let segment = '';
  let previousDate: string | null = null;
  for (const row of rows) {
    const value = row[metric];
    const hasGap =
      previousDate !== null && dateNumber(row.date) - dateNumber(previousDate) !== 86_400_000;
    if (value === null || hasGap) {
      if (segment) paths.push(segment);
      segment = '';
    }
    if (value !== null)
      segment += `${segment ? ' L' : 'M'}${chartX(row.date, range, width)},${chartY(value, max)}`;
    previousDate = row.date;
  }
  if (segment) paths.push(segment);
  return paths;
}
