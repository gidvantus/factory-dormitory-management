import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api, ApiError } from '../../api/client';
import type { CustomTab, CustomTabRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import {
  ColumnsControls,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';
import { useColumns } from './tableColumnsContext';
import styles from './OutflowTable.module.css';
import { CreateTableDialog } from './CreateTableDialog';
import { useSettingsNavigation } from './settingsContext';
import { CustomDayCell } from './CustomDayCell';
import { PersonnelTableCells } from './PersonnelTableCells';
import { defaultTabOptions } from './customTabOptions';
import { dateNumber, formatDate, todayDate } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import optionStyles from './CustomTabOptionsEditor.module.css';

function CustomTableContent({
  dormitoryId,
  tab,
  range,
  waitForSavesRef,
}: {
  dormitoryId: string;
  tab: CustomTab;
  range: DateRange;
  waitForSavesRef?: MutableRefObject<(() => Promise<void>) | null>;
}): JSX.Element {
  const {
    loading: columnsLoading,
    error: columnsError,
    waitForRowSaves,
    personnelFields,
  } = useColumns();
  const options = { ...defaultTabOptions, ...tab.options };
  const [clearing, setClearing] = useState(false);
  const days =
    options.table_format === 'calendar'
      ? Array.from(
          { length: Math.round((dateNumber(range.to) - dateNumber(range.from)) / 86400000) + 1 },
          (_, index) =>
            new Date(dateNumber(range.from) + index * 86400000).toISOString().slice(0, 10),
        )
      : [];
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
      .customTabRows(
        dormitoryId,
        tab.id,
        controller.signal,
        options.period_mode === 'none' ? undefined : range,
      )
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
  }, [
    dormitoryId,
    tab.id,
    attempt,
    personnelFields,
    range,
    options.period_mode,
    options.date_column_id,
    options.table_format,
  ]);

  async function clear(): Promise<void> {
    if (busy || !tab.is_active) return;
    setBusy(true);
    setError('');
    try {
      await Promise.all(rows.map((row) => waitForRowSaves(row.id)));
      await api.clearCustomTab(dormitoryId, tab.id);
      setRows([]);
      setClearing(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось очистить список.');
    } finally {
      setBusy(false);
    }
  }
  async function add(): Promise<void> {
    if (busy || !tab.is_active) return;
    setBusy(true);
    setError('');
    try {
      const today = todayDate();
      const date =
        options.period_mode !== 'none' && options.table_format === 'list'
          ? today >= range.from && today <= range.to
            ? today
            : range.from
          : undefined;
      const row = await api.createCustomTabRow(dormitoryId, tab.id, date);
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
        {options.clear_list && (
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={busy || !tab.is_active || !loaded}
            onClick={() => {
              setError('');
              setClearing(true);
            }}
          >
            Очистить список
          </button>
        )}
        {options.add_row && (
          <button
            type="button"
            className={`btn btn--primary btn--compact ${optionStyles.add}`}
            aria-busy={busy}
            disabled={!tab.is_active || !loaded || columnsLoading || !!columnsError || busy}
            onClick={() => void add()}
          >
            + Добавить строку
          </button>
        )}
      </div>
      {options.table_format === 'list' && options.period_mode !== 'none' && (
        <p className={optionStyles.hint}>
          Показаны строки по выбранному столбцу даты. Строки без даты не входят в период.
        </p>
      )}
      {!tab.is_active && (
        <p role="status">
          Вкладка скрыта. Данные доступны только для просмотра и продолжают учитываться в «Общем
          отчёте». Восстановить её можно через «Управление вкладками».
        </p>
      )}
      {loading && <p role="status">Загружаем таблицу…</p>}
      {error && !deleting && !clearing && (
        <p role="alert" className={styles.error}>
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Повторить загрузку
          </button>
        </p>
      )}
      {loaded && (
        <div className={styles.tableScroll}>
          <ConfiguredTable className={styles.table} trailingColumns={days.length}>
            <thead>
              <tr>
                <ConfiguredHeaders />
                {days.map((day) => (
                  <th scope="col" key={day}>
                    {formatDate(day, false)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`custom-row-${row.id}`}>
                  <PersonnelTableCells
                    row={row}
                    readOnly={!tab.is_active}
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
                  </PersonnelTableCells>
                  {days.map((day) => (
                    <CustomDayCell
                      key={day}
                      tabId={tab.id}
                      rowId={row.id}
                      day={day}
                      initial={row.calendar_values?.[day] ?? ''}
                      readOnly={!tab.is_active}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </ConfiguredTable>
          {!rows.length && <p className={styles.empty}>В таблице пока нет записей.</p>}
        </div>
      )}
      {clearing && (
        <Modal
          title="Очистить список?"
          testId="clear-custom-tab-modal"
          onClose={() => setClearing(false)}
          closeDisabled={busy}
        >
          <p>
            Будут удалены все строки вкладки «{tab.name}» за всё время, включая значения по дням.
            Выбранный период не ограничивает очистку.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => setClearing(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn--danger btn--compact"
              disabled={busy}
              onClick={() => void clear()}
            >
              Очистить список
            </button>
          </div>
        </Modal>
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
  range,
  waitForSavesRef,
}: {
  dormitoryId: string;
  tab: CustomTab;
  onChanged: (tab: CustomTab) => void;
  range: DateRange;
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
        showActions={tab.options?.row_actions ?? true}
        showDates={tab.options?.show_dates ?? true}
      >
        <CustomTableContent
          dormitoryId={dormitoryId}
          tab={tab}
          range={range}
          waitForSavesRef={waitForSavesRef}
        />
      </TableColumnsProvider>
    );
  return (
    <section className={styles.page} data-testid="custom-tab-empty">
      <div className="toolbar">
        <h2>{tab.name}</h2>
        {(tab.options?.add_row ?? true) && (
          <button
            type="button"
            className="btn btn--primary btn--compact"
            disabled
            title="Сначала создайте таблицу"
          >
            + Добавить строку
          </button>
        )}
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
