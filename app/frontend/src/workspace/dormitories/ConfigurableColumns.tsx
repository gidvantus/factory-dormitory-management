import { Children, Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { api, ApiError } from '../../api/client';
import type { CellValue, ColumnKind, ColumnOption, TableColumn, TableKey } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './ConfigurableColumns.module.css';
import { ColumnsContext, useColumns } from './tableColumnsContext';
import type { ColumnsDialog, TableColumnsContext } from './tableColumnsContext';

const kinds: Record<ColumnKind, string> = {
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  checkbox: 'Чекбокс',
  select: 'Выпадающий список',
  action: 'Действие',
  hostel: 'Место проживания',
};
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
  }, [dormitoryId, table, attempt]);
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
    edit: setDialog,
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
  return (
    <div className={styles.controls}>
      <button type="button" disabled={loading || !!error} onClick={() => edit('new')}>
        + Добавить столбец
      </button>
      <button type="button" disabled={loading || !!error} onClick={() => edit('manage')}>
        Настроить столбцы
      </button>
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
      if (column) await api.updateColumn(dormitoryId, table, column.id, input);
      else await api.createColumn(dormitoryId, table, input);
      reload();
      edit(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить столбец.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={column ? 'Изменить столбец' : 'Добавить столбец'}
      onClose={() => edit(null)}
      closeDisabled={saving}
      testId="column-editor-modal"
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
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
          <button type="button" disabled={saving} onClick={() => edit(null)}>
            Отмена
          </button>
          <button type="submit" disabled={saving}>
            {saving ? 'Сохраняем…' : 'Сохранить столбец'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function columnWidth(column: TableColumn): number {
  return column.kind === 'checkbox'
    ? 100
    : column.kind === 'action'
      ? 110
      : column.kind === 'date'
        ? 160
        : 190;
}

export function ConfiguredTable({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}): JSX.Element {
  const { columns } = useColumns();
  return (
    <table
      className={className}
      style={{
        minWidth: columns
          .filter((column) => !column.archived)
          .reduce((sum, col) => sum + columnWidth(col), 0),
      }}
    >
      {children}
    </table>
  );
}

export function ConfiguredHeaders(): JSX.Element {
  const { columns } = useColumns();
  return (
    <>
      {columns
        .filter((column) => !column.archived)
        .map((column) => (
          <th scope="col" key={column.id} style={{ width: columnWidth(column) }}>
            {column.name}
          </th>
        ))}
    </>
  );
}

export function ConfiguredCells({
  fields,
  row,
  children,
}: {
  fields: string[];
  row: { id: number; custom_values?: Record<string, CellValue> };
  children: ReactNode;
}): JSX.Element {
  const { columns } = useColumns();
  const cells = Children.toArray(children);
  return (
    <>
      {columns
        .filter((column) => !column.archived)
        .map((column) =>
          column.builtin_key ? (
            <Fragment key={column.id}>{cells[fields.indexOf(column.builtin_key)]}</Fragment>
          ) : (
            <td key={column.id} className={styles.customCell}>
              <CustomCell column={column} row={row} />
            </td>
          ),
        )}
    </>
  );
}

function CustomCell({
  column,
  row,
}: {
  column: TableColumn;
  row: { id: number; custom_values?: Record<string, CellValue> };
}): JSX.Element {
  const { dormitoryId, table, values, saved, trackSave } = useColumns();
  const key = `${row.id}:${column.id}`;
  const initial = key in values ? values[key] : (row.custom_values?.[column.id] ?? null);
  const [draft, setDraft] = useState<CellValue>(initial);
  const [committed, setCommitted] = useState<CellValue>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(value: CellValue): Promise<void> {
    if (saving) return;
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
          disabled={saving}
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
          disabled={saving}
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
          disabled={saving}
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
          <button type="button" onClick={() => void save(draft)}>
            Повторить
          </button>
        </span>
      )}
    </div>
  );
}
