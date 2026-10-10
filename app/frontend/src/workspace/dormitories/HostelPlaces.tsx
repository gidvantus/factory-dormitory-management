import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../../api/client';
import type { HostelPlaces, PlaceField } from '../../api/client';
import { Modal } from '../../components/Modal';
import { formatDate } from '../dashboard/dates';
import styles from './HostelPlaces.module.css';

interface Props {
  dormitoryId: string;
  month: string;
  onMonthChange: (month: string) => void;
}

const rows: { field: string; label: string; editable: boolean }[] = [
  { field: 'residents_m', label: 'Проживает М', editable: true },
  { field: 'residents_f', label: 'Проживает Ж', editable: true },
  { field: 'residents_total', label: 'Итого М+Ж', editable: false },
  { field: 'free_m', label: 'Свободных мест М', editable: true },
  { field: 'free_f', label: 'Свободных мест Ж', editable: true },
  { field: 'free_total', label: 'Итого М+Ж', editable: false },
  { field: 'paid_m', label: 'Оплачено мест М', editable: true },
  { field: 'paid_f', label: 'Оплачено мест Ж', editable: true },
  { field: 'paid_total', label: 'Итого М+Ж', editable: false },
];

function monthTitle(month: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}T00:00:00Z`));
}

function shiftMonth(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}

function monthDates(month: string): { from: string; to: string } {
  const [year, number] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function PlaceCell({
  label,
  date,
  value,
  onSave,
}: {
  label: string;
  date: string;
  value: number | undefined;
  onSave: (value: number | null) => Promise<void>;
}): JSX.Element {
  const initial = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const latest = useRef(initial);
  const saved = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const disposed = useRef(false);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const flush = useCallback(async function save(): Promise<void> {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const next = latest.current;
    if (next === saved.current) return;
    if (next !== '' && (!/^\d+$/.test(next) || Number(next) > 1_000_000_000)) {
      if (!disposed.current) setState('error');
      return;
    }
    inFlight.current = true;
    if (!disposed.current) setState('saving');
    try {
      await saveRef.current(next === '' ? null : Number(next));
      saved.current = next;
      if (!disposed.current) setState('idle');
    } catch {
      if (!disposed.current) setState('error');
    } finally {
      inFlight.current = false;
      if (pending.current && latest.current !== saved.current) {
        pending.current = false;
        void save();
      }
    }
  }, []);

  useEffect(() => {
    if (latest.current === saved.current) {
      latest.current = initial;
      saved.current = initial;
      setDraft(initial);
    }
  }, [initial]);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    };
  }, [flush]);

  function change(next: string): void {
    latest.current = next;
    setDraft(next);
    setState('idle');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, 650);
  }

  function blur(): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void flush();
  }

  return (
    <div className={styles.cell} data-save-state={state}>
      <input
        type="text"
        inputMode="numeric"
        aria-label={`${label}, ${formatDate(date)}`}
        value={draft}
        onChange={(event) => change(event.target.value)}
        onBlur={blur}
        title={
          state === 'error' ? 'Введите целое неотрицательное число и повторите ввод' : undefined
        }
      />
      {state === 'error' && <span title="Не удалось сохранить ячейку">!</span>}
    </div>
  );
}

function AddHostelDialog({
  dormitoryId,
  month,
  onClose,
  onCreated,
}: {
  dormitoryId: string;
  month: string;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized) {
      setError('Укажите название хостела.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createHostel(dormitoryId, normalized, month);
      onCreated();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось добавить хостел.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Добавить хостел"
      testId="add-hostel-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className={styles.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
        <p>Хостел появится за весь {monthTitle(month)} и сохранится в следующих месяцах.</p>
        <label>
          Название хостела
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={saving}
          />
        </label>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button type="submit" className="btn btn--primary" aria-busy={saving} disabled={saving}>
            Добавить хостел
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveHostelDialog({
  dormitoryId,
  hostel,
  month,
  onClose,
  onRemoved,
}: {
  dormitoryId: string;
  hostel: { id: number; name: string };
  month: string;
  onClose: () => void;
  onRemoved: () => void;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function remove(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      await api.removeHostel(dormitoryId, hostel.id, month);
      onRemoved();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось убрать хостел.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Убрать «${hostel.name}»`}
      testId="remove-hostel-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <p>
        Хостел перестанет отображаться в месяце «{monthTitle(month)}» и следующих. Данные прошлых
        месяцев сохранятся.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Отмена
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => void remove()}
          aria-busy={saving}
          disabled={saving}
        >
          Убрать хостел
        </button>
      </div>
    </Modal>
  );
}

