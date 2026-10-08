import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { WorkspaceIcon } from '../WorkspaceIcon';
import type { WorkspaceIconName } from '../WorkspaceIcon';
import { DashboardChart } from './DashboardChart';
import { EMPTY_DASHBOARD, formatCount, loadDashboard, METRICS } from './data';
import type { DashboardData, DashboardLoader, DormitoryMetrics, Metric } from './data';
import { currentMonth, formatDate, rangeError, todayDate } from './dates';
import type { DateRange } from './dates';
import styles from './Dashboard.module.css';

const breakdowns: {
  key: keyof Pick<DormitoryMetrics, 'residents' | 'attendance' | 'turnover' | 'vacancies'>;
  title: string;
  icon: WorkspaceIconName;
  tone: string;
  description: string;
}[] = [
  {
    key: 'residents',
    title: 'Вахтовики по общежитиям',
    icon: 'people',
    tone: 'mint',
    description: 'Количество проживающих · человек',
  },
  {
    key: 'turnover',
    title: 'Текучка по общежитиям',
    icon: 'door',
    tone: 'peach',
    description: 'На дату среза · человек',
  },
  {
    key: 'attendance',
    title: 'Выход на работу',
    icon: 'chart',
    tone: 'sky',
    description: 'По каждому клиенту · человек',
  },
  {
    key: 'vacancies',
    title: 'Свободные места',
    icon: 'bed',
    tone: 'lilac',
    description: 'По каждому общежитию · мест',
  },
];

