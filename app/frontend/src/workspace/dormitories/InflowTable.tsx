import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { InflowField, InflowRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { DateRange } from '../dashboard/dates';
import styles from './InflowTable.module.css';

type FieldValue = string | number | null;

function InflowEntry({
  row,
  dormitoryId,
  onDelete,
}: {
  row: InflowRow;
  dormitoryId: string;
  onDelete: (row: InflowRow) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(row);
  const [shiftCountText, setShiftCountText] = useState(row.shift_count?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saved = useRef(row);

  function change(field: InflowField, value: FieldValue): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
  }

  async function save(field: InflowField, value: FieldValue): Promise<void> {
    if (value === saved.current[field]) return;
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateInflowRow(dormitoryId, row.id, field, value);
      saved.current = { ...saved.current, [field]: updated[field] };
      setDraft((current) => ({ ...current, [field]: updated[field] }));
      if (field === 'shift_count') setShiftCountText(updated.shift_count?.toString() ?? '');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить строку.');
    } finally {
      setSaving(false);
    }
  }

  function textField(
    field: 'personnel_number' | 'full_name' | 'citizenship' | 'notes',
    label: string,
  ): JSX.Element {
    const maxLength = { personnel_number: 40, full_name: 255, citizenship: 120, notes: 5000 }[
      field
    ];
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
    <tr data-testid={`inflow-row-${row.id}`}>
      <td>
        <input
          type="date"
          aria-label={`Дата заселения, строка ${row.id}`}
          value={draft.settlement_date ?? ''}
          onChange={(event) => {
            const value = event.target.value || null;
            change('settlement_date', value);
            void save('settlement_date', value);
          }}
        />
      </td>
      <td>{textField('personnel_number', 'Т/н')}</td>
      <td>{textField('full_name', 'ФИО')}</td>
      <td>{textField('citizenship', 'Гражданство')}</td>
      <td>{textField('notes', 'Примечание')}</td>
      <td>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className={styles.numeric}
          aria-label={`Кол-во смен, строка ${row.id}`}
          value={shiftCountText}
          onChange={(event) => {
            if (/^\d*$/.test(event.target.value)) {
              setShiftCountText(event.target.value);
              setError('');
            }
          }}
          onBlur={() => {
            if (shiftCountText !== '' && Number(shiftCountText) > 1_000_000) {
              setError('Количество смен должно быть не больше 1 000 000.');
              return;
            }
            void save('shift_count', shiftCountText === '' ? null : Number(shiftCountText));
          }}
        />
      </td>
      <td className={styles.actionCell}>
        <button type="button" disabled={saving} onClick={() => onDelete(draft)}>
          Удалить
        </button>
        {(saving || error) && (
          <span role={error ? 'alert' : 'status'} className={error ? styles.error : undefined}>
            {error || 'Сохраняем…'}
          </span>
        )}
      </td>
    </tr>
  );
}

export function InflowTable({
  dormitoryId,
  range,
}: {
  dormitoryId: string;
  range: DateRange;
}): JSX.Element {
  const [rows, setRows] = useState<InflowRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<InflowRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .inflow(dormitoryId, range.from, range.to, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setRows(result);
          setStatus('ready');
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить приток.');
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [dormitoryId, range.from, range.to, attempt]);

  async function add(): Promise<void> {
    setAdding(true);
    setError('');
    try {
      const row = await api.createInflowRow(dormitoryId);
      setRows((current) => [...current, row]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось добавить строку.');
    } finally {
      setAdding(false);
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setRemoving(true);
    setError('');
    try {
      await api.deleteInflowRow(dormitoryId, deleting.id);
      setRows((current) => current.filter((row) => row.id !== deleting.id));
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить строку.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className={styles.page} data-testid="dormitory-inflow">
      <div className={styles.heading}>
        <h2>Приток</h2>
        <button
          type="button"
          className={styles.addButton}
          disabled={adding || status !== 'ready'}
          onClick={() => void add()}
        >
          {adding ? 'Добавляем…' : '+ Добавить строку'}
        </button>
      </div>
      {status === 'loading' && <p role="status">Загружаем приток…</p>}
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
          <table className={styles.table}>
            <thead>
              <tr>
                {[
                  'Дата заселения',
                  'Т/н',
                  'ФИО',
                  'Гражданство',
                  'Примечание',
                  'Кол-во смен',
                  'Удалить',
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <InflowEntry
                  key={row.id}
                  row={row}
                  dormitoryId={dormitoryId}
                  onDelete={setDeleting}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className={styles.empty}>За выбранный период записей пока нет.</p>
          )}
        </div>
      )}
      {deleting && (
        <Modal
          title="Удалить строку притока?"
          testId="delete-inflow-modal"
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
          <div className={styles.modalActions}>
            <button type="button" disabled={removing} onClick={() => setDeleting(null)}>
              Отмена
            </button>
            <button
              type="button"
              className={styles.deleteButton}
              disabled={removing}
              onClick={() => void remove()}
            >
              {removing ? 'Удаляем…' : 'Удалить строку'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
