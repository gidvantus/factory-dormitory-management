import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { FormEvent, ReactNode } from 'react';

import { api, ApiError } from '../../api/client';
import type {
  CellValue,
  ColumnInput,
  ColumnKind,
  ColumnOption,
  TableColumn,
  TableKey,
} from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './ConfigurableColumns.module.css';
import { ColumnsContext, useColumns } from './tableColumnsContext';
import type { ColumnsDialog, TableColumnsContext } from './tableColumnsContext';
import { columnKinds as kinds } from './columnKinds';
import { useSettingsNavigation } from './settingsContext';

export function TableColumnsProvider({
  dormitoryId,
  table,
  children,
}: {
  dormitoryId: string;
  table: TableKey;
  children: ReactNode;
}): JSX.Element {
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const settings = useSettingsNavigation();
  const revision = settings?.revision;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<ColumnsDialog>(null);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const pendingSaves = useRef(new Map<Promise<unknown>, string>());
  const failedSaves = useRef(new Set<string>());

  function trackSave<T>(key: string, promise: Promise<T>): Promise<T> {
    const tracked = promise
      .then(
        (result) => {
          failedSaves.current.delete(key);
          return result;
        },
        (caught: unknown) => {
          failedSaves.current.add(key);
          throw caught;
        },
      )
      .finally(() => {
        pendingSaves.current.delete(tracked);
      });
    pendingSaves.current.set(tracked, key);
    return tracked;
  }

  async function waitForRowSaves(rowId: number): Promise<void> {
    const prefix = `${rowId}:`;
    let pending: Promise<unknown>[];
    while (
      (pending = [...pendingSaves.current]
        .filter(([, key]) => key.startsWith(prefix))
        .map(([promise]) => promise)).length
    ) {
      await Promise.allSettled(pending);
    }
    if ([...failedSaves.current].some((key) => key.startsWith(prefix))) {
      throw new ApiError(422, 'Сначала исправьте ошибки сохранения в этой строке.');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .tableColumns(dormitoryId, table, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setColumns(result);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setColumns([]);
          setLoading(false);
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить столбцы.');
        }
      });
    return () => controller.abort();
  }, [dormitoryId, table, attempt, revision]);
  const context: TableColumnsContext = {
    dormitoryId,
    table,
    columns,
    loading,
    error,
    values,
    trackSave,
    waitForRowSaves,
    reload: () => setAttempt((n) => n + 1),
    edit: settings
      ? (value) => {
          if (value) settings.open(table);
        }
      : setDialog,
    saved: (key, value) => setValues((current) => ({ ...current, [key]: value })),
  };
  return (
    <ColumnsContext.Provider value={context}>
      {children}
      {dialog === 'manage' && <ManageColumns />}
      {dialog && dialog !== 'manage' && (
        <ColumnEditor
          key={dialog === 'new' ? 'new' : dialog.id}
          column={dialog === 'new' ? null : dialog}
        />
      )}
    </ColumnsContext.Provider>
  );
}

export function ColumnsControls(): JSX.Element {
  const { edit, error, reload, loading } = useColumns();
  const settings = useSettingsNavigation();
  return (
    <div className={styles.controls}>
      {!settings && (
        <>
          <button type="button" disabled={loading || !!error} onClick={() => edit('new')}>
            + Добавить столбец
          </button>
          <button type="button" disabled={loading || !!error} onClick={() => edit('manage')}>
            Настроить столбцы
          </button>
        </>
      )}
      {loading && <span role="status">Загружаем столбцы…</span>}
      {error && (
        <span role="alert" className={styles.error}>
          {error}{' '}
          <button type="button" onClick={reload}>
            Повторить загрузку столбцов
          </button>
        </span>
      )}
    </div>
  );
}

