import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { CellValue, CustomTab } from '../../api/client';
import { WorkingTable } from '../../components/WorkingTable';
import type { DateRange } from '../dashboard/dates';
import { formatDate } from '../dashboard/dates';
import { ColumnsControls } from './ConfigurableColumns';
import { useColumns } from './tableColumnsContext';
import { DormitoryTableFrame } from './DormitoryTableFrame';
import styles from './OutflowTable.module.css';

type ArrivalRow = { id: string; date: string; custom_values: Record<string, CellValue> };
function display(value: CellValue | undefined, kind: string): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (kind === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return formatDate(value);
  return String(value);
}

export function DormitoryArrivalTable({
  dormitoryId,
  tab,
  range,
}: {
  dormitoryId: string;
  tab: CustomTab;
  range: DateRange;
}): JSX.Element {
  const { columns, loading: columnsLoading, error: columnsError } = useColumns();
  const visible = columns.filter((column) => !column.archived && column.kind !== 'action');
  const [rows, setRows] = useState<ArrivalRow[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mapping = JSON.stringify(tab.options?.arrival_columns ?? {});
  const withPeriod = tab.options?.period_mode !== 'none';
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    setRows(null);
    setError('');
    const refresh = (): void => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      setRefreshing(true);
      void api
        .dormitoryArrivalRows(
          dormitoryId,
          tab.id,
          controller.signal,
          withPeriod ? { from: range.from, to: range.to } : undefined,
        )
        .then((items) => {
          if (!controller.signal.aborted) {
            setRows(items);
            setError('');
          }
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted)
            setError(
              caught instanceof ApiError ? caught.message : 'Не удалось обновить план заездов.',
            );
        })
        .finally(() => {
          pending = false;
          if (!controller.signal.aborted) setRefreshing(false);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [dormitoryId, tab.id, range.from, range.to, withPeriod, mapping, attempt]);
  return (
    <DormitoryTableFrame
      className={styles.page}
      data-testid="dormitory-arrival-table"
      heading={<h2>{tab.name}</h2>}
      secondary={tab.is_active && <ColumnsControls />}
      primary={
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          disabled={refreshing}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Обновить
        </button>
      }
    >
      <p>
        Данные из «Персонал → План заездов» обновляются автоматически. ФИО, дату и статус меняют в
        плане заездов.
      </p>
      {columnsError && <p role="alert">{columnsError}</p>}
      {error && (
        <p role="alert">
          {error}
          {rows && ' Показаны ранее загруженные данные.'}
        </p>
      )}
      {(columnsLoading || (rows === null && !error)) && (
        <p role="status">Загружаем план заездов…</p>
      )}
      {!columnsLoading && rows !== null && !columnsError && (
        <div className={styles.tableScroll}>
          <WorkingTable
            className={styles.table}
            aria-label={tab.name}
            viewKey={`dormitories/${dormitoryId}/table-views/${tab.table_key}`}
            readOnly={!tab.is_active}
            columns={visible.map((column) => ({
              id: String(column.id),
              label: column.name,
              kind: column.kind,
              compact: tab.options?.arrival_columns?.[String(column.id)] === 'status',
            }))}
          >
            <thead>
              <tr>
                {visible.map((column) => (
                  <th scope="col" key={column.id}>
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {visible.map((column) => (
                    <td
                      key={column.id}
                      data-sort-value={
                        row.custom_values[String(column.id)] == null
                          ? ''
                          : String(row.custom_values[String(column.id)])
                      }
                    >
                      {display(row.custom_values[String(column.id)], column.kind)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </WorkingTable>
          {!rows.length && <p>За выбранный период заездов нет.</p>}
        </div>
      )}
    </DormitoryTableFrame>
  );
}
