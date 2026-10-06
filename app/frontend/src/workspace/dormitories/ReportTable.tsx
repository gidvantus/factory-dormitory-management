import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../../api/client';
import type { ReportRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import { dateNumber, formatDate } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import styles from './ReportTable.module.css';

interface Props {
  dormitoryId: string;
  range: DateRange;
}

const requiredRowNames = new Set(['Выход Итого', 'Проживает Итого', 'Текучка Итого']);

function daysInRange(range: DateRange): string[] {
  const start = dateNumber(range.from);
  const end = dateNumber(range.to);
  const day = 86_400_000;
  return Array.from({ length: Math.round((end - start) / day) + 1 }, (_, index) =>
    new Date(start + index * day).toISOString().slice(0, 10),
  );
}

function ReportCellInput({
  row,
  date,
  value,
  onSave,
  onError,
}: {
  row: ReportRow;
  date: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  onError: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const latest = useRef(value);
  const saved = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const disposed = useRef(false);
  const saveRef = useRef(onSave);
  const errorRef = useRef(onError);
  saveRef.current = onSave;
  errorRef.current = onError;

  const flush = useCallback(async function save(): Promise<void> {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    const next = latest.current;
    if (next === saved.current) return;
    inFlight.current = true;
    if (!disposed.current) setState('saving');
    try {
      await saveRef.current(next);
      saved.current = next;
      if (!disposed.current) setState('idle');
    } catch {
      if (!disposed.current) {
        setState('error');
        errorRef.current();
      }
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
      latest.current = value;
      saved.current = value;
      setDraft(value);
    }
  }, [value]);

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
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    void flush();
  }

  return (
    <div className={styles.cellEditor} data-save-state={state}>
      <input
        aria-label={`${row.name}, ${formatDate(date)}`}
        data-testid={`report-cell-${row.id}-${date}`}
        value={draft}
        onChange={(event) => change(event.target.value)}
        onBlur={blur}
        maxLength={200}
        title={
          state === 'error'
            ? 'Не удалось сохранить — измените значение или выйдите из ячейки'
            : undefined
        }
      />
      {state === 'error' && (
        <span className={styles.cellState} title="Ошибка сохранения">
          !
        </span>
      )}
    </div>
  );
}

function RowDialog({
  dormitoryId,
  row,
  rows,
  onClose,
  onChanged,
}: {
  dormitoryId: string;
  row: ReportRow | null;
  rows: ReportRow[];
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const required = row !== null && requiredRowNames.has(row.name);
  const [name, setName] = useState(row?.name ?? '');
  const [mode, setMode] = useState<'manual' | 'formula'>(
    required || row?.formula ? 'formula' : 'manual',
  );
  const [formula, setFormula] = useState(row?.formula ?? (required ? '=0' : '='));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || deleting) return;
    setSaving(true);
    setError('');
    try {
      if (row) {
        await api.updateReportRow(dormitoryId, row.id, name, mode === 'formula' ? formula : null);
      } else {
        await api.createReportRow(dormitoryId, name, mode === 'formula' ? formula : null);
      }
      onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить строку.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!row || deleting) return;
    setDeleting(true);
    setError('');
    try {
      await api.deleteReportRow(dormitoryId, row.id);
      onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить строку.');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      title={row ? 'Настроить строку' : 'Добавить строку'}
      testId="report-row-modal"
      onClose={onClose}
      closeDisabled={saving || deleting}
    >
      <form className={styles.rowForm} noValidate onSubmit={(event) => void submit(event)}>
        <label className={styles.field} htmlFor="report-row-name">
          Название строки
          <input
            id="report-row-name"
            data-testid="report-row-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
            disabled={saving || deleting || required}
            placeholder="Например, Проживающие"
          />
        </label>
        {required && (
          <p className={styles.formulaHelp}>
            Это обязательная итоговая строка. Её название и тип нельзя изменить, но формулу можно
            настроить.
          </p>
        )}
        <fieldset className={styles.modeGroup} disabled={saving || deleting}>
          <legend>Как заполняется строка</legend>
          <label>
            <input
              type="radio"
              name="report-row-mode"
              checked={mode === 'manual'}
              disabled={required}
              onChange={() => setMode('manual')}
            />{' '}
            Вручную по дням
          </label>
          <label>
            <input
              type="radio"
              name="report-row-mode"
              checked={mode === 'formula'}
              onChange={() => setMode('formula')}
            />{' '}
            Формулой для всех дней
          </label>
        </fieldset>
        {mode === 'formula' && (
          <>
            <label className={styles.field} htmlFor="report-row-formula">
              Формула
              <input
                id="report-row-formula"
                data-testid="report-row-formula"
                value={formula}
                onChange={(event) => setFormula(event.target.value)}
                maxLength={1000}
                required
                disabled={saving || deleting}
                placeholder="=[Проживающие]+[Прибывшие]"
              />
            </label>
            <p className={styles.formulaHelp}>
              Используйте названия других строк в квадратных скобках и знаки + − * /. Формула
              считает каждую дату отдельно. Пустая ячейка считается нулём.
            </p>
            {rows.filter((item) => item.id !== row?.id).length > 0 && (
              <div className={styles.references}>
                <span>Вставить строку:</span>
                {rows
                  .filter((item) => item.id !== row?.id)
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={saving || deleting}
                      onClick={() => setFormula((current) => `${current}[${item.name}]`)}
                    >
                      {item.name}
                    </button>
                  ))}
              </div>
            )}
            {row && !required && !row.formula && (
              <p className={styles.warning}>
                При переходе на формулу введённые значения этой строки будут удалены.
              </p>
            )}
          </>
        )}
        {error && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          {row &&
            !required &&
            (confirmDelete ? (
              <button
                type="button"
                className={styles.deleteConfirm}
                onClick={() => void remove()}
                disabled={saving || deleting}
              >
                Подтвердить удаление
              </button>
            ) : (
              <button
                type="button"
                className={styles.deleteButton}
                onClick={() => setConfirmDelete(true)}
                disabled={saving || deleting}
              >
                Удалить строку
              </button>
            ))}
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onClose}
            disabled={saving || deleting}
          >
            Отмена
          </button>
          <button type="submit" className={styles.saveButton} disabled={saving || deleting}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SaveTemplateDialog({
  dormitoryId,
  rowCount,
  onClose,
  onSaved,
}: {
  dormitoryId: string;
  rowCount: number;
  onClose: () => void;
  onSaved: (name: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      setError('Укажите название шаблона.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const template = await api.saveReportTemplate(dormitoryId, normalized);
      onSaved(template.name);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить шаблон.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Сохранить шаблон отчёта"
      testId="save-report-template-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className={styles.rowForm} noValidate onSubmit={(event) => void submit(event)}>
        <p className={styles.formulaHelp}>
          Сохранятся {rowCount} строк: названия, порядок и формулы. Значения ячеек в шаблон не
          попадут.
        </p>
        <label className={styles.field} htmlFor="report-template-name">
          Название шаблона
          <input
            id="report-template-name"
            data-testid="report-template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={saving}
            placeholder="Например, Стандартный отчёт"
          />
        </label>
        {error && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button type="submit" className={styles.saveButton} disabled={saving}>
            {saving ? 'Сохраняем…' : 'Сохранить шаблон'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ReportTable({ dormitoryId, range }: Props): JSX.Element {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [moveError, setMoveError] = useState('');
  const [movingRow, setMovingRow] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<ReportRow | null | 'new'>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateNotice, setTemplateNotice] = useState('');
  const loadedRange = useRef('');
  const rangeKey = `${dormitoryId}:${range.from}:${range.to}`;

  useEffect(() => {
    const controller = new AbortController();
    const background = loadedRange.current === rangeKey;
    if (!background) setStatus('loading');
    void api
      .report(dormitoryId, range.from, range.to, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setRows(report.rows);
          loadedRange.current = rangeKey;
          setError('');
          setStatus('ready');
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить отчёт.');
          if (!background) setStatus('error');
        }
      });
    return () => controller.abort();
  }, [dormitoryId, range.from, range.to, rangeKey, attempt]);

  const refresh = useCallback(() => setAttempt((current) => current + 1), []);
  const days = daysInRange(range);

  async function moveRow(rowId: number, direction: 'up' | 'down'): Promise<void> {
    if (movingRow !== null) return;
    setMovingRow(rowId);
    setMoveError('');
    try {
      await api.moveReportRow(dormitoryId, rowId, direction);
      refresh();
    } catch (caught) {
      setMoveError(
        caught instanceof ApiError ? caught.message : 'Не удалось изменить порядок строк.',
      );
    } finally {
      setMovingRow(null);
    }
  }

  return (
    <section
      className={styles.report}
      aria-labelledby="report-title"
      data-testid="dormitory-report"
    >
      <div className={styles.reportHeading}>
        <div>
          <h2 id="report-title">Большой отчёт</h2>
          <p data-testid="dormitory-period-applied">
            Период: {formatDate(range.from)} — {formatDate(range.to)}
          </p>
          <p>
            Строки настраиваются отдельно для каждого общежития. Обычные ячейки сохраняются
            автоматически.
          </p>
        </div>
        <div className={styles.headingActions}>
          <button
            className={styles.templateButton}
            type="button"
            onClick={() => setTemplateDialogOpen(true)}
            disabled={status !== 'ready' || rows.length === 0}
            data-testid="report-save-template"
          >
            Сохранить как шаблон
          </button>
          <button
            className={styles.addButton}
            type="button"
            onClick={() => setEditing('new')}
            data-testid="report-add-row"
          >
            + Добавить строку
          </button>
        </div>
      </div>
      {templateNotice && (
        <p className={styles.templateNotice} role="status">
          Шаблон «{templateNotice}» сохранён. Его можно выбрать при создании общежития.
        </p>
      )}
      {saveError && (
        <p className={styles.saveError} role="alert">
          {saveError} Проверьте соединение и повторите ввод.
        </p>
      )}
      {moveError && (
        <p className={styles.saveError} role="alert">
          {moveError}
        </p>
      )}
      {status === 'ready' && error && (
        <p className={styles.saveError} role="alert">
          {error}{' '}
          <button type="button" onClick={refresh}>
            Повторить
          </button>
        </p>
      )}
      {status === 'loading' && (
        <p className={styles.status} role="status">
          Загружаем отчёт…
        </p>
      )}
      {status === 'error' && (
        <div className={styles.loadError} role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh}>
            Повторить
          </button>
        </div>
      )}
      {status === 'ready' && rows.length === 0 && (
        <div className={styles.empty}>
          <strong>Пока нет строк отчёта</strong>
          <p>Добавьте строку, дайте ей название и выберите ручной ввод или формулу.</p>
        </div>
      )}
      {status === 'ready' && rows.length > 0 && (
        <div className={styles.tableFrame}>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Наименование</th>
                  {days.map((day) => (
                    <th scope="col" key={day}>
                      {formatDate(day, false)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <div className={styles.rowName}>
                        <button
                          type="button"
                          onClick={() => setEditing(row)}
                          aria-label={`Настроить строку ${row.name}`}
                          data-testid={`report-edit-row-${row.id}`}
                        >
                          {row.name}
                        </button>
                        {row.formula && (
                          <span className={styles.formulaBadge} title={row.formula}>
                            ƒ
                          </span>
                        )}
                        <span className={styles.rowMove}>
                          <button
                            type="button"
                            aria-label={`Переместить строку ${row.name} вверх`}
                            title="Переместить вверх"
                            disabled={index === 0 || movingRow !== null}
                            onClick={() => void moveRow(row.id, 'up')}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Переместить строку ${row.name} вниз`}
                            title="Переместить вниз"
                            disabled={index === rows.length - 1 || movingRow !== null}
                            onClick={() => void moveRow(row.id, 'down')}
                          >
                            ↓
                          </button>
                        </span>
                      </div>
                    </th>
                    {days.map((day) => (
                      <td key={day}>
                        {row.formula ? (
                          <output
                            className={row.errors[day] ? styles.formulaError : styles.formulaValue}
                            title={row.errors[day] || row.formula}
                          >
                            {row.errors[day] ? 'Ошибка' : (row.values[day] ?? '—')}
                          </output>
                        ) : (
                          <ReportCellInput
                            key={`${row.id}-${day}`}
                            row={row}
                            date={day}
                            value={row.values[day] ?? ''}
                            onSave={async (value) => {
                              await api.saveReportCell(dormitoryId, row.id, day, value);
                              setSaveError('');
                              refresh();
                            }}
                            onError={() => setSaveError('Не удалось сохранить ячейку.')}
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.tableFooter}>
            <span>
              {rows.length} строк · {days.length} дат
            </span>
            <span>Формула автоматически рассчитывается для каждой даты</span>
          </div>
        </div>
      )}
      {editing && (
        <RowDialog
          dormitoryId={dormitoryId}
          row={editing === 'new' ? null : editing}
          rows={rows}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
      {templateDialogOpen && (
        <SaveTemplateDialog
          dormitoryId={dormitoryId}
          rowCount={rows.length}
          onClose={() => setTemplateDialogOpen(false)}
          onSaved={setTemplateNotice}
        />
      )}
    </section>
  );
}
