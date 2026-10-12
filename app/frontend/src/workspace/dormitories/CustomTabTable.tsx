import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api, ApiError } from '../../api/client';
import type { CustomTab, CustomTabRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import {
  ColumnsControls,
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';
import { useColumns } from './tableColumnsContext';
import styles from './OutflowTable.module.css';
import { CreateTableDialog } from './CreateTableDialog';
import { useSettingsNavigation } from './settingsContext';
import { PersonnelLink } from '../personnel/IdentityDialog';
import { PersonnelBindingButton } from '../personnel/BindingDialog';

function CustomTableContent({
  dormitoryId,
  tab,
  waitForSavesRef,
}: {
  dormitoryId: string;
  tab: CustomTab;
  waitForSavesRef?: MutableRefObject<(() => Promise<void>) | null>;
}): JSX.Element {
  const { loading: columnsLoading, error: columnsError, waitForRowSaves } = useColumns();
  const [rows, setRows] = useState<CustomTabRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState<CustomTabRow | null>(null);
  useEffect(() => {
    if (!waitForSavesRef) return;
    waitForSavesRef.current = async () => {
      if (busy) throw new ApiError(409, 'Дождитесь завершения операции с таблицей.');
      await Promise.all(rows.map((row) => waitForRowSaves(row.id)));
    };
    return () => {
      waitForSavesRef.current = null;
    };
  }, [waitForSavesRef, busy, rows, waitForRowSaves]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoaded(false);
    setError('');
    void api
      .customTabRows(dormitoryId, tab.id, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setRows(items);
          setLoaded(true);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить таблицу.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, tab.id, attempt]);

  async function add(): Promise<void> {
    if (busy || !tab.is_active) return;
    setBusy(true);
    setError('');
    try {
      const row = await api.createCustomTabRow(dormitoryId, tab.id);
      setRows((current) => [...current, row]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось добавить строку.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(): Promise<void> {
    if (!deleting || busy || !tab.is_active) return;
    setBusy(true);
    setError('');
    try {
      await waitForRowSaves(deleting.id);
      await api.deleteCustomTabRow(dormitoryId, tab.id, deleting.id);
      setRows((current) => current.filter((row) => row.id !== deleting.id));
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить запись.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.page} data-testid="custom-tab-table">
      <div className="toolbar">
        <h2>{tab.name}</h2>
        {tab.is_active && <ColumnsControls />}
        {tab.is_active && (
          <PersonnelBindingButton
            dormitoryId={dormitoryId}
            tableKey={`custom_${tab.id}`}
            onSaved={() => setAttempt((n) => n + 1)}
          />
        )}
        <button
          type="button"
          className="btn btn--primary btn--compact"
          aria-busy={busy}
          disabled={!tab.is_active || !loaded || columnsLoading || !!columnsError || busy}
          onClick={() => void add()}
        >
          + Добавить строку
        </button>
      </div>
      {!tab.is_active && (
        <p role="status">
          Вкладка скрыта. Данные доступны только для просмотра и продолжают учитываться в «Большом
          отчёте». Восстановить её можно через «Управление вкладками».
        </p>
      )}
      {loading && <p role="status">Загружаем таблицу…</p>}
      {error && !deleting && (
        <p role="alert" className={styles.error}>
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Повторить загрузку
          </button>
        </p>
      )}
      {loaded && (
        <div className={styles.tableScroll}>
          <ConfiguredTable className={styles.table}>
            <thead>
              <tr>
                <ConfiguredHeaders />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`custom-row-${row.id}`}>
                  <ConfiguredCells row={row} fields={['action_delete']} readOnly={!tab.is_active}>
                    <td className={styles.actionCell}>
                      {tab.is_active && (
                        <PersonnelLink
                          dormitoryId={dormitoryId}
                          tableKey={`custom_${tab.id}`}
                          rowId={row.id}
                          employeeId={row.employee_id}
                          beforeOpen={() => waitForRowSaves(row.id)}
                          onChanged={() => setAttempt((n) => n + 1)}
                        />
                      )}
                      <button
                        type="button"
                        disabled={busy || !tab.is_active}
                        className="btn btn--ghost btn--compact"
                        aria-busy={busy}
                        onClick={() => {
                          setError('');
                          setDeleting(row);
                        }}
                      >
                        Удалить
                      </button>
                    </td>
                  </ConfiguredCells>
                </tr>
              ))}
            </tbody>
          </ConfiguredTable>
          {!rows.length && <p className={styles.empty}>В таблице пока нет записей.</p>}
        </div>
      )}
      {deleting && (
        <Modal
          title="Удалить запись?"
          testId="delete-custom-row-modal"
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
              disabled={busy}
              className="btn btn--danger btn--compact"
              aria-busy={busy}
              onClick={() => void remove()}
            >
              Удалить
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function CustomTabTable({
  dormitoryId,
  tab,
  onChanged,
  waitForSavesRef,
}: {
  dormitoryId: string;
  tab: CustomTab;
  onChanged: (tab: CustomTab) => void;
  waitForSavesRef?: MutableRefObject<(() => Promise<void>) | null>;
}): JSX.Element {
  const [creating, setCreating] = useState(false);
  const settings = useSettingsNavigation();
  if (tab.table_created)
    return (
      <TableColumnsProvider
        key={`${dormitoryId}:${tab.id}`}
        dormitoryId={dormitoryId}
        table={tab.table_key}
      >
        <CustomTableContent dormitoryId={dormitoryId} tab={tab} waitForSavesRef={waitForSavesRef} />
      </TableColumnsProvider>
    );
  return (
    <section className={styles.page} data-testid="custom-tab-empty">
      <div className="toolbar">
        <h2>{tab.name}</h2>
        <button
          type="button"
          className="btn btn--primary btn--compact"
          disabled
          title="Сначала создайте таблицу"
        >
          + Добавить строку
        </button>
      </div>
      <p>Во вкладке пока нет таблицы. Создайте её и настройте столбцы, чтобы добавлять записи.</p>
      <div>
        <button
          type="button"
          className="btn btn--primary btn--compact"
          disabled={!tab.is_active}
          onClick={() => (settings ? settings.open(tab.table_key) : setCreating(true))}
        >
          Создать таблицу
        </button>
      </div>
      {!tab.is_active && (
        <p>Вкладка скрыта. Для создания таблицы восстановите её через «Управление вкладками».</p>
      )}
      {creating && tab.is_active && (
        <CreateTableDialog
          dormitoryId={dormitoryId}
          tab={tab}
          onClose={() => setCreating(false)}
          onCreated={onChanged}
        />
      )}
    </section>
  );
}
