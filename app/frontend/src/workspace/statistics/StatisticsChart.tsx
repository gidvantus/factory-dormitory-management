import { useEffect, useRef, useState } from 'react';
import type { StatisticsBlock, StatisticsResult } from '../../api/statistics';
import { dateNumber, formatDate } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import { formatValue, operations } from './helpers';
import styles from './Statistics.module.css';

const colors = ['#2f7d62', '#7899bd', '#c49a53', '#9a8abf', '#c77f65'];
function DormitoryValues({
  items,
  multicolor = true,
}: {
  items: StatisticsResult['items'];
  multicolor?: boolean;
}): JSX.Element {
  return (
    <ul className={styles.dormitoryValues} aria-label="Общежития и значения за период">
      {items.map((item, index) => (
        <li key={item.dormitory_id}>
          <span
            className={styles.legendMarker}
            style={{ background: colors[multicolor ? index % colors.length : 0] }}
            aria-hidden="true"
          />
          <span className={styles.legendName}>
            {item.label}
            {item.is_archived && ' (Архив)'}
          </span>
          <strong>{formatValue(item.value)}</strong>
        </li>
      ))}
    </ul>
  );
}
function rangeDates(range: DateRange): string[] {
  return Array.from(
    {
      length: Math.min(
        366,
        Math.max(0, Math.round((dateNumber(range.to) - dateNumber(range.from)) / 86400000) + 1),
      ),
    },
    (_, index) => new Date(dateNumber(range.from) + index * 86400000).toISOString().slice(0, 10),
  );
}
export function StatisticsChart({
  block,
  result,
  range,
}: {
  block: StatisticsBlock;
  result: StatisticsResult;
  range: DateRange;
}): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(650);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = (): void => setViewportWidth(viewport.clientWidth || 650);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [block.display, block.breakdown]);
  const dates = rangeDates(range);
  if (block.display === 'number')
    return (
      <div className={styles.numberResult}>
        <strong>{formatValue(result.value)}</strong>
        <span>{operations[block.aggregation]}</span>
        <p className={styles.chartFootnote}>
          {formatDate(range.from)} — {formatDate(range.to)}
        </p>
      </div>
    );
  if (block.display === 'table')
    return (
      <>
        <div className={styles.tableScroll}>
          <table className={styles.matrix}>
            <caption className={styles.srOnly}>{block.name} по общежитиям и датам</caption>
            <thead>
              <tr>
                <th scope="col">Общежитие / дата</th>
                {dates.map((date) => (
                  <th key={date} scope="col">
                    {formatDate(date, false)}
                  </th>
                ))}
                <th scope="col">{operations[block.aggregation]}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => {
                const values = new Map(
                  result.series
                    ?.find((series) => series.dormitory_id === item.dormitory_id)
                    ?.daily.map((point) => [point.date, point.value]),
                );
                return (
                  <tr key={item.dormitory_id}>
                    <th scope="row">
                      {item.label}
                      {item.is_archived && ' (Архив)'}
                    </th>
                    {dates.map((date) => (
                      <td key={date} className={values.get(date) == null ? styles.future : ''}>
                        {formatValue(values.get(date))}
                      </td>
                    ))}
                    <td className={styles.totalCell}>{formatValue(item.value)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Все выбранные</th>
                {dates.map((date) => (
                  <td key={date}>
                    {formatValue(result.daily?.find((point) => point.date === date)?.value)}
                  </td>
                ))}
                <td>{formatValue(result.value)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className={styles.tableNote}>
          {block.query.source_kind === 'arrival_plan'
            ? '0 — заезды на эту дату не запланированы. «—» — источник недоступен или возникла ошибка расчёта.'
            : '«—» — данные отсутствуют, источник недоступен или дата ещё не наступила.'}
        </p>
      </>
    );
  if (block.display === 'pie') {
    const complete =
      result.items.length > 0 &&
      result.items.every((item) => item.value !== null && item.value >= 0);
    const total = result.items.reduce((sum, item) => sum + (item.value ?? 0), 0);
    const totalLabel = formatValue(total);
    let offset = 0;
    return (
      <div className={styles.donutWrap}>
        {complete && total > 0 ? (
          <svg viewBox="0 0 220 220" className={styles.donut} role="img" aria-label={block.name}>
            <circle cx="110" cy="110" r="77" fill="none" stroke="#edf0e9" strokeWidth="25" />
            {result.items.map((item, index) => {
              const length = (item.value! / total) * 483.8,
                current = offset;
              offset += length;
              return (
                <circle
                  key={item.dormitory_id}
                  cx="110"
                  cy="110"
                  r="77"
                  fill="none"
                  stroke={colors[index % colors.length]}
                  strokeWidth="25"
                  strokeDasharray={`${length} ${483.8 - length}`}
                  strokeDashoffset={-current}
                  transform="rotate(-90 110 110)"
                >
                  <title>
                    {item.label}: {formatValue(item.value)}
                  </title>
                </circle>
              );
            })}
            <text
              x="110"
              y="110"
              textAnchor="middle"
              className={styles.donutValue}
              textLength={totalLabel.length > 9 ? 120 : undefined}
              lengthAdjust="spacingAndGlyphs"
            >
              {totalLabel}
            </text>
            <text x="110" y="134" textAnchor="middle" className={styles.axisLabel}>
              всего
            </text>
          </svg>
        ) : (
          <p className={styles.noData}>
            {complete
              ? 'Все значения равны нулю'
              : 'Для круговой диаграммы нужны полные данные без отрицательных значений'}
          </p>
        )}
        <DormitoryValues items={result.items} />
      </div>
    );
  }
  const byDorm = block.breakdown === 'dormitory';
  const points = byDorm
    ? result.items.map((item) => ({ label: item.label, value: item.value }))
    : dates.map((date) => ({
        label: formatDate(date, false),
        value: result.daily?.find((point) => point.date === date)?.value ?? null,
      }));
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    ceiling = max + (max - min) * 0.1;
  const ticks = [0, 1, 2, 3, 4].map((tick) => min + ((ceiling - min) * tick) / 4);
  const left = Math.max(60, ...ticks.map((value) => formatValue(value).length * 7 + 18));
  const minWidth = left + (byDorm ? Math.max(1, points.length) * 140 : 250) + 30;
  const chartWidth = Math.max(viewportWidth, minWidth);
  const chartHeight = viewportWidth < 620 ? 240 : 340;
  const right = chartWidth - 30,
    top = 22,
    bottom = chartHeight - (byDorm ? 18 : 40);
  const x = (index: number): number =>
    left + ((right - left) * (index + 0.5)) / Math.max(points.length, 1);
  const y = (value: number): number => bottom - ((value - min) / (ceiling - min)) * (bottom - top);
  const segments: { x: number; y: number }[][] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (segments.at(-1)?.length) segments.push([]);
    } else {
      if (!segments.length) segments.push([]);
      segments.at(-1)!.push({ x: x(index), y: y(point.value) });
    }
  });
  return (
    <div className={styles.chartWrap}>
      <div
        ref={viewportRef}
        className={styles.chartScroll}
        role="region"
        aria-label={
          byDorm
            ? 'График по общежитиям с горизонтальной прокруткой'
            : 'График по датам с горизонтальной прокруткой'
        }
        tabIndex={0}
      >
        <div style={{ minWidth }}>
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className={styles.chart}
            style={{ height: chartHeight }}
            role="img"
            aria-label={block.name}
          >
            <title>{block.name}</title>
            {ticks.map((value, tick) => {
              return (
                <g key={tick}>
                  <line
                    x1={left}
                    x2={right}
                    y1={y(value)}
                    y2={y(value)}
                    className={styles.gridLine}
                  />
                  <text x={left - 9} y={y(value) + 4} textAnchor="end" className={styles.axisLabel}>
                    {formatValue(value)}
                  </text>
                </g>
              );
            })}
            <line x1={left} x2={right} y1={y(0)} y2={y(0)} stroke="#cbd6cc" />
            {block.display === 'bar'
              ? points.map((point, index) =>
                  point.value === null ? null : (
                    <rect
                      key={index}
                      x={x(index) - Math.min(30, ((right - left) / points.length) * 0.65) / 2}
                      y={Math.min(y(0), y(point.value))}
                      width={Math.min(30, ((right - left) / points.length) * 0.65)}
                      height={Math.max(1, Math.abs(y(0) - y(point.value)))}
                      rx="3"
                      fill={byDorm ? colors[index % colors.length] : colors[0]}
                    >
                      <title>
                        {point.label}: {formatValue(point.value)}
                      </title>
                    </rect>
                  ),
                )
              : segments
                  .filter((segment) => segment.length)
                  .map((segment, index) => {
                    const path = segment
                      .map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`)
                      .join(' ');
                    return (
                      <g key={index}>
                        {block.display === 'area' && (
                          <path
                            d={`${path} L${segment.at(-1)!.x},${y(0)} L${segment[0].x},${y(0)} Z`}
                            fill="#2f7d6220"
                          />
                        )}
                        <path d={path} fill="none" stroke={colors[0]} strokeWidth="2.5" />
                      </g>
                    );
                  })}
            {block.display !== 'bar' &&
              points.map((point, index) =>
                point.value === null ? null : (
                  <circle key={index} cx={x(index)} cy={y(point.value)} r="3" fill={colors[0]}>
                    <title>
                      {point.label}: {formatValue(point.value)}
                    </title>
                  </circle>
                ),
              )}
            {!byDorm &&
              points.map((point, index) =>
                index % Math.max(1, Math.ceil(points.length / 6)) === 0 ||
                index === points.length - 1 ? (
                  <text
                    key={index}
                    x={x(index)}
                    y={bottom + 24}
                    textAnchor="middle"
                    className={styles.axisLabel}
                  >
                    {point.label}
                  </text>
                ) : null,
              )}
          </svg>
          {byDorm && (
            <div
              className={styles.chartCategoryLabels}
              style={{
                paddingLeft: `${(left / chartWidth) * 100}%`,
                paddingRight: `${((chartWidth - right) / chartWidth) * 100}%`,
                gridTemplateColumns: `repeat(${Math.max(1, points.length)}, minmax(0, 1fr))`,
              }}
            >
              {points.map((point, index) => (
                <span key={index}>{point.label}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      {!values.length && (
        <p className={styles.chartFootnote}>За этот период нет доступных данных</p>
      )}
      <div className={styles.chartDormitories}>
        <p className={styles.valuesHeading}>По общежитиям за период</p>
        <DormitoryValues items={result.items} multicolor={byDorm && block.display === 'bar'} />
      </div>
      {!byDorm && (
        <details className={styles.valuesDetails}>
          <summary>Показать значения по датам</summary>
          <div className={styles.tableScroll}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th scope="col">Дата</th>
                  <th scope="col">Значение</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point, index) => (
                  <tr key={index}>
                    <th scope="row">{point.label}</th>
                    <td>{formatValue(point.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
