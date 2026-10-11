import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { PaymentField, PaymentKind, PaymentRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { DateRange } from '../dashboard/dates';
import styles from './PaymentsTable.module.css';
import {
  ColumnsControls,
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';

function PaymentEntry({
  row,
  kind,
  dormitoryId,
  onDelete,
}: {
  row: PaymentRow;
  kind: PaymentKind;
  dormitoryId: string;
  onDelete: (row: PaymentRow) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(row);
  const [amountText, setAmountText] = useState(row.advance_amount ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saved = useRef(row);

  function change(field: PaymentField, value: string | null): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
  }

  async function save(field: PaymentField, value: string | null): Promise<void> {
    if (value === saved.current[field]) return;
    setSaving(true);
    setError('');
    try {
      const updated = await api.updatePaymentRow(dormitoryId, kind, row.id, field, value);
      saved.current = { ...saved.current, [field]: updated[field] };
      setDraft((current) => ({ ...current, [field]: updated[field] }));
      if (field === 'advance_amount') setAmountText(updated.advance_amount ?? '');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить строку.');
    } finally {
      setSaving(false);
    }
  }

  function textField(field: 'personnel_number' | 'full_name', label: string): JSX.Element {
    return (
      <input
        type="text"
        aria-label={`${label}, строка ${row.id}`}
        value={draft[field] ?? ''}
        maxLength={field === 'personnel_number' ? 40 : 255}
        onChange={(event) => change(field, event.target.value)}
        onBlur={() => void save(field, draft[field]?.trim() || null)}
      />
    );
  }

  return (
    <tr data-testid={`${kind}-row-${row.id}`}>
      <ConfiguredCells
        row={row}
        fields={[
          'personnel_number',
          'full_name',
          kind === 'advance' ? 'advance_amount' : 'settlement_date',
          'action_delete',
        ]}
      >
        <td>{textField('personnel_number', 'Т/н')}</td>
        <td>{textField('full_name', 'ФИО')}</td>
        <td>
          {kind === 'advance' ? (
            <input
              type="text"
              inputMode="decimal"
              aria-label={`Сумма аванса, строка ${row.id}`}
              value={amountText}
              onChange={(event) => {
                if (/^\d{0,10}(?:[.,]\d{0,2})?$/.test(event.target.value)) {
                  setAmountText(event.target.value);
                  setError('');
                }
              }}
              onBlur={() => {
                if (amountText !== '' && !/^\d{1,10}(?:[.,]\d{1,2})?$/.test(amountText)) {
                  setError('Укажите сумму в рублях и копейках.');
                  return;
                }
                void save(
                  'advance_amount',
                  amountText === '' ? null : amountText.replace(',', '.'),
                );
              }}
            />
          ) : (
            <input
              type="date"
              aria-label={`Дата расчёта, строка ${row.id}`}
              value={draft.settlement_date ?? ''}
              onChange={(event) => {
                const value = event.target.value || null;
                change('settlement_date', value);
                void save('settlement_date', value);
              }}
            />
          )}
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
      </ConfiguredCells>
    </tr>
  );
}

function PaymentsContent({
  dormitoryId,
  kind,
  range,
}: {
  dormitoryId: string;
  kind: PaymentKind;
  range: DateRange;
}): JSX.Element {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<PaymentRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const from = kind === 'settlement' ? range.from : '';
  const to = kind === 'settlement' ? range.to : '';
  const title = kind === 'advance' ? 'На аванс' : 'На расчёт';

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .payments(dormitoryId, kind, from, to, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setRows(result);
          setStatus('ready');
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить выплаты.');
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [dormitoryId, kind, from, to, attempt]);

  async function add(): Promise<void> {
    setAdding(true);
    setError('');
    try {
      const row = await api.createPaymentRow(dormitoryId, kind);
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
      await api.deletePaymentRow(dormitoryId, kind, deleting.id);
      setRows((current) => current.filter((row) => row.id !== deleting.id));
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить строку.');
    } finally {
      setRemoving(false);
    }
  }

  async function clear(): Promise<void> {
    setClearing(true);
    setError('');
    try {
      await api.clearPaymentRows(dormitoryId, kind);
      setRows([]);
      setConfirmClear(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось очистить список.');
    } finally {
      setClearing(false);
    }
  }

  return (
    <section className={styles.page} data-testid={`dormitory-payments-${kind}`}>
      <div className={styles.heading}>
        <h2>{title}</h2>
        <ColumnsControls />
        <button
          type="button"
          className={styles.addButton}
          disabled={adding || clearing || status !== 'ready'}
          onClick={() => void add()}
        >
          {adding ? 'Добавляем…' : '+ Добавить строку'}
        </button>
        <button
          type="button"
          className={styles.clearButton}
          disabled={adding || removing || clearing || status !== 'ready'}
          onClick={() => {
            setError('');
            setConfirmClear(true);
          }}
        >
          {clearing ? 'Очищаем…' : 'Очистить список'}
        </button>
      </div>
      {status === 'loading' && <p role="status">Загружаем список…</p>}
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
                <PaymentEntry
                  key={row.id}
                  row={row}
                  kind={kind}
                  dormitoryId={dormitoryId}
                  onDelete={setDeleting}
                />
              ))}
            </tbody>
          </ConfiguredTable>
          {rows.length === 0 && <p className={styles.empty}>В списке пока нет записей.</p>}
        </div>
      )}
      {confirmClear && (
        <Modal
          title={`Очистить список «${title}»?`}
          testId="clear-payments-modal"
          onClose={() => setConfirmClear(false)}
          closeDisabled={clearing}
        >
          <p>
            Все строки списка «{title}» в текущем общежитии будут удалены, включая записи вне
            выбранного периода. Восстановить удалённые строки будет невозможно.
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.modalActions}>
            <button type="button" disabled={clearing} onClick={() => setConfirmClear(false)}>
              Отмена
            </button>
            <button
              type="button"
              className={styles.deleteButton}
              disabled={clearing}
              onClick={() => void clear()}
            >
              {clearing ? 'Очищаем…' : 'Удалить все строки'}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Удалить строку выплаты?"
          testId="delete-payment-modal"
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

export function PaymentsTable(props: {
  dormitoryId: string;
  kind: PaymentKind;
  range: DateRange;
}): JSX.Element {
  return (
    <TableColumnsProvider
      key={`${props.dormitoryId}:${props.kind}`}
      dormitoryId={props.dormitoryId}
      table={props.kind}
    >
      <PaymentsContent {...props} />
    </TableColumnsProvider>
  );
}