export function Dashboard({ loader = loadDashboard }: { loader?: DashboardLoader }): JSX.Element {
  const [range, setRange] = useState<DateRange>(() => currentMonth());
  const [draft, setDraft] = useState<DateRange>(range);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Metric[]>(METRICS.map((metric) => metric.key));
  const [chartDormitoryId, setChartDormitoryId] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    range: DateRange;
    data: DashboardData;
    status: 'loading' | 'ready' | 'error';
  }>({ range, data: EMPTY_DASHBOARD, status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setResult((current) => ({
      range,
      data: current.range === range ? current.data : EMPTY_DASHBOARD,
      status: 'loading',
    }));
    void loader(range, controller.signal, chartDormitoryId || null)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ range, data, status: 'ready' });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ range, data: EMPTY_DASHBOARD, status: 'error' });
      });
    return () => controller.abort();
  }, [range, chartDormitoryId, loader, attempt]);

  const data = result.range === range ? result.data : EMPTY_DASHBOARD;
  const loading = result.range !== range || result.status === 'loading';
  const snapshot =
    data.snapshotDate ??
    (range.from <= todayDate() ? (range.to < todayDate() ? range.to : todayDate()) : range.to);
  const snapshotLabel = `На ${formatDate(snapshot)}`;

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
          <p className={styles.lead}>Проживание и работа — по всем общежитиям</p>
        </div>
        <span className={styles.scopeBadge}>
          <WorkspaceIcon name="house" />
          Все общежития
        </span>
      </div>

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
          <button className={styles.applyButton} type="submit">
            Применить
          </button>
          <button className={styles.resetButton} type="button" onClick={resetPeriod}>
            Текущий месяц
          </button>
        </div>
        {error && (
          <p className={styles.formError} id="dashboard-period-error" role="alert">
            {error}
          </p>
        )}
      </form>

      <p className={styles.snapshotNote}>
        {snapshotLabel}: проживающие, выход и текучка. Свободные места подключим позже.
      </p>
      {loading && (
        <p className={styles.loading} role="status">
          Загружаем показатели…
        </p>
      )}
      {result.status === 'error' && (
        <div className={styles.loadError} role="alert">
          <span>Не удалось загрузить показатели. Попробуйте ещё раз.</span>
          <button type="button" onClick={() => setAttempt((current) => current + 1)}>
            Повторить
          </button>
        </div>
      )}

      <section className={styles.summary} aria-label="Общие данные" aria-busy={loading}>
        <article className={`${styles.summaryCard} ${styles.summaryResidents}`}>
          <div>
            <p className={styles.summaryLabel}>Всего проживающих</p>
            <p className={styles.summaryValue} data-testid="dashboard-total-residents">
              {formatCount(data.totals.residents)}
              <span>чел.</span>
            </p>
            <p className={styles.summaryHint}>По всем общежитиям · {snapshotLabel.toLowerCase()}</p>
          </div>
          <span className={styles.summaryIcon}>
            <WorkspaceIcon name="people" />
          </span>
        </article>
        <article className={`${styles.summaryCard} ${styles.summaryAttendance}`}>
          <div>
            <p className={styles.summaryLabel}>Общий выход на работу</p>
            <p className={styles.summaryValue} data-testid="dashboard-total-attendance">
              {formatCount(data.totals.attendance)}
              <span>чел.</span>
            </p>
            <p className={styles.summaryHint}>По всем общежитиям · {snapshotLabel.toLowerCase()}</p>
          </div>
          <span className={styles.summaryIcon}>
            <WorkspaceIcon name="chart" />
          </span>
        </article>
      </section>

      <DashboardChart
        rows={loading ? [] : data.daily}
        range={range}
        selected={selected}
        onToggle={toggleMetric}
        dormitories={result.data.dormitories}
        dormitoryId={chartDormitoryId}
        onDormitoryChange={setChartDormitoryId}
      />

      <div className={styles.sectionHeading}>
        <h2>По общежитиям</h2>
        <span>
          {data.dormitories.length
            ? `${data.dormitories.length} общежитий`
            : 'Список пока не заполнен'}
        </span>
      </div>
      <div className={styles.breakdownGrid} aria-busy={loading}>
        {breakdowns.map((block) => (
          <section
            key={block.key}
            className={styles.card}
            aria-labelledby={`breakdown-${block.key}`}
          >
            <div className={styles.cardHead}>
              <div>
                <h3 className={styles.cardTitle} id={`breakdown-${block.key}`}>
                  {block.title}
                </h3>
                <p className={styles.cardSubtitle}>{block.description}</p>
              </div>
              <span className={styles.blockIcon} data-tone={block.tone}>
                <WorkspaceIcon name={block.icon} />
              </span>
            </div>
            {(block.key === 'attendance' ? data.clients.length : data.dormitories.length) ? (
              <ul className={styles.metricList}>
                {block.key === 'attendance'
                  ? data.clients.map((client) => (
                      <li key={client.name}>
                        <span>{client.name}</span>
                        <strong>{formatCount(client.attendance)}</strong>
                      </li>
                    ))
                  : data.dormitories.map((dormitory) => (
                      <li
                        key={dormitory.id}
                        data-archived={dormitory.is_archived ? 'true' : 'false'}
                      >
                        <span>
                          {dormitory.name}
                          {dormitory.is_archived ? ' (Архив)' : ''}
                        </span>
                        <strong>{formatCount(dormitory[block.key])}</strong>
                      </li>
                    ))}
              </ul>
            ) : (
              <div className={styles.blockEmpty}>
                <WorkspaceIcon name="house" />
                <p>Пока нет данных по общежитиям</p>
                <span>Здесь появится разбивка после заполнения отчётов.</span>
              </div>
            )}
          </section>
        ))}
      </div>

      <section
        className={`${styles.card} ${styles.reportsCard}`}
        aria-labelledby="reports-status-title"
      >
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle} id="reports-status-title">
              Сохранение отчётов сегодня
            </h2>
            <p className={styles.cardSubtitle}>Все общежития · {formatDate(todayDate())}</p>
          </div>
          <span className={styles.pendingBadge}>Доработать после готовности отчётов</span>
        </div>
        <div className={styles.reportLegend}>
          <span>
            <i className={styles.statusDot} data-status="saved" aria-hidden="true" />
            Сохраняли сегодня
          </span>
          <span>
            <i className={styles.statusDot} data-status="missing" aria-hidden="true" />
            Сегодня не сохраняли
          </span>
          <span>
            <i className={styles.statusDot} aria-hidden="true" />
            Статус пока недоступен
          </span>
        </div>
        {data.dormitories.length ? (
          <ul className={styles.metricList}>
            {data.dormitories.map((dormitory) => (
              <li key={dormitory.id} data-archived={dormitory.is_archived ? 'true' : 'false'}>
                <span>
                  {dormitory.name}
                  {dormitory.is_archived ? ' (Архив)' : ''}
                </span>
                <span className={styles.pendingStatus}>
                  <i className={styles.statusDot} aria-hidden="true" />
                  Ожидает подключения отчётов
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.reportsEmpty}>
            Здесь будет список всех общежитий и отметка сохранения отчёта за текущий день.
          </p>
        )}
        <p className={styles.reportNote}>
          <WorkspaceIcon name="info" />
          Проверку сохранения подключим, когда будет готов раздел отчётов.
        </p>
      </section>
    </section>
  );
}
