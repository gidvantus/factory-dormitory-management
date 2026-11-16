import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { WorkspaceIcon } from '../WorkspaceIcon';
import { BUILTIN_BLOCK_NAMES } from '../../api/dashboardBlocks';
import type { BuiltinMetric } from '../../api/dashboardBlocks';
import { DashboardChart } from './DashboardChart';
import { EMPTY_DASHBOARD, loadDashboard, METRICS } from './data';
import type { DashboardData, DashboardLoader, DailyMetrics, Metric } from './data';
import { currentMonth, formatDate, rangeError, todayDate } from './dates';
import type { DateRange } from './dates';
import styles from './Dashboard.module.css';
import { usePageRefresh } from '../usePageRefresh';
import { DashboardBlocks } from './DashboardBlocks';
import { DashboardSummary, ReportProgress } from './DashboardSummary';
import { reportReady } from './summary';

const breakdowns: BuiltinMetric[] = ['residents', 'turnover', 'attendance'];

export function Dashboard({
  loader = loadDashboard,
  tariffSlot,
}: {
  loader?: DashboardLoader;
  /** Блок тарифа организации: обзор показывает его под заголовком. */
  tariffSlot?: ReactNode;
}): JSX.Element {
  const [range, setRange] = useState<DateRange>(() => currentMonth());
  const [draft, setDraft] = useState<DateRange>(range);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Metric[]>(METRICS.map((metric) => metric.key));
  const [chartDormitoryId, setChartDormitoryId] = useState('');
  const [attempt, setAttempt] = useState(0);
  const revision = usePageRefresh();
  const [result, setResult] = useState<{
    range: DateRange;
    data: DashboardData;
    status: 'loading' | 'ready' | 'error';
  }>({ range, data: EMPTY_DASHBOARD, status: 'loading' });
  const [chartResult, setChartResult] = useState<{
    range: DateRange;
    dormitoryId: string;
    rows: DailyMetrics[];
    status: 'loading' | 'ready' | 'error';
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setResult((current) => ({
      range,
      data: current.range === range ? current.data : EMPTY_DASHBOARD,
      status: current.range === range && current.status === 'ready' ? 'ready' : 'loading',
    }));
    void loader(range, controller.signal, null)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult({ range, data, status: 'ready' });
          setChartDormitoryId((current) =>
            data.dormitories.some((item) => item.id === current) ? current : '',
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ range, data: EMPTY_DASHBOARD, status: 'error' });
      });
    return () => controller.abort();
  }, [range, loader, attempt, revision]);

  // Общая динамика нужна сводке даже при выборе отдельного общежития на графике.
  useEffect(() => {
    if (!chartDormitoryId) return;
    const controller = new AbortController();
    setChartResult({ range, dormitoryId: chartDormitoryId, rows: [], status: 'loading' });
    void loader(range, controller.signal, chartDormitoryId)
      .then((data) => {
        if (!controller.signal.aborted)
          setChartResult({
            range,
            dormitoryId: chartDormitoryId,
            rows: data.daily,
            status: 'ready',
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setChartResult({ range, dormitoryId: chartDormitoryId, rows: [], status: 'error' });
      });
    return () => controller.abort();
  }, [range, chartDormitoryId, loader, attempt, revision]);

  const data = result.range === range ? result.data : EMPTY_DASHBOARD;
  const loading = result.range !== range || result.status === 'loading';
  const snapshot =
    data.snapshotDate ??
    (range.from <= todayDate() ? (range.to < todayDate() ? range.to : todayDate()) : range.to);
  const snapshotLabel = `На ${formatDate(snapshot)}`;
  const scopedChart =
    chartResult?.range === range && chartResult.dormitoryId === chartDormitoryId
      ? chartResult
      : null;
  const chartLoading =
    loading || (!!chartDormitoryId && (!scopedChart || scopedChart.status === 'loading'));
  const chartError = !!chartDormitoryId && scopedChart?.status === 'error';
  const chartRows = chartDormitoryId ? (scopedChart?.rows ?? []) : data.daily;

  function applyPeriod(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const message = rangeError(draft);
    setError(message);
    if (!message) setRange({ ...draft });
  }

  function resetPeriod(): void {
    const month = currentMonth();
    setDraft(month);
    setRange(month);
    setError('');
  }

  function toggleMetric(metric: Metric): void {
    setSelected((current) =>
      current.includes(metric) ? current.filter((key) => key !== metric) : [...current, metric],
    );
  }

  return (
    <section
      className={styles.dashboard}
      aria-labelledby="overview-title"
      data-testid="workspace-overview"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="overview-title" tabIndex={-1}>
            Обзор
          </h1>
          <p className={styles.lead}>Проживание и работа — по действующим общежитиям</p>
        </div>
        <span className={styles.scopeBadge}>
          <WorkspaceIcon name="house" />
          Действующие общежития
        </span>
      </div>

      {tariffSlot}

      <form
        className={styles.periodForm}
        onSubmit={applyPeriod}
        noValidate
        aria-label="Период дашборда"
      >
        <div className={styles.periodIntro}>
          <strong>Период</strong>
          <span>По умолчанию — текущий месяц</span>
        </div>
        <div className={styles.dateControls}>
          <label className={styles.dateField} htmlFor="dashboard-date-from">
            От
            <input
              id="dashboard-date-from"
              data-testid="dashboard-date-from"
              type="date"
              value={draft.from}
              onChange={(event) => {
                setDraft({ ...draft, from: event.target.value });
                setError('');
              }}
              aria-invalid={!!error}
              aria-describedby={error ? 'dashboard-period-error' : undefined}
            />
          </label>
          <label className={styles.dateField} htmlFor="dashboard-date-to">
            До
            <input
              id="dashboard-date-to"
              data-testid="dashboard-date-to"
              type="date"
              value={draft.to}
              onChange={(event) => {
                setDraft({ ...draft, to: event.target.value });
                setError('');
              }}
              aria-invalid={!!error}
              aria-describedby={error ? 'dashboard-period-error' : undefined}
            />
          </label>
          <button className="btn btn--primary btn--compact" type="submit">
            Применить
          </button>
          <button className="btn btn--ghost btn--compact" type="button" onClick={resetPeriod}>
            Текущий месяц
          </button>
        </div>
        {error && (
          <p className={styles.formError} id="dashboard-period-error" role="alert">
            {error}
          </p>
        )}
      </form>

      <p className={styles.snapshotNote}>{snapshotLabel}: проживающие, выход и текучка.</p>
      {loading && (
        <p className={styles.loading} role="status">
          Загружаем показатели…
        </p>
      )}
      {result.status === 'error' && (
        <div className={styles.loadError} role="alert">
          <span>Не удалось загрузить показатели. Попробуйте ещё раз.</span>
          <button
            type="button"
            className="link-button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Повторить
          </button>
        </div>
      )}

      <DashboardSummary data={data} range={range} snapshot={snapshot} loading={loading} />

      {chartError && !loading && (
        <div className={styles.loadError} role="alert">
          <span>Не удалось загрузить график общежития.</span>
          <button
            type="button"
            className="link-button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Повторить
          </button>
        </div>
      )}
      <DashboardChart
        rows={chartLoading ? [] : chartRows}
        loading={chartLoading}
        failed={chartError || result.status === 'error'}
        range={range}
        selected={selected}
        onToggle={toggleMetric}
        dormitories={result.data.dormitories}
        dormitoryId={chartDormitoryId}
        onDormitoryChange={setChartDormitoryId}
      />

      <DashboardBlocks
        data={data}
        range={range}
        loading={loading}
        onChange={() => setAttempt((value) => value + 1)}
        cards={[
          ...breakdowns.map((metric) => ({
            key: metric,
            name: BUILTIN_BLOCK_NAMES[metric],
            metric,
          })),
          {
            key: 'reports',
            name: 'Сохранение отчётов сегодня',
            content: (
              <section
                className={`${styles.card} ${styles.reportsCard}`}
                aria-labelledby="reports-status-title"
              >
                <div className={styles.cardHead}>
                  <div>
                    <h3 className={styles.cardTitle} id="reports-status-title">
                      Сохранение отчётов сегодня
                    </h3>
                    <p className={styles.cardSubtitle}>
                      Все общежития · {formatDate(data.reportDate ?? todayDate())}
                    </p>
                  </div>
                  <span className={styles.blockIcon} data-tone="lilac">
                    <WorkspaceIcon name="info" />
                  </span>
                </div>
                <ReportProgress
                  dormitories={data.dormitories}
                  date={data.reportDate ?? todayDate()}
                />
                {data.dormitories.length ? (
                  <ul className={styles.metricList}>
                    {data.dormitories.map((dormitory) => (
                      <li
                        key={dormitory.id}
                        data-archived={dormitory.is_archived ? 'true' : 'false'}
                      >
                        <span>
                          {dormitory.name}
                          {dormitory.is_archived ? ' (Архив)' : ''}
                        </span>
                        <span
                          className={styles.reportStatus}
                          data-ready={
                            reportReady(dormitory, data.reportDate ?? todayDate()) === null
                              ? 'unknown'
                              : reportReady(dormitory, data.reportDate ?? todayDate())
                                ? 'true'
                                : 'false'
                          }
                          title={
                            reportReady(dormitory, data.reportDate ?? todayDate())
                              ? [
                                  dormitory.report_readiness?.confirmed_by,
                                  dormitory.report_readiness?.confirmed_at &&
                                    new Intl.DateTimeFormat('ru-RU', {
                                      timeZone: 'Europe/Moscow',
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    }).format(new Date(dormitory.report_readiness.confirmed_at)),
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : undefined
                          }
                        >
                          <i className={styles.statusDot} aria-hidden="true" />
                          {reportReady(dormitory, data.reportDate ?? todayDate()) !== null
                            ? reportReady(dormitory, data.reportDate ?? todayDate())
                              ? 'Отчёт готов'
                              : 'Отчёт не готов'
                            : 'Статус недоступен'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.reportsEmpty}>Пока нет общежитий</p>
                )}
                <p className={styles.reportNote}>
                  Готовность за сегодня отмечается галочкой в общежитии.
                </p>
              </section>
            ),
          },
        ]}
      />
    </section>
  );
}
