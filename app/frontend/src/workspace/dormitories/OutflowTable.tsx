import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { OutflowField, OutflowRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { DateRange } from '../dashboard/dates';
import { IdentityDialog } from '../personnel/IdentityDialog';
import { EmployeeNameCell } from './EmployeeNameCell';
import { useColumns } from './tableColumnsContext';
import { OutflowReasonInput } from './OutflowReasonInput';
import styles from './OutflowTable.module.css';
import {
  ColumnsControls,
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';

function OutflowEntry({
  row,
  dormitoryId,
  onDelete,
}: {
  row: OutflowRow;
  dormitoryId: string;
  onDelete: (row: OutflowRow) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(row);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saved = useRef(row);
  const { trackSave, waitForRowSaves, outflowFields, reload } = useColumns();

  function change(field: OutflowField, value: string | null): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
  }

  async function save(field: OutflowField, value: string | null): Promise<boolean> {
    const key = `${row.id}:builtin:${field}`;
    if (value === saved.current[field]) {
      await trackSave(key, Promise.resolve());
      return true;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await trackSave(key, api.updateOutflowRow(dormitoryId, row.id, field, value));
      saved.current = {
        ...saved.current,
        [field]: updated[field],
        employee_id: updated.employee_id,
      };
      setDraft((current) => ({
        ...current,
        [field]: updated[field],
        employee_id: updated.employee_id,
      }));
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить строку.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  function dateField(field: 'departure_date' | 'shift_start', label: string): JSX.Element {
    return (
      <input
        type="date"
        aria-label={`${label}, строка ${row.id}`}
        value={draft[field] ?? ''}
        onChange={(event) => {
          const value = event.target.value || null;
          change(field, value);
          void save(field, value);
        }}
      />
    );
  }

  function textField(
    field: 'personnel_number' | 'reason' | 'notes' | 'additional_info',
    label: string,
  ): JSX.Element {
    const maxLength = field === 'personnel_number' ? 40 : field === 'reason' ? 255 : 5000;
    if (field === 'notes' || field === 'additional_info') {
      return (
        <textarea
          rows={2}
          aria-label={`${label}, строка ${row.id}`}
          value={draft[field] ?? ''}
          maxLength={maxLength}
          onChange={(event) => change(field, event.target.value)}
          onBlur={() => void save(field, draft[field]?.trim() || null)}
        />
      );
    }
    return (
      <input
        type="text"
        aria-label={`${label}, строка ${row.id}`}
        value={draft[field] ?? ''}
        maxLength={maxLength}
        onChange={(event) => change(field, event.target.value)}
        onBlur={() => void save(field, draft[field]?.trim() || null)}
      />
    );
  }

  return (
    <tr data-testid={`outflow-row-${row.id}`}>
      <ConfiguredCells
        row={row}
        fields={[
          'departure_date',
          'personnel_number',
          'full_name',
          'shift_start',
          'reason',
          'notes',
          'additional_info',
          'action_evict',
          'action_delete',
        ]}
      >
        <td>{dateField('departure_date', 'Дата выезда')}</td>
        <td>{textField('personnel_number', 'Т/н')}</td>
        <td>
          <EmployeeNameCell
            dormitoryId={dormitoryId}
            tableKey="outflow"
            rowId={row.id}
            employeeId={draft.employee_id}
            fields={draft}
            onChange={(name) => change('full_name', name)}
            onSave={(name) => save('full_name', name.trim() || null)}
            beforeOpen={() => waitForRowSaves(row.id)}
            onLinked={(id) => {
              saved.current = { ...saved.current, employee_id: id };
              setDraft((current) => ({ ...current, employee_id: id }));
            }}
          />
        </td>
        <td>{dateField('shift_start', 'Начало вахты')}</td>
        <td>
          {outflowFields?.reason_column?.builtin_key === 'reason' ? (
            <OutflowReasonInput
              compact
              value={draft.reason ?? ''}
              label={`Причина, строка ${row.id}`}
              choices={outflowFields.reasons}
              allowCustom
              onChange={(value) => change('reason', value)}
              disabled={saving}
              onCommit={async (value) => {
                const result = await save('reason', value || null);
                if (result) reload();
                return result;
              }}
            />
          ) : (
            textField('reason', 'Причина')
          )}
        </td>
        <td>{textField('notes', 'Примечание')}</td>
        <td>{textField('additional_info', 'Доп. информация')}</td>
        <td className={styles.actionCell}>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled
            title="Функция появится позже"
          >
            Выселение
          </button>
        </td>
        <td className={styles.actionCell}>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            aria-busy={saving}
            disabled={saving}
            onClick={() => onDelete(draft)}
          >
            Удалить
          </button>
          {(saving || error) && (
            <span role={error ? 'alert' : 'status'} className={error ? styles.error : undefined}>
              {error || 'Сохраняем…'}
            </span>
          )}
        </td>
      </ConfiguredCells>
    </tr>
  );
}

function OutflowContent({
  dormitoryId,
  range,
}: {
  dormitoryId: string;
  range: DateRange;
}): JSX.Element {
  const [rows, setRows] = useState<OutflowRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<OutflowRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .outflow(dormitoryId, range.from, range.to, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setRows(result);
          setStatus('ready');
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить отток.');
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [dormitoryId, range.from, range.to, attempt]);

  function add(): void {
    setAdding(true);
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setRemoving(true);
    setError('');
    try {
      await api.deleteOutflowRow(dormitoryId, deleting.id);
      setRows((current) => current.filter((row) => row.id !== deleting.id));
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить строку.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className={styles.page} data-testid="dormitory-outflow">
      {adding && (
        <IdentityDialog
          dormitoryId={dormitoryId}
          tableKey="outflow"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setAttempt((n) => n + 1);
          }}
        />
      )}
      <div className="toolbar">
        <h2>Отток</h2>
        <ColumnsControls />
        <button
          type="button"
          className="btn btn--primary btn--compact"
          aria-busy={adding}
          disabled={adding || status !== 'ready'}
          onClick={() => void add()}
        >
          {adding ? 'Добавляем…' : '+ Добавить строку'}
        </button>
      </div>
      {status === 'loading' && <p role="status">Загружаем отток…</p>}
      {status === 'error' && (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setStatus('loading');
              setAttempt((value) => value + 1);
            }}
          >
            Повторить
          </button>
        </p>
      )}
      {error && status === 'ready' && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {status === 'ready' && (
        <div className={styles.tableScroll}>
          <ConfiguredTable className={styles.table}>
            <thead>
              <tr>
                <ConfiguredHeaders />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <OutflowEntry
                  key={row.id}
                  row={row}
                  dormitoryId={dormitoryId}
                  onDelete={setDeleting}
                />
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
          title="Удалить строку оттока?"
          testId="delete-outflow-modal"
          onClose={() => setDeleting(null)}
          closeDisabled={removing}
        >
          <p>
            {deleting.full_name ? `Запись «${deleting.full_name}»` : 'Эта строка'} будет удалена без
            возможности восстановления.
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={removing}
              onClick={() => setDeleting(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="btn btn--danger btn--compact"
              aria-busy={removing}
              disabled={removing}
              onClick={() => void remove()}
            >
              Удалить строку
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function OutflowTable(props: { dormitoryId: string; range: DateRange }): JSX.Element {
  return (
    <TableColumnsProvider key={props.dormitoryId} dormitoryId={props.dormitoryId} table="outflow">
      <OutflowContent {...props} />
    </TableColumnsProvider>
  );
}
