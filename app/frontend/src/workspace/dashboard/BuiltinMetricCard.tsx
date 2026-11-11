import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type {
  BuiltinBlockConfig,
  BuiltinMetric,
  DashboardBreakdown,
} from '../../api/dashboardBlocks';
import { BUILTIN_BLOCK_NAMES } from '../../api/dashboardBlocks';
import { WorkspaceIcon } from '../WorkspaceIcon';
import type { WorkspaceIconName } from '../WorkspaceIcon';
import type { DashboardData } from './data';
import { formatDate, rangeError, todayDate } from './dates';
import type { DateRange } from './dates';
import { MetricBars } from './MetricBars';
import styles from './Dashboard.module.css';

const appearance: Record<
  BuiltinMetric,
  { icon: WorkspaceIconName; tone: string; description: string }
> = {
  residents: { icon: 'people', tone: 'mint', description: 'Количество проживающих · человек' },
  turnover: { icon: 'door', tone: 'peach', description: 'На дату среза · человек' },
  attendance: { icon: 'chart', tone: 'sky', description: 'По каждому клиенту · человек' },
};

export function BuiltinMetricCard({
  metric,
  config,
  data,
  range,
}: {
  metric: BuiltinMetric;
  config?: BuiltinBlockConfig;
  data: DashboardData;
  range: DateRange;
}): JSX.Element {
  const mode = config?.date_mode ?? 'overview';
  const aggregate = mode === 'range' ? (config?.aggregate ?? 'last') : 'last';
  const snapshot = data.snapshotDate ?? (range.to < todayDate() ? range.to : todayDate());
  const [selection, setSelection] = useState<DateRange | null>(null);
  const [draft, setDraft] = useState<DateRange | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [validation, setValidation] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<DashboardBreakdown | null>(null);
  const { from, to } = selection ?? (mode === 'date' ? { from: snapshot, to: snapshot } : range);
  const fields = draft ?? { from, to };
  useEffect(() => {
    if (mode === 'overview') return;
    const controller = new AbortController();
    setResult(null);
    setError('');
    void api.dashboardBreakdown(metric, from, to, aggregate, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setResult(response);
      },
      (caught: unknown) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить показатель.',
          );
      },
    );
    return () => controller.abort();
  }, [mode, metric, from, to, aggregate, attempt, data]);

  function applyDates(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const error = rangeError(fields);
    setValidation(error);
    if (error) return;
    setSelection(fields);
    setDraft(null);
    setAttempt((value) => value + 1);
  }

  const clients = metric === 'attendance';
  const items =
    mode === 'overview'
      ? clients
        ? data.clients.map((client) => ({
            id: client.name,
            label: client.name,
            value: client.attendance,
          }))
        : data.dormitories.map((dorm) => ({
            id: dorm.id,
            label: dorm.name,
            value: dorm[metric],
            archived: dorm.is_archived,
          }))
      : (result?.items ?? []);
  const { icon, tone, description } = appearance[metric];
  let subtitle = description;
  if (mode !== 'overview' && result?.to_date) {
    const end = formatDate(result.to_date);
    subtitle =
      aggregate === 'last'
        ? `На ${end}`
        : `${aggregate === 'average' ? 'Среднее' : 'Сумма'} · ${formatDate(from)} — ${end}`;
  }
  return (
    <section className={styles.card} aria-labelledby={`breakdown-${metric}`}>
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle} id={`breakdown-${metric}`}>
            {config?.name ?? BUILTIN_BLOCK_NAMES[metric]}
          </h3>
          <p className={styles.cardSubtitle}>{subtitle}</p>
        </div>
        <span className={styles.blockIcon} data-tone={tone}>
          <WorkspaceIcon name={icon} />
        </span>
      </div>
      {mode !== 'overview' && (
        <form className={styles.breakdownDates} noValidate onSubmit={applyDates}>
          <label className={styles.dateField}>
            {mode === 'date' ? 'Дата' : 'От'}
            <input
              type="date"
              value={fields.from}
              onChange={(event) => {
                const value = event.target.value;
                setDraft({ from: value, to: mode === 'date' ? value : fields.to });
                setValidation('');
              }}
            />
          </label>
          {mode === 'range' && (
            <label className={styles.dateField}>
              До
              <input
                type="date"
                value={fields.to}
                onChange={(event) => {
                  setDraft({ ...fields, to: event.target.value });
                  setValidation('');
                }}
              />
            </label>
          )}
          <button type="submit" className="btn btn--ghost btn--compact">
            Показать
          </button>
          {validation && <p role="alert">{validation}</p>}
        </form>
      )}
      {error ? (
        <p role="alert" className={styles.widgetHint}>
          {error}
        </p>
      ) : mode !== 'overview' && !result ? (
        <p role="status" className={styles.widgetHint}>
          Загружаем показатель…
        </p>
      ) : items.length ? (
        <MetricBars clients={clients} items={items} />
      ) : (
        <div className={styles.blockEmpty}>
          <WorkspaceIcon name="house" />
          <p>
            {mode === 'overview' ? 'Пока нет данных по общежитиям' : 'Нет данных за выбранные даты'}
          </p>
          {mode === 'overview' && <span>Здесь появится разбивка после заполнения отчётов.</span>}
        </div>
      )}
    </section>
  );
}
