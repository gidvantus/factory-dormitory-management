import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { ArchiveRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import { formatDate } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import {
  ColumnsControls,
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';
import styles from './OutflowTable.module.css';

function ArchiveContent({
  dormitoryId,
  range,
}: {
  dormitoryId: string;
  range: DateRange;
}): JSX.Element {
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState<ArchiveRow | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .archive(dormitoryId, range.from, range.to, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setRows(result);
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
  }, [dormitoryId, range.from, range.to, attempt]);
  async function add(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const row = await api.createArchiveRow(dormitoryId);
      setRows((current) => [...current, row]);
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
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить запись.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.page} data-testid="dormitory-archive">
      <div className={styles.heading}>
        <h2>Архив</h2>
        <ColumnsControls />
        <button
          type="button"
          className={styles.addButton}
          disabled={loading || busy}
          onClick={() => void add()}
        >
          + Добавить строку
        </button>
      </div>
      <p data-testid="dormitory-period-applied">
        Записи по дате создания: {formatDate(range.from)} — {formatDate(range.to)}
      </p>
      {loading && <p role="status">Загружаем архив…</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {!loading && (
        <div className={styles.tableScroll}>
          <ConfiguredTable className={styles.table}>
            <thead>
              <tr>
                <ConfiguredHeaders />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <ConfiguredCells row={row} fields={['action_delete']}>
                    <td className={styles.actionCell}>
                      <button type="button" disabled={busy} onClick={() => setDeleting(row)}>
                        Удалить
                      </button>
                    </td>
                  </ConfiguredCells>
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
          <div className={styles.modalActions}>
            <button type="button" disabled={busy} onClick={() => setDeleting(null)}>
              Отмена
            </button>
            <button type="button" disabled={busy} onClick={() => void remove()}>
              Удалить строку
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ArchiveTable(props: { dormitoryId: string; range: DateRange }): JSX.Element {
  return (
    <TableColumnsProvider key={props.dormitoryId} dormitoryId={props.dormitoryId} table="archive">
      <ArchiveContent {...props} />
    </TableColumnsProvider>
  );
}
