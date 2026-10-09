import { useEffect, useRef, useState } from 'react';

import { WorkspaceIcon } from '../WorkspaceIcon';
import { CHART, chartSegments, chartX, chartY, filteredDays } from './chart';
import { formatCount, METRICS } from './data';
import type { DailyMetrics, DormitoryMetrics, Metric } from './data';
import { formatDate, rangeTicks } from './dates';
import type { DateRange } from './dates';
import styles from './Dashboard.module.css';

interface Props {
  rows: DailyMetrics[];
  range: DateRange;
  selected: Metric[];
  onToggle: (metric: Metric) => void;
  dormitories: DormitoryMetrics[];
  dormitoryId: string;
  onDormitoryChange: (id: string) => void;
}

export function DashboardChart({
  rows,
  range,
  selected,
  onToggle,
  dormitories,
  dormitoryId,
  onDormitoryChange,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(CHART.width);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setChartWidth(Math.max(200, Math.round(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const days = filteredDays(rows, range);
  const scopeName = dormitories.find((item) => item.id === dormitoryId)?.name ?? 'все общежития';
  const series = METRICS.filter((metric) => selected.includes(metric.key));
  const values = days.flatMap((day) =>
    series.flatMap((metric) => (day[metric.key] === null ? [] : [day[metric.key] as number])),
  );
  const hasData = values.length > 0;
  const max = Math.max(
    4,
    Math.ceil(values.reduce((largest, value) => Math.max(largest, value), 0) / 4) * 4,
  );

  return (
    <section className={styles.card} aria-labelledby="dynamics-title">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle} id="dynamics-title">
            Динамика показателей
          </h2>
          <p className={styles.cardSubtitle}>По дням · {scopeName}</p>
        </div>
        <div className={styles.chartFilters}>
          <label className={styles.dormitoryFilter}>
            Общежитие
            <select value={dormitoryId} onChange={(event) => onDormitoryChange(event.target.value)}>
              <option value="">Все общежития</option>
              {dormitories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <span className={styles.periodLabel}>
            {formatDate(range.from)} — {formatDate(range.to)}
          </span>
        </div>
      </div>
      <fieldset className={styles.seriesControls}>
        <legend className={styles.srOnly}>Показатели на графике</legend>
        {METRICS.map((metric) => (
          <label
            className={styles.seriesOption}
            key={metric.key}
            data-selected={selected.includes(metric.key)}
          >
            <input
              type="checkbox"
              checked={selected.includes(metric.key)}
              onChange={() => onToggle(metric.key)}
            />
            <span
              className={styles.seriesDot}
              style={{ backgroundColor: metric.color }}
              aria-hidden="true"
            />
            {metric.label}
          </label>
        ))}
        <span className={styles.selectionHint}>Можно выбрать несколько</span>
      </fieldset>
      <div className={styles.chartArea}>
        <div
          className={styles.chartScroll}
          ref={containerRef}
          tabIndex={0}
          role="region"
          aria-label="График по дням"
        >
          <svg
            viewBox={`0 0 ${chartWidth} ${CHART.height}`}
            className={styles.chart}
            role="img"
            aria-label={
              hasData
                ? `Динамика: ${series.map((metric) => metric.label).join(', ')}`
                : 'График без данных'
            }
          >
            <title>
              Показатели с {formatDate(range.from)} по {formatDate(range.to)}
            </title>
            {[0, 1, 2, 3, 4].map((tick) => {
              const value = (max * tick) / 4;
              const y = chartY(value, max);
              return (
                <g key={tick}>
                  <line
                    x1={CHART.left}
                    x2={chartWidth - CHART.right}
                    y1={y}
                    y2={y}
                    className={styles.gridLine}
                  />
                  <text x={CHART.left - 14} y={y + 4} textAnchor="end" className={styles.axisText}>
                    {hasData ? formatCount(value) : '—'}
                  </text>
                </g>
              );
            })}
            {rangeTicks(range, chartWidth < 400 ? 3 : 5).map((date) => (
              <text
                key={date}
                x={chartX(date, range, chartWidth)}
                y={CHART.height - 12}
                textAnchor="middle"
                className={styles.axisText}
              >
                {formatDate(date, false)}
              </text>
            ))}
            {series.map((metric) => (
              <g key={metric.key} data-testid={`chart-series-${metric.key}`}>
                {chartSegments(days, metric.key, range, max, chartWidth).map((path, index) => (
                  <path
                    key={index}
                    d={path}
                    fill="none"
                    stroke={metric.color}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {days
                  .filter((day) => day[metric.key] !== null)
                  .map((day) => (
                    <circle
                      key={day.date}
                      cx={chartX(day.date, range, chartWidth)}
                      cy={chartY(day[metric.key] as number, max)}
                      r="4"
                      fill={metric.color}
                      stroke="white"
                      strokeWidth="1.5"
                    >
                      <title>
                        {formatDate(day.date)} · {metric.label}: {formatCount(day[metric.key])}
                      </title>
                    </circle>
                  ))}
              </g>
            ))}
          </svg>
        </div>
        {!hasData && (
          <div className={styles.chartEmpty} role="status">
            <span className={styles.emptyIcon}>
              <WorkspaceIcon name="chart" />
            </span>
            <strong>
              {selected.length ? 'За этот период пока нет данных' : 'Выберите показатели'}
            </strong>
            <p>
              {selected.length
                ? 'График появится после заполнения отчётов.'
                : 'Включите один или несколько показателей над графиком.'}
            </p>
          </div>
        )}
      </div>
      <div className={styles.chartFooter}>
        <span>Количество человек</span>
        <span>Формула =0 показывает ноль до настройки строки</span>
      </div>
      {hasData && (
        <details className={styles.dailyDetails}>
          <summary>Данные по дням</summary>
          <div className={styles.tableScroll}>
            <table>
              <caption className={styles.srOnly}>Числовые значения выбранных показателей</caption>
              <thead>
                <tr>
                  <th scope="col">Дата</th>
                  {series.map((metric) => (
                    <th key={metric.key} scope="col">
                      {metric.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{formatDate(day.date)}</th>
                    {series.map((metric) => (
                      <td key={metric.key}>{formatCount(day[metric.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
