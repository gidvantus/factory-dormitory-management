import type { CSSProperties } from 'react';
import type { WidgetConfig, WidgetResult } from '../../api/dashboardBlocks';
import { SUMMARY_AGGREGATES } from './summaryModel';
import styles from './SummaryReport.module.css';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const compactNumber = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 2,
  useGrouping: false,
});
const format = (value: number | null): string => (value === null ? '—' : number.format(value));
const shortDate = (day: string): string => day.slice(8, 10) + '.' + day.slice(5, 7);

export function SummaryReport({
  result,
  config,
}: {
  result: WidgetResult;
  config: WidgetConfig;
}): JSX.Element {
  const data = result.summary;
  if (!data?.rows.length) return <p>Нет данных для выбранных общежитий.</p>;
  const daily = config.summary?.view === 'daily';
  const scroll = daily && data.dates.length > 31;
  const showMetrics = data.rows.some((row) => row.metric !== data.rows[0].metric);
  const groups = new Map<number, typeof data.rows>();
  for (const row of data.rows) {
    const group = groups.get(row.dormitory_id);
    if (group) group.push(row);
    else groups.set(row.dormitory_id, [row]);
  }
  const multipleMonths = data.dates[0]?.slice(0, 7) !== data.dates.at(-1)?.slice(0, 7);
  return (
    <div
      className={styles.report}
      data-testid="summary-report"
      data-scroll={scroll}
      data-metrics={showMetrics}
    >
      <div
        className={styles.scroll}
        tabIndex={scroll ? 0 : undefined}
        role={scroll ? 'region' : undefined}
        aria-label={scroll ? 'Сводный отчёт по дням, горизонтальная прокрутка' : undefined}
      >
        <table
          className={styles.table}
          style={{ '--summary-days': data.dates.length } as CSSProperties}
        >
          <caption className="visually-hidden">{config.name}</caption>
          <colgroup>
            <col className={styles.labelColumn} />
            {showMetrics && <col className={styles.metricColumn} />}
            {daily && data.dates.map((day) => <col key={day} />)}
            <col className={styles.totalColumn} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{config.summary?.label === 'client' ? 'Клиент' : 'Общежитие'}</th>
              {showMetrics && <th scope="col">Показатель</th>}
              {daily &&
                data.dates.map((day) => (
                  <th key={day} scope="col" title={shortDate(day)}>
                    <time dateTime={day}>
                      {scroll || multipleMonths ? shortDate(day) : day.slice(8, 10)}
                    </time>
                  </th>
                ))}
              <th scope="col">Итог</th>
            </tr>
          </thead>
          {Array.from(groups, ([id, rows]) => (
            <tbody key={id}>
              {rows.map((row, index) => (
                <tr key={row.metric}>
                  {index === 0 && (
                    <th
                      scope={showMetrics ? 'rowgroup' : 'row'}
                      rowSpan={rows.length}
                      className={styles.groupLabel}
                    >
                      <strong>{row.label}</strong>
                    </th>
                  )}
                  {showMetrics && <th scope="row">{row.row_name ?? row.metric}</th>}
                  {daily &&
                    row.daily.map((cell) => (
                      <td key={cell.date} title={shortDate(cell.date) + ': ' + format(cell.value)}>
                        {cell.value === null ? '—' : compactNumber.format(cell.value)}
                      </td>
                    ))}
                  <td className={styles.total} title={SUMMARY_AGGREGATES[row.aggregate]}>
                    {format(row.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {daily && !scroll && (
        <div className={styles.mobile}>
          {Array.from(groups, ([id, rows]) => (
            <section className={styles.mobileRow} key={id}>
              <strong>{rows[0].label}</strong>
              {rows.map((row) => (
                <div key={row.metric} className={styles.mobileMetric}>
                  {showMetrics && <strong>{row.row_name ?? row.metric}</strong>}
                  <dl className={styles.days}>
                    {row.daily.map((cell) => (
                      <div key={cell.date}>
                        <dt>{shortDate(cell.date)}</dt>
                        <dd>{format(cell.value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p>
                    Итог: <strong>{format(row.value)}</strong>
                  </p>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
      {daily && (
        <p className={styles.note}>
          Даты: {shortDate(data.dates[0])} — {shortDate(data.dates[data.dates.length - 1])}. «—» —
          нет значения или ошибка в источнике.
        </p>
      )}
    </div>
  );
}
