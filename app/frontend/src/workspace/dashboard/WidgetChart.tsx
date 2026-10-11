import { useEffect, useRef, useState } from 'react';
import type { WidgetResult } from '../../api/dashboardBlocks';
import { CHART, chartX } from './chart';
import { formatCount } from './data';
import { dateNumber, formatDate, isCalendarDate, rangeTicks } from './dates';
import type { DateRange } from './dates';
import styles from './WidgetChart.module.css';

const compactNumber = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function WidgetChart({
  result,
  range,
  name,
}: {
  result: WidgetResult;
  range: DateRange;
  name: string;
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(200, Math.round(entry.contentRect.width)));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const comparing = !!result.series?.length;
  const lines = (
    comparing
      ? [...result.series!]
          .sort((a, b) => a.dormitory_id - b.dormitory_id)
          .map((series) => ({
            key: String(series.dormitory_id),
            label: series.label + (series.is_archived ? ' (Архив)' : ''),
            color: `hsl(${(series.dormitory_id * 137.508) % 360} 65% 36%)`,
            daily: series.daily,
          }))
      : [{ key: 'total', label: name, color: '#1f7766', daily: result.daily ?? [] }]
  ).map((line) => ({
    ...line,
    daily: line.daily
      .filter(
        (point) => isCalendarDate(point.date) && point.date >= range.from && point.date <= range.to,
      )
      .sort((a, b) => a.date.localeCompare(b.date)),
  }));
  const visible = lines.filter((line) => !hidden.has(line.key));
  const values = visible.flatMap((line) =>
    line.daily.flatMap((point) => (point.value === null ? [] : [point.value])),
  );
  const min = values.reduce((value, next) => Math.min(value, next), 0),
    max = values.reduce((value, next) => Math.max(value, next), 0);
  const ceiling = max === min ? min + 1 : max;
  const y = (value: number): number =>
    CHART.top + ((ceiling - value) / (ceiling - min)) * (CHART.height - CHART.top - CHART.bottom);
  const segments = (days: { date: string; value: number | null }[]): string[] => {
    const paths: string[] = [];
    let segment = '',
      previous: string | null = null;
    for (const point of days) {
      if (
        point.value === null ||
        (previous !== null && dateNumber(point.date) - dateNumber(previous) !== 86_400_000)
      ) {
        if (segment) paths.push(segment);
        segment = '';
      }
      if (point.value !== null)
        segment += `${segment ? ' L' : 'M'}${chartX(point.date, range, width)},${y(point.value)}`;
      previous = point.date;
    }
    if (segment) paths.push(segment);
    return paths;
  };
  const dates = [
    ...new Set(visible.flatMap((line) => line.daily.map((point) => point.date))),
  ].sort();
  const dailyValues = visible.map(
    (line) => new Map(line.daily.map((point) => [point.date, point.value])),
  );
  return (
    <>
      {comparing && (
        <div className={styles.legend} role="group" aria-label="Общежития на графике">
          {lines.map((line) => (
            <button
              key={line.key}
              type="button"
              aria-pressed={!hidden.has(line.key)}
              onClick={() =>
                setHidden((current) => {
                  const next = new Set(current);
                  if (next.has(line.key)) next.delete(line.key);
                  else next.add(line.key);
                  return next;
                })
              }
            >
              <span
                className={styles.swatch}
                style={{ backgroundColor: line.color }}
                aria-hidden="true"
              />
              {line.label}
            </button>
          ))}
        </div>
      )}
      <div className={styles.widgetChart} ref={container}>
        <svg
          viewBox={`0 0 ${width} ${CHART.height}`}
          className={styles.chart}
          role="img"
          aria-label={`Динамика: ${name}`}
        >
          <title>
            {name}: {formatDate(range.from)} — {formatDate(range.to)}
          </title>
          {[0, 1, 2, 3, 4].map((tick) => {
            const value = min + ((ceiling - min) * tick) / 4;
            return (
              <g key={tick}>
                <line
                  x1={CHART.left}
                  x2={width - CHART.right}
                  y1={y(value)}
                  y2={y(value)}
                  className={styles.gridLine}
                />
                <text
                  x={CHART.left - 10}
                  y={y(value) + 4}
                  textAnchor="end"
                  className={styles.axisText}
                >
                  {values.length
                    ? Math.abs(value) >= 10000
                      ? compactNumber.format(value)
                      : formatCount(value)
                    : '—'}
                </text>
              </g>
            );
          })}
          {rangeTicks(range, width < 400 ? 3 : 5).map((day) => (
            <text
              key={day}
              x={chartX(day, range, width)}
              y={CHART.height - 12}
              textAnchor="middle"
              className={styles.axisText}
            >
              {formatDate(day, false)}
            </text>
          ))}
          {visible.map((line) => (
            <g key={line.key} data-series-id={line.key} style={{ color: line.color }}>
              {segments(line.daily).map((path, index) => (
                <path key={index} d={path} className={styles.widgetLine} />
              ))}
              {line.daily
                .filter((point) => point.value !== null)
                .map((point) => (
                  <circle
                    key={point.date}
                    cx={chartX(point.date, range, width)}
                    cy={y(point.value!)}
                    r="3.5"
                    className={styles.widgetPoint}
                  >
                    <title>
                      {comparing ? line.label + ' · ' : ''}
                      {formatDate(point.date)}: {formatCount(point.value)}
                    </title>
                  </circle>
                ))}
            </g>
          ))}
        </svg>
      </div>
      {!values.length && (
        <p className={styles.widgetHint} role="status">
          {visible.length
            ? 'За этот период нет данных для графика'
            : 'Выберите общежития в легенде над графиком'}
        </p>
      )}
      <details className={styles.dailyDetails}>
        <summary>Данные по дням</summary>
        <div className={styles.tableScroll}>
          <table>
            <caption className={styles.srOnly}>{name} по датам</caption>
            <thead>
              <tr>
                <th scope="col">Дата</th>
                {visible.map((line) => (
                  <th scope="col" key={line.key}>
                    {comparing ? line.label : 'Значение'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((day) => (
                <tr key={day}>
                  <th scope="row">{formatDate(day)}</th>
                  {visible.map((line, index) => (
                    <td key={line.key}>{formatCount(dailyValues[index].get(day) ?? null)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
