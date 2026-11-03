import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardSummary } from './DashboardSummary';
import type { DashboardData, DormitoryMetrics } from './data';

const dorm = (
  id: string,
  turnover: number | null,
  ready?: boolean,
  date = '2026-11-02',
): DormitoryMetrics => ({
  id,
  name: id,
  residents: 10,
  attendance: 8,
  turnover,
  vacancies: null,
  ...(ready === undefined
    ? {}
    : {
        report_readiness: {
          report_date: date,
          is_ready: ready,
          confirmed_by: null,
          confirmed_at: null,
        },
      }),
});
const DATA: DashboardData = {
  reportDate: '2026-11-02',
  snapshotDate: '2026-10-05',
  totals: { residents: 20, attendance: 0 },
  clients: [],
  dormitories: [dorm('one', 0, true), dorm('two', 0, false)],
  daily: [
    { date: '2026-10-01', residents: 20, attendance: 12, turnover: 0 },
    { date: '2026-10-02', residents: null, attendance: null, turnover: null },
    { date: '2026-10-03', residents: 22, attendance: 20, turnover: 1 },
    { date: '2026-10-05', residents: 20, attendance: 14, turnover: 0 },
    { date: '2026-10-06', residents: 100, attendance: 99, turnover: 99 },
  ],
};
const RANGE = { from: '2026-10-01', to: '2026-10-31' };

describe('сводка «Пульт руководителя»', () => {
  it('показывает настоящий ноль и не выдаёт частичную текучку за итог', () => {
    render(
      <DashboardSummary
        data={{ ...DATA, dormitories: [dorm('one', 2), dorm('two', null)] }}
        range={RANGE}
        snapshot="2026-10-05"
        loading={false}
      />,
    );
    expect(screen.getByTestId('dashboard-total-attendance')).toHaveTextContent('0');
    expect(screen.getByTestId('dashboard-total-turnover')).toHaveTextContent('—');
    expect(screen.getByTestId('dashboard-reports-ready')).toHaveTextContent('—');
    expect(screen.getByText('Статус недоступен: 2')).toBeInTheDocument();
  });

  it('разрывает мини-график на null и пропущенном дне и исключает дни после среза', () => {
    render(<DashboardSummary data={DATA} range={RANGE} snapshot="2026-10-05" loading={false} />);
    const chart = screen.getByTestId('summary-trend-attendance');
    expect(chart.querySelectorAll('path')).toHaveLength(3);
    expect(chart.querySelectorAll('circle')).toHaveLength(3);
    expect(chart).toHaveAccessibleName(expect.stringContaining('05.10: 14'));
    expect(chart).not.toHaveAccessibleName(expect.stringContaining('06.10'));
    expect(screen.getByTestId('dashboard-total-turnover')).toHaveTextContent('0');
  });

  it('считает сегодняшнюю готовность отдельно от среза и не считает старые статусы готовыми', () => {
    render(
      <DashboardSummary
        data={{
          ...DATA,
          dormitories: [dorm('one', 0, true), dorm('two', 0, true, '2026-11-01'), dorm('three', 0)],
        }}
        range={RANGE}
        snapshot="2026-10-05"
        loading={false}
      />,
    );
    expect(screen.getByTestId('dashboard-reports-ready')).toHaveTextContent('1');
    expect(screen.getByText('из 3 готовы')).toBeInTheDocument();
    expect(screen.getByText('02.11.2026')).toBeInTheDocument();
    expect(screen.getByText('Статус недоступен: 2')).toBeInTheDocument();
  });
});