export function HostelPlaces({ dormitoryId, month, onMonthChange }: Props): JSX.Element {
  const [data, setData] = useState<HostelPlaces>({ months: [] });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [addingMonth, setAddingMonth] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    hostel: { id: number; name: string };
    month: string;
  } | null>(null);
  const loadedRange = useRef('');
  const range = monthDates(month);
  const rangeKey = `${dormitoryId}:${range.from}:${range.to}`;
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const background = loadedRange.current === rangeKey;
    if (!background) setStatus('loading');
    void api
      .hostelPlaces(dormitoryId, range.from, range.to, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          loadedRange.current = rangeKey;
          setStatus('ready');
          setError('');
          setSaveError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          const message =
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить места.';
          if (background) setSaveError(message);
          else {
            setError(message);
            setStatus('error');
          }
        }
      });
    return () => controller.abort();
  }, [dormitoryId, range.from, range.to, rangeKey, attempt]);

  return (
    <section className={styles.page} data-testid="dormitory-places">
      <div className="toolbar">
        <div>
          <h2>Места</h2>
          <p data-testid="places-month-applied">Все дни месяца · {monthTitle(month)}</p>
        </div>
        <div className={styles.monthFilter} role="group" aria-label="Выбор месяца и года">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onMonthChange(shiftMonth(month, -1))}
            aria-label="Предыдущий месяц"
          >
            ←
          </button>
          <label>
            Месяц и год
            <input
              type="month"
              value={month}
              onChange={(event) => {
                if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value))
                  onMonthChange(event.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onMonthChange(shiftMonth(month, 1))}
            aria-label="Следующий месяц"
          >
            →
          </button>
        </div>
      </div>
      {status === 'loading' && <p role="status">Загружаем места…</p>}
      {status === 'error' && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={refresh}>
            Повторить
          </button>
        </p>
      )}
      {saveError && (
        <p role="alert" className={styles.error}>
          {saveError}
        </p>
      )}
      {status === 'ready' &&
        data.months.map((month) => (
          <section className={styles.month} key={month.month} aria-label={monthTitle(month.month)}>
            <div className={styles.monthHeading}>
              <div>
                <h3>{monthTitle(month.month)}</h3>
                <p>{month.hostels.length} хостелов</p>
              </div>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => setAddingMonth(month.month)}
              >
                + Добавить хостел
              </button>
            </div>
            {month.hostels.length === 0 && (
              <p className={styles.empty}>В этом месяце хостелов пока нет.</p>
            )}
            {month.hostels.map((hostel) => (
              <article
                className={styles.hostel}
                key={hostel.id}
                data-testid={`hostel-${hostel.id}-${month.month}`}
              >
                <div className={styles.hostelHeading}>
                  <h4>{hostel.name}</h4>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setRemoving({ hostel, month: month.month })}
                    aria-label={`Убрать хостел ${hostel.name} с ${monthTitle(month.month)}`}
                  >
                    Убрать
                  </button>
                </div>
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Наименование</th>
                        {month.days.map((day) => (
                          <th scope="col" key={day}>
                            {formatDate(day, false)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.field} className={row.editable ? undefined : styles.totalRow}>
                          <th scope="row">{row.label}</th>
                          {month.days.map((day) => (
                            <td key={day}>
                              {row.editable ? (
                                <PlaceCell
                                  key={`${hostel.id}-${row.field}-${day}`}
                                  label={`${hostel.name}, ${row.label}`}
                                  date={day}
                                  value={hostel.values[row.field]?.[day]}
                                  onSave={async (value) => {
                                    await api.saveHostelCell(
                                      dormitoryId,
                                      hostel.id,
                                      day,
                                      row.field as PlaceField,
                                      value,
                                    );
                                    setSaveError('');
                                    refresh();
                                  }}
                                />
                              ) : (
                                <output title="Сумма двух строк выше">
                                  {hostel.values[row.field]?.[day] ?? '—'}
                                </output>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </section>
        ))}
      {addingMonth && (
        <AddHostelDialog
          dormitoryId={dormitoryId}
          month={addingMonth}
          onClose={() => setAddingMonth(null)}
          onCreated={refresh}
        />
      )}
      {removing && (
        <RemoveHostelDialog
          dormitoryId={dormitoryId}
          hostel={removing.hostel}
          month={removing.month}
          onClose={() => setRemoving(null)}
          onRemoved={refresh}
        />
      )}
    </section>
  );
}
