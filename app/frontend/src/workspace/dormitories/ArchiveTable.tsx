import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { ArchiveRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import { formatDate } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import { DormitoryTableFrame } from './DormitoryTableFrame';
import { tablePage, useDormitoryPages } from './useDormitoryPages';
import {
  ColumnsControls,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';
import styles from './OutflowTable.module.css';
import { PersonnelTableCells } from './PersonnelTableCells';
import { useColumns } from './tableColumnsContext';

function ArchiveContent({
  dormitoryId,
  range,
}: {
  dormitoryId: string;
  range: DateRange;
}): JSX.Element {
  const { personnelFields } = useColumns();
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState<ArchiveRow | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const pager = useDormitoryPages(
    dormitoryId,
    `${range.from}:${range.to}`,
    () => setAttempt((n) => n + 1),
    setError,
  );
  const { options: pagingOptions, setInfo } = pager;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .archive(dormitoryId, range.from, range.to, controller.signal, pagingOptions)
      .then((result) => {
        if (!controller.signal.aborted) {
          const page = tablePage(result);
          setRows(page.rows);
          setInfo({ page: page.page, total: page.total });
          setHasLoaded(true);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить архив.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, range.from, range.to, attempt, personnelFields, pagingOptions, setInfo]);
  async function add(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const row = await api.createArchiveRow(dormitoryId);
      if (pager.info.total >= 100 || pager.search || pager.options.sort) {
        if (!pager.search && !pager.options.sort)
          pager.changePage(Math.ceil((pager.info.total + 1) / 100));
        setAttempt((n) => n + 1);
      } else {
        setRows((current) => [...current, row]);
        setInfo({ page: 1, total: pager.info.total + 1 });
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось добавить запись.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteArchiveRow(dormitoryId, deleting.id);
      setRows(rows.filter((row) => row.id !== deleting.id));
      if (pager.info.total > 100) setAttempt((n) => n + 1);
      else setInfo({ page: 1, total: Math.max(0, pager.info.total - 1) });
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить запись.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <DormitoryTableFrame
      className={styles.page}
      data-testid="dormitory-archive"
      heading={<h2>Архив</h2>}
      paging={hasLoaded && { pager, loading }}
      secondary={<ColumnsControls />}
      primary={
        <button
          type="button"
          className="btn btn--primary btn--compact"
          aria-busy={busy}
          disabled={loading || busy}
          onClick={() => void add()}
        >
          + Добавить строку
        </button>
      }
    >
      <p data-testid="dormitory-period-applied">
        Записи по дате создания: {formatDate(range.from)} — {formatDate(range.to)}
      </p>
      {loading && <p role="status">Загружаем архив…</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}{' '}
          <button className="link-button" type="button" onClick={() => setAttempt((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {hasLoaded && (
        <div className={styles.tableScroll}>
          <ConfiguredTable className={styles.table} {...pager.tableProps}>
            <thead>
              <tr>
                <ConfiguredHeaders />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`archive-row-${row.id}`}>
                  <PersonnelTableCells
                    row={row}
                    onLinked={(id) =>
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, employee_id: id } : item,
                        ),
                      )
                    }
                  >
                    <td className={styles.actionCell}>
                      <button
                        type="button"
                        className="btn btn--ghost btn--compact"
                        aria-busy={busy}
                        disabled={busy}
                        onClick={() => setDeleting(row)}
                      >
                        Удалить
                      </button>
                    </td>
                  </PersonnelTableCells>
                </tr>
              ))}
            </tbody>
          </ConfiguredTable>
          {rows.length === 0 && (
            <p className={styles.empty}>За выбранный период записей пока нет.</p>
          )}
        </div>
      )}
      {deleting && (
        <Modal
          title="Удалить запись архива?"
          testId="delete-archive-modal"
          onClose={() => setDeleting(null)}
          closeDisabled={busy}
        >
          <p>Запись будет удалена вместе со значениями всех её столбцов.</p>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="btn btn--danger btn--compact"
              aria-busy={busy}
              disabled={busy}
              onClick={() => void remove()}
            >
              Удалить строку
            </button>
          </div>
        </Modal>
      )}
    </DormitoryTableFrame>
  );
}

export function ArchiveTable(props: { dormitoryId: string; range: DateRange }): JSX.Element {
  return (
    <TableColumnsProvider key={props.dormitoryId} dormitoryId={props.dormitoryId} table="archive">
      <ArchiveContent {...props} />
    </TableColumnsProvider>
  );
}
