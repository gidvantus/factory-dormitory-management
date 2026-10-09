import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../../test/mockFetch';
import { Dashboard } from './Dashboard';
import { EMPTY_DASHBOARD, loadDashboard } from './data';
import type { DashboardData, DashboardLoader } from './data';
import { currentMonth } from './dates';

const DATA: DashboardData = {
  snapshotDate: '2026-10-04',
  totals: { residents: 35, attendance: 23 },
  dormitories: [
    { id: 'one', name: 'Северное', residents: 20, attendance: 15, turnover: 2, vacancies: 10 },
    { id: 'two', name: 'Южное', residents: 15, attendance: 8, turnover: 0, vacancies: null },
  ],
  clients: [
    { name: 'Клиент А', attendance: 15 },
    { name: 'Клиент Б', attendance: 8 },
  ],
  daily: [
    { date: '2026-09-30', residents: 24, attendance: 12, turnover: 0 },
    { date: '2026-10-01', residents: 30, attendance: 22, turnover: 1 },
    { date: '2026-10-02', residents: 35, attendance: 23, turnover: 1 },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setPeriod(from: string, to: string): void {
  fireEvent.change(screen.getByLabelText('От'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('До'), { target: { value: to } });
  fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
}

describe('дашборд', () => {
  it('загружает реальные показатели обзора одним запросом за выбранный период', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes('/api/dashboard?'))
        return {
          status: 200,
          body: {
            snapshot_date: '2025-09-02',
            totals: { residents: 35, attendance: 13 },
            dormitories: [],
            clients: [{ name: 'Клиент А', attendance: 13 }],
            daily: [{ date: '2025-09-02', residents: 35, attendance: 13, turnover: 2 }],
          },
        };
      return { status: 404, body: {} };
    });
    const result = await loadDashboard(
      { from: '2025-09-01', to: '2025-09-02' },
      new AbortController().signal,
    );
    expect(result.snapshotDate).toBe('2025-09-02');
    expect(result.totals).toEqual({ residents: 35, attendance: 13 });
    expect(result.clients).toEqual([{ name: 'Клиент А', attendance: 13 }]);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/dashboard?from=2025-09-01&to=2025-09-02');
    await loadDashboard(
      { from: '2025-09-01', to: '2025-09-02' },
      new AbortController().signal,
      '7',
    );
    expect(fetchMock.mock.calls[1][0]).toContain('dormitory_id=7');
  });

  it('по умолчанию выбирает весь текущий месяц и показывает отсутствие данных без вымышленных чисел', async () => {
    const loader = vi.fn<DashboardLoader>().mockResolvedValue(EMPTY_DASHBOARD);
    render(<Dashboard loader={loader} />);
    const month = currentMonth();
    expect(screen.getByLabelText('От')).toHaveValue(month.from);
    expect(screen.getByLabelText('До')).toHaveValue(month.to);
    await waitFor(() =>
      expect(screen.queryByText('Загружаем показатели…')).not.toBeInTheDocument(),
    );
    expect(loader).toHaveBeenCalledWith(month, expect.any(AbortSignal), null);
    expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('—');
    expect(screen.getByTestId('dashboard-total-attendance')).toHaveTextContent('—');
    expect(screen.getByText('За этот период пока нет данных')).toBeInTheDocument();
    for (const title of [
      'Вахтовики по общежитиям',
      'Текучка по общежитиям',
      'Выход на работу',
      'Свободные места',
      'Сохранение отчётов сегодня',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText('Доработать после готовности отчётов')).toBeInTheDocument();
    expect(screen.queryByText('Общежитие №3')).not.toBeInTheDocument();
  });

  it('переключает независимые серии, включая один показатель и пустой выбор', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const user = userEvent.setup();
    render(<Dashboard loader={() => Promise.resolve(DATA)} />);
    await waitFor(() =>
      expect(screen.getByTestId('chart-series-attendance').querySelectorAll('circle')).toHaveLength(
        2,
      ),
    );
    expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('35');
    expect(screen.getByTestId('dashboard-total-attendance')).toHaveTextContent('23');

    await user.click(screen.getByRole('checkbox', { name: 'Выход' }));
    await user.click(screen.getByRole('checkbox', { name: 'Текучка' }));
    expect(screen.queryByTestId('chart-series-attendance')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-series-turnover')).not.toBeInTheDocument();
    expect(screen.getByTestId('chart-series-residents').querySelectorAll('circle')).toHaveLength(2);
    await user.click(screen.getByRole('checkbox', { name: 'Проживающие' }));
    expect(screen.getByText('Выберите показатели')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Выход' }));
    expect(screen.getByTestId('chart-series-attendance')).toBeInTheDocument();
    expect(screen.queryByText('Выберите показатели')).not.toBeInTheDocument();
  });

  it('применяет включительный период к загрузчику и графику, сбрасывает его на текущий месяц', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const loader = vi.fn<DashboardLoader>().mockResolvedValue(DATA);
    render(<Dashboard loader={loader} />);
    await waitFor(() =>
      expect(screen.queryByText('Загружаем показатели…')).not.toBeInTheDocument(),
    );

    setPeriod('2026-09-30', '2026-09-30');
    await waitFor(() =>
      expect(loader).toHaveBeenLastCalledWith(
        { from: '2026-09-30', to: '2026-09-30' },
        expect.any(AbortSignal),
        null,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('chart-series-attendance').querySelectorAll('circle')).toHaveLength(
        1,
      ),
    );
    expect(screen.getByTestId('chart-series-attendance')).toHaveTextContent(
      '30.09.2026 · Выход: 12',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Текущий месяц' }));
    await waitFor(() => expect(screen.getByLabelText('От')).toHaveValue('2026-10-01'));
    expect(screen.getByLabelText('До')).toHaveValue('2026-10-31');
    await waitFor(() =>
      expect(screen.getByTestId('chart-series-attendance').querySelectorAll('circle')).toHaveLength(
        2,
      ),
    );
  });

  it('не применяет обратный или неполный период', async () => {
    const loader = vi.fn<DashboardLoader>().mockResolvedValue(EMPTY_DASHBOARD);
    render(<Dashboard loader={loader} />);
    await waitFor(() =>
      expect(screen.queryByText('Загружаем показатели…')).not.toBeInTheDocument(),
    );
    setPeriod('2026-10-10', '2026-10-01');
    expect(screen.getByRole('alert')).toHaveTextContent('Дата «От» должна быть не позже');
    expect(loader).toHaveBeenCalledTimes(1);
    setPeriod('', '2026-10-01');
    expect(screen.getByRole('alert')).toHaveTextContent('Укажите обе даты полностью');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('переключает график на общежитие и обратно, сохраняя общие показатели', async () => {
    const user = userEvent.setup();
    const loader = vi.fn<DashboardLoader>().mockImplementation(async (_range, _signal, id) => ({
      ...DATA,
      daily:
        id === 'one'
          ? [{ date: '2026-10-02', residents: 20, attendance: 15, turnover: 2 }]
          : DATA.daily,
    }));
    render(<Dashboard loader={loader} />);
    const selector = screen.getByRole('combobox', { name: 'Общежитие' });
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('35'),
    );
    expect(selector).toHaveValue('');
    await user.selectOptions(selector, 'one');
    await waitFor(() =>
      expect(loader).toHaveBeenLastCalledWith(expect.any(Object), expect.any(AbortSignal), 'one'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('chart-series-attendance')).toHaveTextContent('Выход: 15'),
    );
    expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('35');
    await user.selectOptions(selector, '');
    await waitFor(() =>
      expect(screen.getByTestId('chart-series-attendance')).toHaveTextContent('Выход: 23'),
    );
  });

  it('отличает нулевой показатель от отсутствующего и оставляет статусы отчётов неподключёнными', async () => {
    render(<Dashboard loader={() => Promise.resolve(DATA)} />);
    const turnover = screen.getByRole('region', { name: 'Текучка по общежитиям' });
    await waitFor(() => expect(within(turnover).getByText('Южное')).toBeInTheDocument());
    expect(within(turnover).getByText('0')).toBeInTheDocument();
    const attendance = screen.getByRole('region', { name: 'Выход на работу' });
    expect(within(attendance).getByText('Клиент А')).toBeInTheDocument();
    expect(within(attendance).getByText('15')).toBeInTheDocument();
    expect(within(attendance).queryByText('Северное')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Свободные места' })).getByText('—'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Ожидает подключения отчётов')).toHaveLength(2);
  });

  it('позволяет повторить загрузку после ошибки', async () => {
    const loader = vi
      .fn<DashboardLoader>()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(DATA);
    render(<Dashboard loader={loader} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить показатели');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('35'),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('игнорирует запоздавший ответ для предыдущего периода', async () => {
    let resolveFirst!: (data: DashboardData) => void;
    const loader = vi
      .fn<DashboardLoader>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...DATA, totals: { residents: 99, attendance: 80 } });
    render(<Dashboard loader={loader} />);
    setPeriod('2026-09-01', '2026-09-30');
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('99'),
    );
    expect(loader.mock.calls[0][1].aborted).toBe(true);
    resolveFirst(DATA);
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-total-residents')).toHaveTextContent('99'),
    );
  });
});
