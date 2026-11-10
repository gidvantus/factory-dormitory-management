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
  CellFillConfig,
  CellFillRow,
  ColumnInput,
  ColumnKind,
  ColumnOption,
  TableColumn,
  TableKey,
  OutflowFields,
} from '../../api/client';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { useEditorPreview } from '../../components/EditorSurface';
import { EditorSection } from '../../components/EditorSection';
import { useOrganizedEditor } from '../../components/useOrganizedEditor';
import { personnelApi } from '../../api/personnel';
import { BindingDialog } from '../personnel/BindingDialog';
import type { SourceTable } from '../../api/personnel';
import { EmployeeNameCell } from './EmployeeNameCell';
import { personnelCellFields } from './personnelCellFields';
import styles from './ConfigurableColumns.module.css';
import { ColumnsContext, useColumns } from './tableColumnsContext';
import type { ColumnsDialog, TableColumnsContext } from './tableColumnsContext';
import { columnKinds as kinds } from './columnKinds';
import { useSettingsNavigation } from './settingsContext';
import { RowActionsMenu } from './RowActionsMenu';
import { OutflowReasonInput } from './OutflowReasonInput';
import { useUnsavedChanges } from '../../components/useUnsavedChanges';
import { CellFillCell } from './CellFillCell';
import { CellFillEditor } from './CellFillEditor';
import { cellFillError, supportsCellFill, useCellFillSources } from './cellFill';
import { ColumnArchiveTabs } from '../../components/ColumnArchiveTabs';
import { WorkingTable } from '../../components/WorkingTable';
import { useWorkingColumns } from '../../components/workingTableContext';

