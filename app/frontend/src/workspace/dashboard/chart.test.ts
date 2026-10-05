import { describe, expect, it } from 'vitest';
import { chartSegments, chartX, filteredDays } from './chart';
import { currentMonth, isCalendarDate, rangeError, rangeTicks, todayDate } from './dates';

describe('календарь дашборда', () => {
  it('определяет границу месяца по московскому времени и учитывает високосный февраль', () => {
    expect(todayDate(new Date('2026-09-30T21:05:00Z'))).toBe('2026-10-01');
    expect(currentMonth(new Date('2026-09-30T21:05:00Z'))).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(currentMonth(new Date('2024-02-10T12:00:00Z'))).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(rangeError({ from: '2026-10-01', to: '2026-10-01' })).toBe('');
    expect(rangeTicks({ from: '2026-10-01', to: '2026-10-01' })).toEqual(['2026-10-01']);
  });
});

describe('данные графика', () => {
  it('включает обе границы периода, сортирует даты и разрывает линии на пропусках, сохраняя ноль', () => {
    const range = { from: '2026-10-01', to: '2026-10-06' };
    const rows = filteredDays(
      [
        { date: '2026-10-06', attendance: 7, residents: null, turnover: null },
        { date: '2026-10-01', attendance: 0, residents: null, turnover: null },
        { date: '2026-10-02', attendance: 2, residents: null, turnover: null },
        { date: '2026-10-03', attendance: null, residents: null, turnover: null },
        { date: '2026-10-04', attendance: 4, residents: null, turnover: null },
        { date: '2026-09-30', attendance: 100, residents: null, turnover: null },
        { date: '2026-10-07', attendance: 100, residents: null, turnover: null },
      ],
      range,
    );
    expect(rows.map((row) => row.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-06',
    ]);
    const segments = chartSegments(rows, 'attendance', range, 8);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toContain(' L');
    expect(segments[1]).not.toContain(' L');
    expect(chartSegments(rows, 'residents', range, 8)).toEqual([]);
    expect(Number.isFinite(chartX('2026-10-01', { from: '2026-10-01', to: '2026-10-01' }))).toBe(
      true,
    );
  });
});
