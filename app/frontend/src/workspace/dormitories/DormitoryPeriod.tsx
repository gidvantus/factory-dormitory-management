import { useEffect, useId, useState } from 'react';
import { currentMonth, dateNumber, rangeError } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import styles from './Dormitories.module.css';

export function DormitoryPeriod({
  mode,
  range,
  onChange,
  label = 'Период общежития',
  limitToYear = true,
  resetRange,
}: {
  mode: 'range' | 'month';
  range: DateRange;
  onChange: (range: DateRange) => Promise<void> | void;
  label?: string;
  limitToYear?: boolean;
  resetRange?: DateRange;
}): JSX.Element {
  const id = useId();
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(range);
    setError('');
  }, [range]);

  async function apply(next: DateRange): Promise<void> {
    if (busy) return;
    const invalid = rangeError(next, limitToYear);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      await onChange(next);
      setDraft(next);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось изменить период.');
    } finally {
      setBusy(false);
    }
  }
  function month(value: string): DateRange {
    const [year, number] = value.split('-').map(Number);
    const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
    return { from: `${value}-01`, to: `${value}-${String(last).padStart(2, '0')}` };
  }
  function shift(offset: number): void {
    const next = new Date(dateNumber(range.from));
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + offset);
    void apply(month(next.toISOString().slice(0, 7)));
  }
  return (
    <form
      className={styles.periodForm}
      aria-label={label}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void apply(draft);
      }}
    >
      <div className={styles.periodFields}>
        {mode === 'month' ? (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              aria-label="Предыдущий месяц"
              disabled={busy}
              onClick={() => shift(-1)}
            >
              ←
            </button>
            <label className={styles.periodField} htmlFor={`${id}-month`}>
              Месяц
              <input
                id={`${id}-month`}
                data-testid="dormitory-period-month"
                type="month"
                value={range.from.slice(0, 7)}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value) void apply(month(event.target.value));
                }}
              />
            </label>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              aria-label="Следующий месяц"
              disabled={busy}
              onClick={() => shift(1)}
            >
              →
            </button>
          </>
        ) : (
          <>
            {(['from', 'to'] as const).map((key) => (
              <label key={key} className={styles.periodField} htmlFor={`${id}-${key}`}>
                {key === 'from' ? 'От' : 'До'}
                <input
                  id={`${id}-${key}`}
                  data-testid={`dormitory-period-${key}`}
                  type="date"
                  value={draft[key]}
                  disabled={busy}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((current) => ({ ...current, [key]: value }));
                    setError('');
                  }}
                />
              </label>
            ))}
            <button type="submit" className="btn btn--primary btn--compact" disabled={busy}>
              Применить
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          disabled={busy}
          onClick={() => void apply(resetRange ?? currentMonth())}
        >
          Текущий месяц
        </button>
      </div>
      {error && (
        <p className={styles.periodError} id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