export function TableColumnsProvider({
  dormitoryId,
  table,
  children,
  showActions = true,
  showDates = true,
}: {
  dormitoryId: string;
  table: TableKey;
  children: ReactNode;
  showActions?: boolean;
  showDates?: boolean;
}): JSX.Element {
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const settings = useSettingsNavigation();
  const revision = settings?.revision;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<ColumnsDialog>(null);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [fillRows, setFillRows] = useState<Record<number, CellFillRow>>({});
  const [fillRefreshError, setFillRefreshError] = useState('');
  const fillVersion = useRef(0);
  const refreshFillValues = useRef<() => void>(() => {});
  const [personnelFields, setPersonnelFields] = useState<Record<string, number>>({});
  const [outflowFields, setOutflowFields] = useState<OutflowFields | null>(null);
  const pendingSaves = useRef(new Map<Promise<unknown>, string>());
  const failedSaves = useRef(new Set<string>());
  const [saveStatus, setSaveStatus] = useState({ pending: 0, failed: 0, touched: false });
  function updateSaveStatus(): void {
    setSaveStatus({
      pending: pendingSaves.current.size,
      failed: failedSaves.current.size,
      touched: true,
    });
  }

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
        updateSaveStatus();
      });
    pendingSaves.current.set(tracked, key);
    updateSaveStatus();
    return tracked;
  }

  async function waitForRowSaves(rowId: number, exceptKey?: string): Promise<void> {
    const prefix = `${rowId}:`;
    let pending: Promise<unknown>[];
    while (
      (pending = [...pendingSaves.current]
        .filter(([, key]) => key.startsWith(prefix) && key !== exceptKey)
        .map(([promise]) => promise)).length
    ) {
      await Promise.allSettled(pending);
    }
    if ([...failedSaves.current].some((key) => key.startsWith(prefix) && key !== exceptKey)) {
      throw new ApiError(422, 'Сначала исправьте ошибки сохранения в этой строке.');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFillRows({});
    setFillRefreshError('');
    fillVersion.current += 1;
    void Promise.all([
      api.tableColumns(dormitoryId, table, controller.signal),
      table === 'residents'
        ? personnelApi.binding(dormitoryId, table, controller.signal).catch(() => ({ fields: {} }))
        : table === 'archive' || table.startsWith('custom_')
          ? personnelApi.binding(dormitoryId, table as SourceTable, controller.signal)
          : Promise.resolve({ fields: {} }),
      table === 'outflow'
        ? api.outflowFields(dormitoryId, controller.signal)
        : Promise.resolve(null),
    ])
      .then(([result, binding, outflow]) => {
        if (!controller.signal.aborted) {
          setColumns(result);
          setPersonnelFields(binding.fields);
          setOutflowFields(outflow);
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
  useEffect(() => {
    if (!columns.some((column) => !column.archived && column.fill)) return;
    const controller = new AbortController();
    let pending = false;
    async function refresh(): Promise<void> {
      if (document.visibilityState === 'hidden' || pending || pendingSaves.current.size) return;
      const version = fillVersion.current;
      pending = true;
      try {
        const rows = await api.cellFillValues(dormitoryId, table, controller.signal);
        if (!controller.signal.aborted && version === fillVersion.current) {
          setFillRows(Object.fromEntries(rows.map((row) => [row.id, row])));
          setFillRefreshError('');
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setFillRefreshError(
            caught instanceof ApiError ? caught.message : 'Не удалось обновить связанные ячейки.',
          );
      } finally {
        pending = false;
      }
    }
    const timer = window.setInterval(() => void refresh(), 30000);
    const focus = (): void => {
      void refresh();
    };
    refreshFillValues.current = focus;
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      refreshFillValues.current = () => {};
    };
  }, [columns, dormitoryId, table]);
  const context: TableColumnsContext = {
    dormitoryId,
    table,
    columns: columns.filter(
      (column) => (showActions || !isRowAction(column)) && (showDates || column.kind !== 'date'),
    ),
    loading,
    error,
    values,
    fillRows,
    fillSaved: (row) => {
      fillVersion.current += 1;
      setFillRows((current) => ({ ...current, [row.id]: row }));
    },
    personnelFields,
    outflowFields,
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
      {saveStatus.touched && (
        <p role="status" aria-live="polite">
          {saveStatus.pending
            ? `Сохраняем изменения (${saveStatus.pending})…`
            : saveStatus.failed
              ? 'Есть ошибки сохранения. Исправьте отмеченные ячейки.'
              : 'Все изменения сохранены'}
        </p>
      )}
      {children}
      {fillRefreshError && (
        <p role="alert" className={styles.error}>
          {fillRefreshError}{' '}
          <button className="link-button" type="button" onClick={() => refreshFillValues.current()}>
            Обновить связанные ячейки
          </button>
        </p>
      )}
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
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            disabled={loading || !!error}
            onClick={() => edit('new')}
          >
            + Добавить столбец
          </button>
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            disabled={loading || !!error}
            onClick={() => edit('manage')}
          >
            Настроить столбцы
          </button>
        </>
      )}
      {loading && <span role="status">Загружаем столбцы…</span>}
      {error && (
        <span role="alert" className={styles.error}>
          {error}{' '}
          <button className="btn btn--ghost btn--compact" type="button" onClick={reload}>
            Повторить загрузку столбцов
          </button>
        </span>
      )}
    </div>
  );
}

function ManageColumns(): JSX.Element {
  const { columns, dormitoryId, table, reload, edit } = useColumns();
  const [binding, setBinding] = useState<SourceTable | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [archived, setArchived] = useState(false);
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
      {binding ? (
        <BindingDialog
          inline
          dormitoryId={dormitoryId}
          tableKey={binding}
          onBusyChange={setPending}
          onClose={() => setBinding(null)}
          onSaved={() => {
            setBinding(null);
            reload();
          }}
        />
      ) : (
        <>
          <p className={styles.help}>
            При удалении столбец исчезнет из таблицы. Его значения сохранятся и будут доступны после
            восстановления.
          </p>
          {(table === 'archive' || table.startsWith('custom_')) && (
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={pending}
              onClick={() => setBinding(table as SourceTable)}
            >
              Связь с персоналом
            </button>
          )}
          <ColumnArchiveTabs
            archived={archived}
            onChange={setArchived}
            currentCount={columns.filter((column) => !column.archived).length}
            archivedCount={columns.filter((column) => column.archived).length}
          />
          <ul className={styles.columnList}>
            {columns
              .filter((column) => column.archived === archived)
              .map((column) => (
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
                      className="btn btn--ghost btn--compact"
                      type="button"
                      disabled={pending}
                      onClick={() => edit(column)}
                      aria-label={`Настроить столбец ${column.name}`}
                    >
                      Изменить
                    </button>
                  )}
                  <button
                    className={`btn ${column.archived ? 'btn--ghost' : 'btn--danger'} btn--compact`}
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
        </>
      )}
    </Modal>
  );
}

function ColumnEditor({ column }: { column: TableColumn | null }): JSX.Element {
  const { dormitoryId, table, columns, reload, edit } = useColumns();
  return (
    <ColumnForm
      column={column}
      fillContext={{ dormitoryId, table, columns }}
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
  fillContext,
}: {
  column?: TableColumn | null;
  onClose: () => void;
  onSave: (input: ColumnInput) => Promise<void>;
  title?: string;
  submitLabel?: string;
  description?: string;
  fillContext?: { dormitoryId: string; table: TableKey; columns: TableColumn[] };
}): JSX.Element {
  const organized = useOrganizedEditor();
  const [name, setName] = useState(column?.name ?? '');
  const [kind, setKind] = useState<ColumnKind>(column?.kind ?? 'text');
  const [fill, setFill] = useState<CellFillConfig | null>(column?.fill ?? null);
  const fillEnabled =
    !!fillContext?.table.startsWith('custom_') && !column?.builtin_key && supportsCellFill(kind);
  const fillSources = useCellFillSources(fillContext?.dormitoryId, fillEnabled);
  const [options, setOptions] = useState<ColumnOption[]>(
    column?.options ?? [{ id: null, label: '', archived: false }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEditorPreview('column', { name, kind, options });
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const input: ColumnInput = {
      name: name.trim(),
      kind,
      options: kind === 'select' ? options : [],
      ...(fillContext?.table.startsWith('custom_') ? { fill } : {}),
    };
    if (fill && fillContext) {
      const message = cellFillError(fill, kind, fillContext.columns, fillSources.sources);
      if (message) {
        setError(message);
        return;
      }
    }
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
        <EditorSection
          title="Название столбца"
          description="Используйте название данных: например, «Дата выхода» или «Выданный комплект»."
        >
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
        </EditorSection>
        <EditorSection
          title="Формат данных"
          description="Тип можно изменить, пока столбец полностью пуст и не используется в связях."
        >
          <label>
            Тип столбца
            <select
              value={kind}
              disabled={saving || !!column?.builtin_key || !!column?.type_change_reason}
              onChange={(event) => {
                setKind(event.target.value as ColumnKind);
                setFill(null);
                setOptions([{ id: null, label: '', archived: false }]);
              }}
            >
              {Object.entries(kinds)
                .filter(([key]) => !!column?.builtin_key || !['action', 'hostel'].includes(key))
                .map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {column && (
            <p className={styles.help}>
              {column.type_change_reason ??
                (column.builtin_key
                  ? 'Тип стандартного столбца связан с работой системы.'
                  : 'Изменение доступно только для полностью пустого столбца.')}
            </p>
          )}
          {organized && (
            <p className={styles.help}>
              {
                {
                  text: 'Любой короткий текст: ФИО, телефон, комментарий.',
                  number: 'Числовое значение, которое можно использовать в расчётах.',
                  date: 'Дата события, начала или окончания периода.',
                  checkbox: 'Отметка «да / нет».',
                  select: 'Один вариант из заранее заданного списка.',
                  action: 'Служебное действие строки.',
                  hostel: 'Место проживания сотрудника.',
                }[kind]
              }
            </p>
          )}
        </EditorSection>
        {kind === 'select' && (
          <EditorSection
            title="Варианты для выбора"
            description="Добавьте варианты. Использованные варианты можно архивировать без потери старых значений."
          >
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
                    className="btn btn--ghost btn--compact"
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
                className="btn btn--ghost btn--compact"
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
          </EditorSection>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {fillEnabled && fillContext && (
          <EditorSection
            title="Заполнение ячеек"
            description="Настройте ручной ввод, выбор записи или связь с другой таблицей."
          >
            {fillSources.loading && <p role="status">Загружаем источники…</p>}
            {fillSources.error && (
              <p role="alert">
                {fillSources.error}{' '}
                <button className="link-button" type="button" onClick={fillSources.retry}>
                  Повторить
                </button>
              </p>
            )}
            <CellFillEditor
              value={fill}
              kind={kind}
              columnId={column?.id}
              columns={fillContext.columns}
              sources={fillSources.sources}
              table={fillContext.table}
              disabled={saving || fillSources.loading}
              onChange={setFill}
            />
          </EditorSection>
        )}
        <div className={styles.actions}>
          <ModalCancelButton
            className="btn btn--ghost btn--compact"
            onClick={onClose}
            type="button"
            disabled={saving}
          >
            Отмена
          </ModalCancelButton>
          <button className="btn btn--primary btn--compact" type="submit" disabled={saving}>
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

export function ConfiguredTable({
  className,
  children,
  trailingColumns = 0,
  trailing,
}: {
  className: string;
  children: ReactNode;
  trailingColumns?: number;
  trailing?: { id: string; label: string }[];
}): JSX.Element {
  const { columns, dormitoryId, table } = useColumns();
  const settings = useSettingsNavigation();
  const visible = columns.filter(
    (column) => !column.archived && (!settings || !isRowAction(column)),
  );
  const actions = !!settings && columns.some((column) => !column.archived && isRowAction(column));
  return (
    <WorkingTable
      className={className}
      configured
      readOnly={settings?.readOnly}
      viewKey={
        location.pathname.startsWith('/preview/')
          ? undefined
          : `dormitories/${dormitoryId}/table-views/${table}`
      }
      revisionKey={columns
        .map((column) => `${column.id}:${column.position}:${column.archived}`)
        .join('|')}
      columns={[
        ...visible.map((column) => ({
          id: String(column.id),
          label: column.name,
          kind: column.kind,
        })),
        ...(actions ? [{ id: 'actions', label: 'Действия' }] : []),
        ...(trailing ??
          Array.from({ length: trailingColumns }, (_, index) => ({
            id: `day-${index}`,
            label: `День ${index + 1}`,
          }))),
      ]}
    >
      {children}
    </WorkingTable>
  );
}

type ExtraCell = { id: string; node: ReactNode };
function OrderedTableCells({
  ids,
  children,
  extras = [],
}: {
  ids: string[];
  children: ReactNode;
  extras?: ExtraCell[];
}): JSX.Element {
  const root = isValidElement<{ children?: ReactNode }>(children)
    ? children.props.children
    : children;
  const nodes = Children.toArray(root);
  const ordered = useWorkingColumns([
    ...ids.map((id, index) => ({ id, node: nodes[index] })),
    ...extras,
  ]);
  return (
    <>
      {ordered.map((item) => (
        <Fragment key={item.id}>{item.node}</Fragment>
      ))}
    </>
  );
}

export function ConfiguredHeaders({ extra = [] }: { extra?: ExtraCell[] } = {}): JSX.Element {
  const context = useColumns();
  const columns = useWorkingColumns(context.columns);
  const settings = useSettingsNavigation();
  const ids = columns
    .filter((column) => !column.archived && (!settings || !isRowAction(column)))
    .map((column) => String(column.id));
  if (settings && columns.some((column) => !column.archived && isRowAction(column)))
    ids.push('actions');
  return (
    <OrderedTableCells ids={ids} extras={extra}>
      <>
        {columns
          .filter((column) => !column.archived && (!settings || !isRowAction(column)))
          .map((column) => (
            <th scope="col" key={column.id} data-column-key={column.builtin_key ?? undefined}>
              {column.name}
              {column.fill && (
                <sup
                  className="table-rule-mark"
                  aria-label="Связь с таблицей"
                  title={
                    column.fill.mode === 'pick'
                      ? 'Выбор записи'
                      : column.fill.update === 'copy'
                        ? 'Разовая копия'
                        : 'Из таблицы'
                  }
                >
                  ↗
                </sup>
              )}
            </th>
          ))}
        {settings && columns.some((column) => !column.archived && isRowAction(column)) && (
          <th scope="col">Действия</th>
        )}
      </>
    </OrderedTableCells>
  );
}

export function ConfiguredCells({
  fields,
  row,
  children,
  readOnly = false,
  onPersonnelLinked,
  actionResult,
  extra = [],
}: {
  fields: string[];
  row: CellFillRow & { custom_values?: Record<string, CellValue>; employee_id?: string | null };
  children: ReactNode;
  readOnly?: boolean;
  onPersonnelLinked?: (id: string) => void;
  actionResult?: string | undefined;
  extra?: ExtraCell[];
}): JSX.Element {
  const context = useColumns();
  const columns = useWorkingColumns(context.columns);
  const settings = useSettingsNavigation();
  const cells = Children.toArray(children);
  const ids = columns
    .filter((column) => !column.archived && (!settings || !isRowAction(column)))
    .map((column) => String(column.id));
  if (settings && columns.some((column) => !column.archived && isRowAction(column)))
    ids.push('actions');
  return (
    <OrderedTableCells ids={ids} extras={extra}>
      <>
        {columns
          .filter((column) => !column.archived && (!settings || !isRowAction(column)))
          .map((column) =>
            actionResult && isRowAction(column) ? (
              <td key={column.id} className={styles.rowActions}>
                {column.id === columns.find((item) => !item.archived && isRowAction(item))?.id && (
                  <span className={styles.rowActionResult}>{actionResult}</span>
                )}
              </td>
            ) : column.fill ? (
              <td key={column.id} className={styles.customCell}>
                <CellFillCell
                  column={column}
                  row={row}
                  readOnly={readOnly || !!settings?.readOnly}
                />
              </td>
            ) : column.builtin_key ? (
              <Fragment key={column.id}>{cells[fields.indexOf(column.builtin_key)]}</Fragment>
            ) : (
              <td key={column.id} className={styles.customCell}>
                <CustomCell
                  column={column}
                  row={row}
                  readOnly={readOnly || !!settings?.readOnly}
                  onPersonnelLinked={onPersonnelLinked}
                />
              </td>
            ),
          )}
        {settings && columns.some((column) => !column.archived && isRowAction(column)) && (
          <td className={styles.rowActions}>
            {actionResult ? (
              <span className={styles.rowActionResult}>{actionResult}</span>
            ) : (
              <RowActionsMenu label={`Действия, строка ${row.id}`}>
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
              </RowActionsMenu>
            )}
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
    </OrderedTableCells>
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
  onPersonnelLinked,
}: {
  column: TableColumn;
  row: { id: number; custom_values?: Record<string, CellValue>; employee_id?: string | null };
  readOnly: boolean;
  onPersonnelLinked?: (id: string) => void;
}): JSX.Element {
  const {
    dormitoryId,
    table,
    values,
    saved,
    trackSave,
    personnelFields,
    waitForRowSaves,
    outflowFields,
    reload,
  } = useColumns();
  const key = `${row.id}:${column.id}`;
  const initial = key in values ? values[key] : (row.custom_values?.[column.id] ?? null);
  const [draft, setDraft] = useState<CellValue>(initial);
  const [committed, setCommitted] = useState<CellValue>(initial);
  useUnsavedChanges(draft !== committed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(value: CellValue): Promise<boolean> {
    if (saving || readOnly) return false;
    if (value === committed) {
      await trackSave(key, Promise.resolve());
      setError('');
      return true;
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
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить значение.');
      return false;
    } finally {
      setSaving(false);
    }
  }
  const label = `${column.name}, строка ${row.id}`;
  return (
    <div className={styles.cell}>
      {column.kind === 'text' && personnelFields?.full_name === column.id ? (
        <EmployeeNameCell
          dormitoryId={dormitoryId}
          tableKey={table as SourceTable}
          rowId={row.id}
          employeeId={row.employee_id}
          label={column.name}
          fields={{
            ...personnelCellFields(row, values, personnelFields),
            full_name: String(draft ?? ''),
          }}
          onChange={(name) => {
            setDraft(name);
            setError('');
          }}
          onSave={(name) => save(name.trim() || null)}
          beforeOpen={() => waitForRowSaves(row.id)}
          onLinked={onPersonnelLinked}
          readOnly={readOnly}
        />
      ) : table === 'outflow' &&
        column.id === outflowFields?.reason_column?.id &&
        column.kind === 'text' ? (
        <OutflowReasonInput
          compact
          value={String(draft ?? '')}
          label={label}
          choices={outflowFields.reasons}
          allowCustom
          disabled={saving || readOnly}
          onChange={(value) => {
            setDraft(value);
            setError('');
          }}
          onCommit={async (value) => {
            const result = await save(value || null);
            if (result) reload();
            return result;
          }}
        />
      ) : column.kind === 'select' ? (
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
          <button
            className="link-button"
            type="button"
            disabled={readOnly}
            onClick={() => void save(draft)}
          >
            Повторить
          </button>
        </span>
      )}
    </div>
  );
}
