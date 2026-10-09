export interface DateRange {
  from: string;
  to: string;
}

// Единый календарь для периода и будущего контроля ежедневных отчётов.
export const REPORT_TIME_ZONE = 'Europe/Moscow';
const DAY_MS = 86_400_000;

export function todayDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string): string => parts.find((item) => item.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function dateNumber(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const timestamp = dateNumber(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function currentMonth(now = new Date()): DateRange {
  const current = todayDate(now);
  const [year, month] = current.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${current.slice(0, 7)}-01`, to: `${current.slice(0, 7)}-${lastDay}` };
}

export function rangeError(range: DateRange): string {
  if (!isCalendarDate(range.from) || !isCalendarDate(range.to)) {
    return 'Укажите обе даты полностью.';
  }
  if (range.from > range.to) return 'Дата «От» должна быть не позже даты «До».';
  if (dateNumber(range.to) - dateNumber(range.from) > 365 * DAY_MS) {
    return 'Выберите период не длиннее года.';
  }
  return '';
}

export function formatDate(value: string, withYear = true): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    ...(withYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(new Date(dateNumber(value)));
}

export function rangeTicks(range: DateRange, count = 5): string[] {
  const start = dateNumber(range.from);
  const days = Math.round((dateNumber(range.to) - start) / DAY_MS);
  return Array.from(
    new Set(
      Array.from({ length: count }, (_, index) =>
        new Date(start + Math.round((days * index) / (count - 1)) * DAY_MS)
          .toISOString()
          .slice(0, 10),
      ),
    ),
  );
}
