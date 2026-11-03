import { useId } from 'react';
import { WorkspaceIcon } from '../WorkspaceIcon';
import resident from '../../assets/avatar-rezident.svg';
import manager from '../../assets/avatar-kadrovik.svg';
import commandant from '../../assets/avatar-komendant.svg';
import type { DashboardData, DailyMetrics, DormitoryMetrics, Metric } from './data';
import { formatCount } from './data';
import { dateNumber, formatDate, todayDate } from './dates';
import type { DateRange } from './dates';
import { filteredDays } from './chart';
import { reportReady, totalTurnover } from './summary';
import s from './DashboardSummary.module.css';

function Sparkline({
  rows,
  range,
  metric,
  label,
  color,
}: {
  rows: DailyMetrics[];
  range: DateRange;
  metric: Metric;
  label: string;
  color: string;
}): JSX.Element {
  const id = useId();
  const days = filteredDays(rows, range);
  const values = days.flatMap((row) => (row[metric] === null ? [] : [row[metric]!]));
  if (!values.length) return <span className={s.noTrend}>Нет данных о динамике</span>;
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values);
  const duration = dateNumber(range.to) - dateNumber(range.from);
  const x = (date: string): number =>
    4 + (duration ? (dateNumber(date) - dateNumber(range.from)) / duration : 0.5) * 232;
  const y = (value: number): number => 49 - ((value - min) / (max - min)) * 42;
  const paths: string[] = [];
  let segment = '',
    previousDate: string | null = null;
  for (const day of days) {
    if (
      day[metric] === null ||
      (previousDate && dateNumber(day.date) - dateNumber(previousDate) !== 86_400_000)
    ) {
      if (segment) paths.push(segment);
      segment = '';
    }
    if (day[metric] !== null) segment += `${segment ? ' L' : 'M'}${x(day.date)},${y(day[metric]!)}`;
    previousDate = day.date;
  }
  if (segment) paths.push(segment);
  return (
    <svg
      className={s.sparkline}
      viewBox="0 0 240 56"
      preserveAspectRatio="none"
      role="img"
      aria-labelledby={id}
      data-testid={`summary-trend-${metric}`}
    >
      <title id={id}>
        {label} по всем общежитиям: с {formatDate(range.from)} по {formatDate(range.to)}.{' '}
        {days
          .filter((day) => day[metric] !== null)
          .map((day) => `${formatDate(day.date, false)}: ${formatCount(day[metric])}`)
          .join('; ')}
      </title>
      {paths.map((path, i) => (
        <path
          key={i}
          d={path}
          stroke={color}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {days
        .filter((day) => day[metric] !== null)
        .map((day) => (
          <circle key={day.date} cx={x(day.date)} cy={y(day[metric]!)} r="2.2" fill={color} />
        ))}
    </svg>
  );
}

export function ReportProgress({
  dormitories,
  date,
  dark = false,
}: {
  dormitories: DormitoryMetrics[];
  date: string;
  dark?: boolean;
}): JSX.Element {
  const states = dormitories.map((dorm) => reportReady(dorm, date));
  const ready = states.filter((state) => state === true).length;
  const unknown = states.filter((state) => state === null).length;
  const known = states.length - unknown;
  return (
    <div className={s.reportProgress} data-dark={dark}>
      <div className={s.reportCount}>
        <strong data-testid={dark ? 'dashboard-reports-ready' : undefined}>
          {known ? ready : '—'}
        </strong>
        <span>{dormitories.length ? `из ${dormitories.length} готовы` : 'Пока нет общежитий'}</span>
      </div>
      {!!states.length && (
        <div
          className={s.reportTrack}
          aria-label={`Готовы ${ready} из ${states.length} отчётов; статус недоступен: ${unknown}`}
          role="img"
        >
          <span style={{ width: `${(ready / states.length) * 100}%` }} />
          <i style={{ width: `${(unknown / states.length) * 100}%` }} />
        </div>
      )}
      {unknown > 0 && <span className={s.unknownReports}>Статус недоступен: {unknown}</span>}
    </div>
  );
}

export function DashboardSummary({
  data,
  range,
  snapshot,
  loading,
}: {
  data: DashboardData;
  range: DateRange;
  snapshot: string;
  loading: boolean;
}): JSX.Element {
  const trendRange = { ...range, to: range.to < snapshot ? range.to : snapshot };
  const turnover = totalTurnover(data.dormitories);
  const reportDate = data.reportDate ?? todayDate();
  return (
    <section className={s.hero} aria-label="Общие данные" aria-busy={loading}>
      <div className={s.intro}>
        <p className={s.date}>Сводка на {formatDate(snapshot)}</p>
        <h2>
          Общежития
          <br />в одном ритме
        </h2>
        <p className={s.residentsLabel}>Всего проживающих</p>
        <div className={s.residents}>
          <strong data-testid="dashboard-total-residents">
            {formatCount(data.totals.residents)}
          </strong>
          <span>
            человек
            <br />
            проживают сейчас
          </span>
        </div>
        <div className={s.people} aria-hidden="true">
          {[resident, manager, commandant].map((src) => (
            <img key={src} src={src} alt="" />
          ))}
        </div>
        <p className={s.scope}>По всем общежитиям</p>
      </div>
      <div className={s.cells}>
        <article className={s.cell}>
          <WorkspaceIcon name="chart" />
          <h3>Общий выход на работу</h3>
          <p className={s.value} data-testid="dashboard-total-attendance">
            {formatCount(data.totals.attendance)}
            <span>чел.</span>
          </p>
          <Sparkline
            rows={loading ? [] : data.daily}
            range={trendRange}
            metric="attendance"
            label="Выход на работу"
            color="#a7d8ee"
          />
        </article>
        <article className={s.cell}>
          <WorkspaceIcon name="door" />
          <h3>Текучка</h3>
          <p className={s.value} data-testid="dashboard-total-turnover">
            {formatCount(turnover)}
            <span>чел.</span>
          </p>
          <Sparkline
            rows={loading ? [] : data.daily}
            range={trendRange}
            metric="turnover"
            label="Текучка"
            color="#f5c99f"
          />
        </article>
        <article className={`${s.cell} ${s.reportCell}`}>
          <div className={s.reportHeading}>
            <WorkspaceIcon name="document" />
            <h3>Отчёты сегодня</h3>
            <span>{formatDate(reportDate)}</span>
          </div>
          <ReportProgress dormitories={data.dormitories} date={reportDate} dark />
        </article>
      </div>
    </section>
  );
}
