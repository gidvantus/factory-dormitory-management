import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { PaymentKind, Resident, ResidentField, ResidentsResponse } from '../../api/client';
import { Modal } from '../../components/Modal';
import { currentMonth } from '../dashboard/dates';
import styles from './ResidentsTable.module.css';
import {
  ColumnsControls,
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';
import { useTableSaves } from './tableColumnsContext';
import { TransferResidentDialog } from './TransferResidentDialog';
import { OutflowResidentDialog } from './OutflowResidentDialog';

type FieldValue = string | number | null;

function phoneValue(value: string): string {
  const digits = value.replace(/\D/g, '');
  const russian =
    digits.length === 10
      ? digits
      : /^[78]/.test(digits) && digits.length === 11
        ? digits.slice(1)
        : '';
  if (russian)
    return `+7 (${russian.slice(0, 3)}) ${russian.slice(3, 6)}-${russian.slice(6, 8)}-${russian.slice(8)}`;
  return value.trim();
}

function ResidentRow({
  resident,
  index,
  hostels,
  dormitoryId,
  month,
  onDelete,
  onTransfer,
  onOutflow,
}: {
  resident: Resident;
  index: number;
  hostels: ResidentsResponse['hostels'];
  dormitoryId: string;
  month: string;
  onDelete: (resident: Resident) => void;
  onTransfer: (resident: Resident, trigger: HTMLButtonElement) => void;
  onOutflow: (resident: Resident, trigger: HTMLButtonElement) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(resident);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const saved = useRef(resident);
  const rowLabel = `строка ${index + 1}`;
  const { trackSave, waitForRowSaves } = useTableSaves();
  const registrationInFlight = useRef(false);
  const [registering, setRegistering] = useState<PaymentKind | null>(null);
  const [preparingTransfer, setPreparingTransfer] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [outflowAction, setOutflowAction] = useState(false);
  const [paymentNotice, setPaymentNotice] = useState<{
    kind: PaymentKind;
    message: string;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!paymentNotice) return;
    const timeout = window.setTimeout(() => setPaymentNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [paymentNotice]);

  function change(field: ResidentField, value: FieldValue): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setError('');
  }

  async function save(field: ResidentField, value: FieldValue): Promise<void> {
    const key = `${resident.id}:builtin:${field}`;
    if (value === saved.current[field]) {
      await trackSave(key, Promise.resolve());
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await trackSave(
        key,
        (async () => {
          if (field === 'phone' && value && !/^\+?[0-9 ()-]+$/.test(String(value))) {
            throw new ApiError(
              422,
              'Номер телефона может содержать только цифры, +, пробелы, скобки и дефисы.',
            );
          }
          return api.updateResident(dormitoryId, resident.id, month, field, value);
        })(),
      );
      saved.current = {
        ...saved.current,
        [field]: updated[field],
        hostel_name: updated.hostel_name,
      };
      setDraft((current) => ({
        ...current,
        [field]: updated[field],
        hostel_name: updated.hostel_name,
      }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить строку.');
    } finally {
      setSaving(false);
    }
  }

  async function registerPayment(kind: PaymentKind): Promise<void> {
    if (registrationInFlight.current) return;
    registrationInFlight.current = true;
    setRegistering(kind);
    setPaymentNotice(null);
    try {
      await waitForRowSaves(resident.id);
      const result = await api.registerResidentPayment(dormitoryId, resident.id, kind);
      const destination = kind === 'advance' ? 'аванс' : 'расчёт';
      let message = result.created
        ? `Записан на ${destination}.`
        : `Уже записан на ${destination}.`;
      if (result.skipped_columns.length) {
        message += ` Не перенесены несовместимые значения: ${result.skipped_columns.join(', ')}.`;
      }
      setPaymentNotice({ kind, message, error: false });
    } catch (caught) {
      setPaymentNotice({
        kind,
        message: caught instanceof ApiError ? caught.message : 'Не удалось записать на выплату.',
        error: true,
      });
    } finally {
      registrationInFlight.current = false;
      setRegistering(null);
    }
  }

  async function openTransfer(trigger: HTMLButtonElement, outflow = false): Promise<void> {
    if (registrationInFlight.current) return;
    registrationInFlight.current = true;
    setPreparingTransfer(true);
    setOutflowAction(outflow);
    setTransferError('');
    try {
      await waitForRowSaves(resident.id);
      (outflow ? onOutflow : onTransfer)(saved.current, trigger);
    } catch (caught) {
      setTransferError(
        caught instanceof ApiError ? caught.message : 'Не удалось подготовить перенос.',
      );
    } finally {
      registrationInFlight.current = false;
      setPreparingTransfer(false);
    }
  }

  function paymentButton(kind: PaymentKind): JSX.Element {
    return (
      <>
        <button
          type="button"
          aria-label={`Записать на ${kind === 'advance' ? 'аванс' : 'расчёт'}, ${rowLabel}`}
          disabled={registering !== null || preparingTransfer}
          onClick={() => void registerPayment(kind)}
        >
          {registering === kind ? 'Записываем…' : 'Записать'}
        </button>
        {paymentNotice?.kind === kind && (
          <span role={paymentNotice.error ? 'alert' : 'status'} className={styles.paymentNotice}>
            {paymentNotice.message}
          </span>
        )}
      </>
    );
  }

  function textField(
    field: 'personnel_number' | 'full_name' | 'notes',
    label: string,
  ): JSX.Element {
    return (
      <input
        aria-label={`${label}, ${rowLabel}`}
        type="text"
        value={draft[field] ?? ''}
        maxLength={field === 'notes' ? 5000 : field === 'full_name' ? 255 : 40}
        onChange={(event) => change(field, event.target.value)}
        onBlur={() => void save(field, draft[field] || null)}
      />
    );
  }

  function dateField(field: 'shift_start' | 'shift_end', label: string): JSX.Element {
    return (
      <input
        aria-label={`${label}, ${rowLabel}`}
        type="date"
        value={draft[field] ?? ''}
        onChange={(event) => {
          const value = event.target.value || null;
          change(field, value);
          void save(field, value);
        }}
      />
    );
  }

  return (
    <tr data-testid={`resident-${resident.id}`}>
      <ConfiguredCells
        row={resident}
        fields={[
          'row_number',
          'gender',
          'personnel_number',
          'full_name',
          'hostel_id',
          'shift_start',
          'shift_count',
          'shift_end',
          'phone',
          'medical_book',
          'notes',
          'action_advance',
          'action_settlement',
          'action_transfer',
          'action_outflow',
          'action_delete',
        ]}
      >
        <th scope="row">
          {index + 1}
          {(error || saving) && (
            <span
              className={styles.rowStatus}
              role={error ? 'alert' : 'status'}
              title={error || 'Сохраняем…'}
            >
              {error ? '!' : '…'}
            </span>
          )}
        </th>
        <td>
          <select
            aria-label={`Пол, ${rowLabel}`}
            value={draft.gender ?? ''}
            onChange={(event) => {
              const value = event.target.value || null;
              change('gender', value);
              void save('gender', value);
            }}
          >
            <option value="">—</option>
            <option value="М">М</option>
            <option value="Ж">Ж</option>
          </select>
        </td>
        <td>{textField('personnel_number', 'Т/н')}</td>
        <td>{textField('full_name', 'ФИО')}</td>
        <td>
          <select
            aria-label={`Место проживания, ${rowLabel}`}
            value={draft.hostel_id ?? ''}
            onChange={(event) => {
              const value = event.target.value ? Number(event.target.value) : null;
              change('hostel_id', value);
              void save('hostel_id', value);
            }}
          >
            <option value="">Не выбрано</option>
            {draft.hostel_id && !hostels.some((hostel) => hostel.id === draft.hostel_id) && (
              <option value={draft.hostel_id}>
                {draft.hostel_name ?? 'Хостел'} (уже не действует)
              </option>
            )}
            {hostels.map((hostel) => (
              <option key={hostel.id} value={hostel.id}>
                {hostel.name}
              </option>
            ))}
          </select>
        </td>
        <td>{dateField('shift_start', 'Начало вахты')}</td>
        <td>
          <input
            aria-label={`Кол-во смен, ${rowLabel}`}
            type="number"
            min="0"
            max="1000000"
            step="1"
            value={draft.shift_count ?? ''}
            onChange={(event) =>
              change('shift_count', event.target.value === '' ? null : Number(event.target.value))
            }
            onBlur={() => void save('shift_count', draft.shift_count)}
          />
        </td>
        <td>{dateField('shift_end', 'Конец вахты')}</td>
        <td>
          <input
            aria-label={`Номер телефона, ${rowLabel}`}
            type="tel"
            inputMode="tel"
            placeholder="+7 (999) 999-99-99"
            value={draft.phone ?? ''}
            maxLength={30}
            onChange={(event) => change('phone', event.target.value)}
            onBlur={() => {
              const value = phoneValue(draft.phone ?? '') || null;
              change('phone', value);
              void save('phone', value);
            }}
          />
        </td>
        <td>
          <select
            aria-label={`ЛМК, ${rowLabel}`}
            value={draft.medical_book ?? ''}
            onChange={(event) => {
              const value = event.target.value || null;
              change('medical_book', value);
              void save('medical_book', value);
            }}
          >
            <option value="">—</option>
            <option value="Есть">Есть</option>
            <option value="Нет">Нет</option>
            <option value="Делается">Делается</option>
          </select>
        </td>
        <td>{textField('notes', 'Доп. информация')}</td>
        <td>{paymentButton('advance')}</td>
        <td>{paymentButton('settlement')}</td>
        <td>
          <button
            type="button"
            disabled={registering !== null || preparingTransfer}
            onClick={(event) => void openTransfer(event.currentTarget)}
          >
            {preparingTransfer && !outflowAction ? 'Подготавливаем…' : 'Перевести'}
          </button>
          {transferError && !outflowAction && (
            <span role="alert" className={styles.paymentNotice}>
              {transferError}
            </span>
          )}
        </td>
        <td>
          <button
            type="button"
            disabled={registering !== null || preparingTransfer}
            onClick={(event) => void openTransfer(event.currentTarget, true)}
          >
            {preparingTransfer && outflowAction ? 'Подготавливаем…' : 'Отток'}
          </button>
          {transferError && outflowAction && (
            <span role="alert" className={styles.paymentNotice}>
              {transferError}
            </span>
          )}
        </td>
        <td>
          <button
            type="button"
            className={styles.deleteButton}
            disabled={registering !== null || preparingTransfer}
            onClick={() => onDelete(draft)}
          >
            Удалить
          </button>
        </td>
      </ConfiguredCells>
    </tr>
  );
}

function ResidentsContent({ dormitoryId }: { dormitoryId: string }): JSX.Element {
  const month = currentMonth().from.slice(0, 7);
  const [data, setData] = useState<ResidentsResponse>({ residents: [], hostels: [] });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Resident | null>(null);
  const [removing, setRemoving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [transferring, setTransferring] = useState<{
    resident: Resident;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [transferNotice, setTransferNotice] = useState('');
  const [outflowing, setOutflowing] = useState<{
    resident: Resident;
    trigger: HTMLButtonElement;
  } | null>(null);

  useEffect(() => {
    if (!transferNotice) return;
    const timeout = window.setTimeout(() => setTransferNotice(''), 5000);
    return () => window.clearTimeout(timeout);
  }, [transferNotice]);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .residents(dormitoryId, month, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setStatus('ready');
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить проживающих.',
          );
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [dormitoryId, month, attempt]);

  async function add(): Promise<void> {
    setAdding(true);
    setError('');
    try {
      const resident = await api.createResident(dormitoryId);
      setData((current) => ({ ...current, residents: [...current.residents, resident] }));
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
      await api.deleteResident(dormitoryId, deleting.id);
      setData((current) => ({
        ...current,
        residents: current.residents.filter((row) => row.id !== deleting.id),
      }));
      setDeleting(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить строку.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className={styles.page} data-testid="dormitory-residents">
      <div className={styles.heading}>
        <div>
          <h2>Проживающие</h2>
          <p>Место проживания выбирается из хостелов, действующих в текущем месяце.</p>
        </div>
        <ColumnsControls />
        <button
          type="button"
          className={styles.addButton}
          disabled={adding || status !== 'ready'}
          onClick={() => void add()}
        >
          {adding ? 'Добавляем…' : '+ Добавить строку'}
        </button>
      </div>
      {status === 'loading' && <p role="status">Загружаем проживающих…</p>}
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
      {transferNotice && <p role="status">{transferNotice}</p>}
      {status === 'ready' && (
        <div className={styles.tableScroll}>
          <ConfiguredTable className={styles.table}>
            <thead>
              <tr>
                <ConfiguredHeaders />
              </tr>
            </thead>
            <tbody>
              {data.residents.map((resident, index) => (
                <ResidentRow
                  key={resident.id}
                  resident={resident}
                  index={index}
                  hostels={data.hostels}
                  dormitoryId={dormitoryId}
                  month={month}
                  onDelete={setDeleting}
                  onTransfer={(row, trigger) => setTransferring({ resident: row, trigger })}
                  onOutflow={(row, trigger) => setOutflowing({ resident: row, trigger })}
                />
              ))}
            </tbody>
          </ConfiguredTable>
          {data.residents.length === 0 && (
            <p className={styles.empty}>Здесь пока нет проживающих. Добавьте первую строку.</p>
          )}
        </div>
      )}
      {transferring && (
        <TransferResidentDialog
          dormitoryId={dormitoryId}
          resident={transferring.resident}
          trigger={transferring.trigger}
          month={month}
          onClose={() => setTransferring(null)}
          onTransferred={(residentId, destination) => {
            setData((current) => ({
              ...current,
              residents: current.residents.filter((row) => row.id !== residentId),
            }));
            setTransferring(null);
            setTransferNotice(`Проживающий переведён в общежитие «${destination.name}».`);
          }}
        />
      )}
      {outflowing && (
        <OutflowResidentDialog
          dormitoryId={dormitoryId}
          resident={outflowing.resident}
          trigger={outflowing.trigger}
          onClose={() => setOutflowing(null)}
          onMoved={(residentId) => {
            setData((current) => ({
              ...current,
              residents: current.residents.filter((row) => row.id !== residentId),
            }));
            setOutflowing(null);
            setTransferNotice(
              'Проживающий перенесён в «Отток». Его записи на аванс и расчёт удалены.',
            );
          }}
        />
      )}
      {deleting && (
        <Modal
          title="Удалить проживающего?"
          testId="delete-resident-modal"
          onClose={() => setDeleting(null)}
          closeDisabled={removing}
        >
          <p>
            Строка{' '}
            {deleting.full_name
              ? `«${deleting.full_name}»`
              : `№ ${data.residents.findIndex((row) => row.id === deleting.id) + 1}`}{' '}
            будет удалена без возможности восстановления.
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

export function ResidentsTable(props: { dormitoryId: string }): JSX.Element {
  return (
    <TableColumnsProvider key={props.dormitoryId} dormitoryId={props.dormitoryId} table="residents">
      <ResidentsContent {...props} />
    </TableColumnsProvider>
  );
}