function ManageColumns(): JSX.Element {
  const { columns, dormitoryId, table, reload, edit } = useColumns();
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState('');
  async function change(column: TableColumn): Promise<void> {
    setPending(true);
    setError('');
    try {
      if (column.archived) await api.restoreColumn(dormitoryId, table, column.id);
      else await api.deleteColumn(dormitoryId, table, column.id);
      setConfirm(null);
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось изменить столбец.');
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      title="Настроить столбцы"
      onClose={() => edit(null)}
      closeDisabled={pending}
      testId="manage-columns-modal"
    >
      <p className={styles.help}>
        При удалении столбец исчезнет из таблицы. Его значения сохранятся и будут доступны после
        восстановления.
      </p>
      <ul className={styles.columnList}>
        {columns.map((column) => (
          <li key={column.id}>
            <span>
              <strong>{column.name}</strong>
              <small>
                {kinds[column.kind]}
                {column.archived ? ' · удалён' : ''}
              </small>
            </span>
            {!column.archived && (
              <button
                type="button"
                disabled={pending}
                onClick={() => edit(column)}
                aria-label={`Настроить столбец ${column.name}`}
              >
                Изменить
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              aria-label={`${column.archived ? 'Восстановить' : confirm === column.id ? 'Подтвердить удаление' : 'Удалить'} столбец ${column.name}`}
              onClick={() =>
                column.archived || confirm === column.id
                  ? void change(column)
                  : setConfirm(column.id)
              }
            >
              {column.archived
                ? 'Восстановить'
                : confirm === column.id
                  ? 'Подтвердить удаление'
                  : 'Удалить'}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </Modal>
  );
}

function ColumnEditor({ column }: { column: TableColumn | null }): JSX.Element {
  const { dormitoryId, table, reload, edit } = useColumns();
  return (
    <ColumnForm
      column={column}
      onClose={() => edit(null)}
      onSave={async (input) => {
        if (column) await api.updateColumn(dormitoryId, table, column.id, input);
        else await api.createColumn(dormitoryId, table, input);
        reload();
      }}
    />
  );
}

export function ColumnForm({
  column = null,
  onClose,
  onSave,
  title,
  submitLabel,
  description,
}: {
  column?: TableColumn | null;
  onClose: () => void;
  onSave: (input: ColumnInput) => Promise<void>;
  title?: string;
  submitLabel?: string;
  description?: string;
}): JSX.Element {
  const [name, setName] = useState(column?.name ?? '');
  const [kind, setKind] = useState<ColumnKind>(column?.kind ?? 'text');
  const [options, setOptions] = useState<ColumnOption[]>(
    column?.options ?? [{ id: null, label: '', archived: false }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const input = { name: name.trim(), kind, options: kind === 'select' ? options : [] };
    if (!input.name) {
      setError('Укажите название столбца.');
      return;
    }
    if (
      kind === 'select' &&
      (!options.some((option) => !option.archived) ||
        options.some((option) => !option.label.trim()))
    ) {
      setError('Заполните варианты списка. Хотя бы один вариант должен быть доступен.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(input);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить столбец.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={title ?? (column ? 'Изменить столбец' : 'Добавить столбец')}
      onClose={onClose}
      closeDisabled={saving}
      testId="column-editor-modal"
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        {description && <p className={styles.help}>{description}</p>}
        <label>
          Название столбца
          <input
            value={name}
            maxLength={120}
            required
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Тип столбца
          <select
            value={kind}
            disabled={saving || !!column}
            onChange={(event) => setKind(event.target.value as ColumnKind)}
          >
            {Object.entries(kinds)
              .filter(([key]) => !!column || !['action', 'hostel'].includes(key))
              .map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        {column && (
          <p className={styles.help}>
            Тип сохраняется вместе с данными. Для другого типа добавьте новый столбец.
          </p>
        )}
        {kind === 'select' && (
          <fieldset disabled={saving || !!column?.builtin_key} className={styles.options}>
            <legend>Варианты списка</legend>
            {options.map((option, index) => (
              <div className={styles.option} key={option.id ?? `new-${index}`}>
                <input
                  aria-label={`Вариант ${index + 1}`}
                  value={option.label}
                  maxLength={120}
                  required
                  onChange={(event) =>
                    setOptions(
                      options.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    setOptions(
                      option.id
                        ? options.map((item, i) =>
                            i === index ? { ...item, archived: !item.archived } : item,
                          )
                        : options.filter((_, i) => i !== index),
                    )
                  }
                >
                  {option.archived ? 'Восстановить вариант' : option.id ? 'В архив' : 'Убрать'}
                </button>
                {option.archived && <small>В архиве</small>}
              </div>
            ))}
            <button
              type="button"
              disabled={options.length >= 200}
              onClick={() => setOptions([...options, { id: null, label: '', archived: false }])}
            >
              + Вариант
            </button>
            {column && (
              <p className={styles.help}>
                Архивный вариант остается в старых записях и расчетах, но недоступен для новых
                записей.
              </p>
            )}
          </fieldset>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={saving}>
            {saving ? 'Сохраняем…' : (submitLabel ?? 'Сохранить столбец')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function isRowAction(column: TableColumn): boolean {
  return column.kind === 'action' && !!column.builtin_key?.startsWith('action_');
}

function columnWidth(column: TableColumn): number {
  const builtinWidths: Record<string, number> = {
    row_number: 48,
    gender: 68,
    personnel_number: 104,
    full_name: 280,
    hostel_id: 210,
    shift_count: 96,
    phone: 168,
    medical_book: 116,
    citizenship: 160,
    reason: 210,
    notes: 260,
    additional_info: 260,
    advance_amount: 148,
    action_advance: 112,
    action_settlement: 112,
    action_transfer: 100,
    action_outflow: 88,
    action_evict: 108,
    action_delete: 88,
  };
  if (column.builtin_key && builtinWidths[column.builtin_key]) {
    return builtinWidths[column.builtin_key];
  }
  if (column.kind === 'checkbox') return 80;
  if (column.kind === 'action') return 104;
  if (column.kind === 'date') return 152;
  if (column.kind === 'number') return 128;
  if (column.kind === 'hostel') return 210;

  const name = column.name.toLocaleLowerCase('ru').replace(/[\s./№_-]+/g, '');
  if (name === 'пол') return 68;
  if (name === 'фио' || name.includes('фамилия')) return 280;
  if (name === 'тн' || name.includes('табельн')) return 104;
  if (name.includes('телефон')) return 168;
  if (name.includes('примечан') || name.includes('коммент') || name.includes('информац')) {
    return 260;
  }
  if (column.kind === 'select') {
    const longestOption = Math.max(0, ...column.options.map((option) => option.label.length));
    return Math.min(260, Math.max(128, longestOption * 7 + 48));
  }
  return 200;
}

export function ConfiguredTable({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}): JSX.Element {
  const { columns } = useColumns();
  const tableRef = useRef<HTMLTableElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => {
    const container = tableRef.current?.parentElement;
    if (!container) return;
    const measure = (): void => setAvailableWidth(container.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const settings = useSettingsNavigation();
  const visibleColumns = columns.filter(
    (column) => !column.archived && (!settings || !isRowAction(column)),
  );
  const actions = !!settings && columns.some((column) => !column.archived && isRowAction(column));
  const baseWidth = visibleColumns.reduce(
    (sum, column) => sum + columnWidth(column),
    actions ? 150 : 0,
  );
  const flexibleColumns = visibleColumns.filter(
    (column) => column.kind === 'text' && columnWidth(column) >= 200,
  );
  const extraWidth = flexibleColumns.length
    ? Math.max(0, availableWidth - baseWidth) / flexibleColumns.length
    : 0;
  return (
    <table
      ref={tableRef}
      className={className}
      style={{ width: baseWidth + extraWidth * flexibleColumns.length, minWidth: baseWidth }}
    >
      <colgroup>
        {visibleColumns.map((column) => (
          <col
            key={column.id}
            style={{
              width: columnWidth(column) + (flexibleColumns.includes(column) ? extraWidth : 0),
            }}
          />
        ))}
        {actions && <col style={{ width: 150 }} />}
      </colgroup>
      {children}
    </table>
  );
}

export function ConfiguredHeaders(): JSX.Element {
  const { columns } = useColumns();
  const settings = useSettingsNavigation();
  return (
    <>
      {columns
        .filter((column) => !column.archived && (!settings || !isRowAction(column)))
        .map((column) => (
          <th scope="col" key={column.id} data-column-key={column.builtin_key ?? undefined}>
            {column.name}
          </th>
        ))}
      {settings && columns.some((column) => !column.archived && isRowAction(column)) && (
        <th scope="col">Действия</th>
      )}
    </>
  );
}

export function ConfiguredCells({
  fields,
  row,
  children,
  readOnly = false,
}: {
  fields: string[];
  row: { id: number; custom_values?: Record<string, CellValue> };
  children: ReactNode;
  readOnly?: boolean;
}): JSX.Element {
  const { columns } = useColumns();
  const settings = useSettingsNavigation();
  const cells = Children.toArray(children);
  return (
    <>
      {columns
        .filter((column) => !column.archived && (!settings || !isRowAction(column)))
        .map((column) =>
          column.builtin_key ? (
            <Fragment key={column.id}>{cells[fields.indexOf(column.builtin_key)]}</Fragment>
          ) : (
            <td key={column.id} className={styles.customCell}>
              <CustomCell column={column} row={row} readOnly={readOnly} />
            </td>
          ),
        )}
      {settings && columns.some((column) => !column.archived && isRowAction(column)) && (
        <td className={styles.rowActions}>
          <details
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.open = false;
            }}
          >
            <summary
              aria-label={`Действия, строка ${row.id}`}
              aria-disabled={readOnly || settings.readOnly}
            >
              Действия <span>⌄</span>
            </summary>
            <div className={styles.rowActionList}>
              {columns
                .filter((column) => !column.archived && isRowAction(column))
                .map((column) => (
                  <Fragment key={column.id}>
                    {actionParts(
                      cells[fields.indexOf(column.builtin_key ?? '')],
                      column,
                      readOnly || settings.readOnly,
                      true,
                    )}
                  </Fragment>
                ))}
            </div>
          </details>
          {columns
            .filter((column) => !column.archived && isRowAction(column))
            .map((column) => (
              <Fragment key={column.id}>
                {actionParts(
                  cells[fields.indexOf(column.builtin_key ?? '')],
                  column,
                  readOnly || settings.readOnly,
                  false,
                )}
              </Fragment>
            ))}
        </td>
      )}
    </>
  );
}

function actionParts(
  node: ReactNode,
  column: TableColumn,
  disabled: boolean,
  buttons: boolean,
): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean }>(child))
      return buttons ? null : child;
    if (child.type === 'button')
      return buttons
        ? cloneElement(
            child,
            { disabled: disabled || child.props.disabled },
            column.builtin_key === 'action_advance'
              ? 'Записать на аванс'
              : column.builtin_key === 'action_settlement'
                ? 'Записать на расчёт'
                : child.props.children,
          )
        : null;
    if (child.type === 'td' || child.type === Fragment)
      return actionParts(child.props.children, column, disabled, buttons);
    return buttons ? null : child;
  });
}

function CustomCell({
  column,
  row,
  readOnly,
}: {
  column: TableColumn;
  row: { id: number; custom_values?: Record<string, CellValue> };
  readOnly: boolean;
}): JSX.Element {
  const { dormitoryId, table, values, saved, trackSave } = useColumns();
  const key = `${row.id}:${column.id}`;
  const initial = key in values ? values[key] : (row.custom_values?.[column.id] ?? null);
  const [draft, setDraft] = useState<CellValue>(initial);
  const [committed, setCommitted] = useState<CellValue>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(value: CellValue): Promise<void> {
    if (saving || readOnly) return;
    if (value === committed) {
      await trackSave(key, Promise.resolve());
      setError('');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await trackSave(
        key,
        api.saveCustomCell(dormitoryId, table, row.id, column.id, value),
      );
      setDraft(result.value);
      setCommitted(result.value);
      saved(key, result.value);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить значение.');
    } finally {
      setSaving(false);
    }
  }
  const label = `${column.name}, строка ${row.id}`;
  return (
    <div className={styles.cell}>
      {column.kind === 'select' ? (
        <select
          aria-label={label}
          value={String(draft ?? '')}
          disabled={saving || readOnly}
          onChange={(event) => {
            const value = event.target.value || null;
            setDraft(value);
            void save(value);
          }}
        >
          <option value="">Не выбрано</option>
          {column.options
            .filter((option) => !option.archived || option.id === draft)
            .map((option) => (
              <option key={option.id} value={option.id ?? ''} disabled={option.archived}>
                {option.label}
                {option.archived ? ' (в архиве)' : ''}
              </option>
            ))}
        </select>
      ) : column.kind === 'checkbox' ? (
        <input
          type="checkbox"
          aria-label={label}
          checked={draft === true}
          disabled={saving || readOnly}
          onChange={(event) => {
            setDraft(event.target.checked);
            void save(event.target.checked);
          }}
        />
      ) : (
        <input
          aria-label={label}
          type={column.kind === 'date' ? 'date' : column.kind === 'number' ? 'number' : 'text'}
          step={column.kind === 'number' ? 'any' : undefined}
          value={String(draft ?? '')}
          maxLength={5000}
          disabled={saving || readOnly}
          onChange={(event) => {
            const value = event.target.value || null;
            setDraft(value);
            setError('');
            if (column.kind === 'date') void save(value);
          }}
          onBlur={() => void save(draft)}
        />
      )}
      {saving && <small role="status">Сохраняем…</small>}
      {error && (
        <span role="alert" className={styles.error}>
          {error}{' '}
          <button type="button" disabled={readOnly} onClick={() => void save(draft)}>
            Повторить
          </button>
        </span>
      )}
    </div>
  );
}
