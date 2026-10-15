import { useEffect, useRef, useState } from 'react';
import { api, ApiError, waitForDormitoryWrites } from '../../api/client';
import type {
  ColumnKind,
  CustomTabOptions,
  DormitorySettings,
  ReportRow,
  SettingsColumn,
  SettingsInput,
  StructureTemplate,
} from '../../api/client';
import { CustomTabOptionsEditor } from './CustomTabOptionsEditor';
import { defaultTabOptions } from './customTabOptions';
import { Modal } from '../../components/Modal';
import { columnKinds } from './columnKinds';
import { RowDialog } from './ReportTable';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { RuleSummary } from './RuleSummary';
import { BindingDialog } from '../personnel/BindingDialog';
import type { SourceTable } from '../../api/personnel';
import styles from './DormitorySettingsDialog.module.css';

type Page = 'structure' | 'links' | 'templates';
type DraftColumn = Omit<SettingsColumn, 'id' | 'table_key'> & { id?: number; local: number };
interface Node {
  key: string;
  name: string;
  parent: string | null;
  status: 'active' | 'hidden' | 'deleted';
  custom: boolean;
  reason: string | null;
  options?: CustomTabOptions;
  dateColumnName?: string | null;
}
const errorText = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';

export function DormitorySettingsDialog({
  dormitoryId,
  initialKey,
  initialPage = 'structure',
  onClose,
  onChanged,
  onOpen,
}: {
  dormitoryId: string;
  initialKey?: string;
  initialPage?: Page;
  onClose: () => void;
  onChanged: (settings: DormitorySettings) => void;
  onOpen: (key: string) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<DormitorySettings | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [tables, setTables] = useState<Record<string, DraftColumn[]>>({});
  const [changedTables, setChangedTables] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState(initialKey || 'residents');
  const [page, setPage] = useState<Page>(initialPage);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState<{ parent: string | null } | null>(null);
  const [editingRule, setEditingRule] = useState<ReportRow | 'new' | null>(null);
  const [binding, setBinding] = useState<SourceTable | null>(null);
  const [templates, setTemplates] = useState<StructureTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [templateError, setTemplateError] = useState('');
  const [deleteTemplate, setDeleteTemplate] = useState<number | null>(null);
  const sequence = useRef(0);

  function hydrate(data: DormitorySettings): void {
    setSnapshot(data);
    setNodes([
      ...data.sections.map((item) => ({
        key: item.key,
        name: item.name,
        parent: item.parent_key,
        status: item.status,
        custom: false,
        reason: item.delete_block_reason,
      })),
      ...data.tabs.map((item) => ({
        key: item.table_key,
        name: item.name,
        parent: item.parent_id ? `custom_${item.parent_id}` : (item.parent_section ?? null),
        status: item.is_active ? ('active' as const) : ('hidden' as const),
        custom: true,
        options: { ...defaultTabOptions, ...item.options },
        reason: item.delete_block_reason,
      })),
    ]);
    setTables(
      Object.fromEntries(
        Object.entries(data.tables).map(([key, columns]) => [
          key,
          columns.map((column) => ({ ...column, local: ++sequence.current })),
        ]),
      ),
    );
    setChangedTables([]);
    setDirty(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void waitForDormitoryWrites(dormitoryId)
      .then(() => api.dormitorySettings(dormitoryId, controller.signal))
      .then((data) => {
        if (!controller.signal.aborted) hydrate(data);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(errorText(caught));
      });
    return () => controller.abort();
  }, [dormitoryId, attempt]);

  useEffect(() => {
    if (page !== 'templates') return;
    const controller = new AbortController();
    setTemplateError('');
    void api
      .structureTemplates(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setTemplates(items);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setTemplateError(errorText(caught));
      });
    return () => controller.abort();
  }, [page]);

  const node = nodes.find((item) => item.key === selected);
  function ancestors(item: Node): Node[] {
    const chain: Node[] = [];
    let current: Node | undefined = item;
    while (current && !chain.some((entry) => entry.key === current?.key)) {
      chain.unshift(current);
      current = nodes.find((entry) => entry.key === current?.parent);
    }
    return chain;
  }
  const blocked = !!node && ancestors(node).some((item) => item.status !== 'active');
  const columns = tables[selected] ?? [];
  const rules: ReportRow[] =
    snapshot?.rules.map((item, position) => ({ ...item, position, values: {}, errors: {} })) ?? [];
  function updateColumns(next: DraftColumn[]): void {
    setTables((current) => ({ ...current, [selected]: next }));
    setChangedTables((current) => (current.includes(selected) ? current : [...current, selected]));
    setDirty(true);
    setMessage('');
  }
  function changeColumn(local: number, patch: Partial<DraftColumn>): void {
    updateColumns(
      columns.map((column) => (column.local === local ? { ...column, ...patch } : column)),
    );
  }
  function updateNode(patch: Partial<Node>): void {
    setNodes((current) =>
      current.map((item) => (item.key === selected ? { ...item, ...patch } : item)),
    );
    setDirty(true);
    setMessage('');
    setConfirmDelete(false);
  }
  function close(): void {
    if (dirty) setConfirmClose(true);
    else onClose();
  }
  async function save(): Promise<void> {
    if (!snapshot || busy) return;
    for (const key of changedTables) {
      const active = tables[key].filter((column) => !column.archived);
      const invalid = active.find(
        (column) =>
          !column.name.trim() ||
          (column.kind === 'select' &&
            (!column.options.some((option) => !option.archived) ||
              column.options.some((option) => !option.label.trim()))),
      );
      if (invalid) {
        setError(
          `Заполните название и варианты списка в таблице «${nodes.find((item) => item.key === key)?.name}».`,
        );
        return;
      }
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await waitForDormitoryWrites(dormitoryId);
      const deleted = nodes
        .filter(
          (item) =>
            item.status === 'deleted' &&
            (item.custom ||
              snapshot.sections.find((entry) => entry.key === item.key)?.status !== 'deleted'),
        )
        .filter(
          (item) =>
            !ancestors(item)
              .slice(0, -1)
              .some((ancestor) => ancestor.status === 'deleted'),
        )
        .map((item) => item.key);
      const input: SettingsInput = {
        revision: snapshot.revision,
        tables: changedTables
          .filter((key) => {
            const item = nodes.find((entry) => entry.key === key);
            return item && !ancestors(item).some((entry) => entry.status === 'deleted');
          })
          .map((key) => ({
            key,
            columns: tables[key].map((column) => ({
              ...(column.id ? { id: column.id } : {}),
              name: column.name.trim(),
              kind: column.kind,
              options: column.options,
              archived: column.archived,
            })),
          })),
        tabs: nodes
          .filter((item) => item.custom && item.status !== 'deleted')
          .map((item) => ({
            key: item.key,
            name: item.name.trim(),
            parent_key: item.parent,
            is_active: item.status === 'active',
            options: item.options,
            date_column_name: item.dateColumnName,
          })),
        sections: Object.fromEntries(
          nodes
            .filter(
              (item) =>
                !item.custom &&
                item.status !== 'deleted' &&
                snapshot.sections.find((entry) => entry.key === item.key)?.status !== item.status,
            )
            .map((item) => [item.key, item.status as 'active' | 'hidden']),
        ),
        deleted,
      };
      const data = await api.saveDormitorySettings(dormitoryId, input);
      hydrate(data);
      onChanged(data);
      setMessage('Изменения сохранены');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  function addColumn(): void {
    const next = {
      local: ++sequence.current,
      name: '',
      kind: 'text' as const,
      builtin_key: null,
      position: columns.length,
      options: [],
      archived: false,
      used_by: [],
    };
    const actionIndex = columns.findIndex(
      (column) => column.kind === 'action' && column.builtin_key?.startsWith('action_'),
    );
    const result = [...columns];
    result.splice(actionIndex < 0 ? columns.length : actionIndex, 0, next);
    updateColumns(result);
  }
  async function saveTemplate(): Promise<void> {
    if (!templateName.trim() || busy || dirty) return;
    setBusy(true);
    setTemplateError('');
    try {
      await waitForDormitoryWrites(dormitoryId);
      const saved = await api.saveStructureTemplate(dormitoryId, templateName.trim());
      setTemplates((current) => [...current, saved]);
      setTemplateName('');
      setMessage('Независимый шаблон сохранён');
    } catch (caught) {
      setTemplateError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  async function removeTemplate(id: number): Promise<void> {
    setBusy(true);
    setTemplateError('');
    try {
      await api.deleteStructureTemplate(id);
      setTemplates((current) => current.filter((item) => item.id !== id));
      setDeleteTemplate(null);
    } catch (caught) {
      setTemplateError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  function tree(parent: string | null): JSX.Element[] {
    return nodes
      .filter((item) => item.parent === parent)
      .flatMap((item) => {
        const path = ancestors(item);
        const matches =
          !query ||
          path.some((entry) =>
            entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          ) ||
          nodes.some(
            (entry) =>
              ancestors(entry).some((ancestor) => ancestor.key === item.key) &&
              entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          );
        return [
          ...(matches
            ? [
                <button
                  key={item.key}
                  type="button"
                  className={styles.treeItem}
                  style={{ paddingLeft: 12 + (path.length - 1) * 18 }}
                  aria-pressed={selected === item.key}
                  onClick={() => {
                    setSelected(item.key);
                    setConfirmDelete(false);
                  }}
                >
                  <span>{item.name}</span>
                  <small>
                    {item.status === 'hidden'
                      ? 'Скрыта'
                      : item.status === 'deleted'
                        ? 'Удалена'
                        : `${(tables[item.key] ?? []).filter((column) => !column.archived && column.kind !== 'action').length || '—'}`}
                  </small>
                </button>,
              ]
            : []),
          ...tree(item.key),
        ];
      });
  }

  return (
    <Modal
      title="Настройки общежития"
      onClose={close}
      closeDisabled={busy}
      panelClassName={styles.panel}
      containerClassName={styles.overlay}
      testId="dormitory-settings-modal"
    >
      {binding ? (
        <BindingDialog
          inline
          dormitoryId={dormitoryId}
          tableKey={binding}
          onBusyChange={setBusy}
          onClose={() => setBinding(null)}
          onSaved={() => {
            setBinding(null);
            if (snapshot) onChanged(snapshot);
            setMessage('Связь с персоналом сохранена');
          }}
        />
      ) : creating ? (
        <CreateCustomTabDialog
          inline
          onBusyChange={setBusy}
          dormitoryId={dormitoryId}
          parentId={
            creating.parent?.startsWith('custom_') ? Number(creating.parent.slice(7)) : null
          }
          parentSection={
            creating.parent && !creating.parent.startsWith('custom_') ? creating.parent : null
          }
          onClose={() => setCreating(null)}
          onCreated={(tab) => {
            setCreating(null);
            setSelected(tab.table_key);
            setAttempt((value) => value + 1);
            void api
              .dormitorySettings(dormitoryId)
              .then(onChanged)
              .catch((caught: unknown) => setError(errorText(caught)));
          }}
        />
      ) : (
        <div className={styles.shell}>
          <div className={styles.pages} role="tablist" aria-label="Настройки общежития">
            {(
              [
                ['structure', 'Вкладки и таблицы'],
                ['links', 'Связи отчёта'],
                ['templates', 'Шаблоны'],
              ] as const
            ).map(([key, label]) => (
              <button
                role="tab"
                aria-selected={page === key}
                key={key}
                type="button"
                onClick={() => {
                  setPage(key);
                  setEditingRule(null);
                }}
                disabled={busy}
              >
                {label}
              </button>
            ))}
          </div>
          {!snapshot && !error && <p role="status">Загружаем структуру…</p>}
          {snapshot && page === 'structure' && (
            <div className={styles.workspace}>
              <aside className={styles.sidebar}>
                <input
                  aria-label="Найти вкладку"
                  placeholder="Найти вкладку…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className={styles.tree}>{tree(null)}</div>
                <button
                  className={styles.add}
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => setCreating({ parent: null })}
                >
                  + Добавить вкладку
                </button>
                {dirty && <small>Сохраните изменения, чтобы добавлять вкладки по образцу.</small>}
              </aside>
              <main className={styles.editor}>
                {node ? (
                  <>
                    <p className={styles.breadcrumb}>
                      {ancestors(node)
                        .map((item) => item.name)
                        .join(' / ')}
                    </p>
                    <div className={styles.editorHeading}>
                      <div>
                        <h3>{node.name}</h3>
                        <p>
                          {
                            columns.filter((column) => !column.archived && column.kind !== 'action')
                              .length
                          }{' '}
                          столбцов данных · {node.custom ? 'Своя вкладка' : 'Стандартная вкладка'}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={dirty || busy || node.status === 'deleted'}
                        onClick={() => onOpen(selected)}
                      >
                        Открыть таблицу ↗
                      </button>
                    </div>
                    <fieldset disabled={busy} className={styles.nodeSettings}>
                      {node.custom && (
                        <label>
                          Название вкладки
                          <input
                            value={node.name}
                            maxLength={120}
                            onChange={(event) => updateNode({ name: event.target.value })}
                          />
                        </label>
                      )}
                      <div className={styles.toolbar}>
                        <button
                          type="button"
                          onClick={() =>
                            updateNode({ status: node.status === 'active' ? 'hidden' : 'active' })
                          }
                        >
                          {node.status === 'deleted'
                            ? 'Добавить обратно'
                            : node.status === 'hidden'
                              ? 'Восстановить вкладку'
                              : 'Скрыть вкладку'}
                        </button>
                        {node.status !== 'deleted' && (
                          <button
                            type="button"
                            disabled={!!node.reason}
                            title={node.reason ?? undefined}
                            onClick={() =>
                              confirmDelete
                                ? updateNode({ status: 'deleted' })
                                : setConfirmDelete(true)
                            }
                          >
                            {confirmDelete
                              ? 'Подтвердить удаление вкладки'
                              : 'Удалить пустую вкладку'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={blocked || dirty}
                          onClick={() => setCreating({ parent: selected })}
                        >
                          + Подвкладка
                        </button>
                      </div>
                      {node.reason && (
                        <p className={styles.hint}>
                          {node.reason} Можно скрыть вкладку: данные продолжат учитываться в отчёте.
                        </p>
                      )}
                      {confirmDelete && (
                        <p className={styles.warning}>
                          Вкладка и её подвкладки будут удалены. Подтвердите действие кнопкой выше.
                        </p>
                      )}
                    </fieldset>
                    {blocked && (
                      <p className={styles.warning}>
                        Вкладка или её родитель скрыты либо удалены. Восстановите их перед
                        изменением таблицы.
                      </p>
                    )}
                    {node.custom && (
                      <CustomTabOptionsEditor
                        value={node.options ?? defaultTabOptions}
                        onChange={(options) => updateNode({ options })}
                        columns={columns}
                        dateColumnName={node.dateColumnName}
                        onDateColumnName={(dateColumnName) => updateNode({ dateColumnName })}
                        disabled={blocked || busy}
                      />
                    )}
                    {selected in tables ? (
                      <fieldset disabled={busy || blocked} className={styles.columnEditor}>
                        <div className={styles.columnHeading}>
                          <h4>Столбцы таблицы</h4>
                          <span>Название · формат · порядок</span>
                        </div>
                        {(selected === 'archive' || node.custom) && (
                          <div className={styles.toolbar} style={{ marginBottom: 14 }}>
                            <button
                              type="button"
                              disabled={dirty}
                              onClick={() => setBinding(selected as SourceTable)}
                            >
                              Связь с персоналом
                            </button>
                            {dirty && (
                              <small>
                                Сохраните изменения, чтобы настроить связь с персоналом.
                              </small>
                            )}
                          </div>
                        )}
                        {!columns.length && (
                          <p className={styles.empty}>
                            Таблица ещё не создана. Добавьте столбцы и сохраните изменения.
                          </p>
                        )}
                        {columns.map((column, index) => (
                          <div
                            className={`${styles.column} ${column.archived ? styles.archived : ''}`}
                            key={column.local}
                          >
                            <div className={styles.columnLine}>
                              <span className={styles.index}>{index + 1}</span>
                              <input
                                aria-label={`Название столбца ${index + 1}`}
                                value={column.name}
                                maxLength={120}
                                placeholder="Название столбца"
                                disabled={column.archived}
                                onChange={(event) =>
                                  changeColumn(column.local, { name: event.target.value })
                                }
                              />
                              <select
                                aria-label={`Формат столбца ${index + 1}`}
                                value={column.kind}
                                disabled={!!column.id || column.archived}
                                onChange={(event) =>
                                  changeColumn(column.local, {
                                    kind: event.target.value as ColumnKind,
                                    options:
                                      event.target.value === 'select'
                                        ? [{ id: null, label: '', archived: false }]
                                        : [],
                                  })
                                }
                              >
                                {Object.entries(columnKinds)
                                  .filter(
                                    ([kind]) => !!column.id || !['action', 'hostel'].includes(kind),
                                  )
                                  .map(([kind, label]) => (
                                    <option key={kind} value={kind}>
                                      {label}
                                    </option>
                                  ))}
                              </select>
                              <div className={styles.columnActions}>
                                <button
                                  type="button"
                                  aria-label={`Выше: ${column.name}`}
                                  disabled={!index}
                                  onClick={() => {
                                    const next = [...columns];
                                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                    updateColumns(next);
                                  }}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Ниже: ${column.name}`}
                                  disabled={index === columns.length - 1}
                                  onClick={() => {
                                    const next = [...columns];
                                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                                    updateColumns(next);
                                  }}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  disabled={!column.archived && column.used_by.length > 0}
                                  title={
                                    column.used_by.length
                                      ? `Связи отчёта: ${column.used_by.join(', ')}`
                                      : undefined
                                  }
                                  onClick={() =>
                                    column.id
                                      ? changeColumn(column.local, { archived: !column.archived })
                                      : updateColumns(
                                          columns.filter((item) => item.local !== column.local),
                                        )
                                  }
                                >
                                  {column.archived ? 'Вернуть' : 'Убрать'}
                                </button>
                              </div>
                            </div>
                            {!!column.used_by.length && (
                              <small className={styles.dependency}>
                                ↗ Используется в отчёте: {column.used_by.join(', ')}
                              </small>
                            )}
                            {column.kind === 'action' &&
                              column.builtin_key?.startsWith('action_') && (
                                <small className={styles.hint}>
                                  Действие с записью. В таблице находится в меню «Действия».
                                </small>
                              )}
                            {column.kind === 'select' && !column.archived && (
                              <fieldset disabled={!!column.builtin_key} className={styles.options}>
                                <legend>Варианты списка</legend>
                                {column.options.map((option, optionIndex) => (
                                  <div key={option.id ?? optionIndex}>
                                    <input
                                      aria-label={`Вариант ${optionIndex + 1} столбца ${index + 1}`}
                                      value={option.label}
                                      maxLength={120}
                                      onChange={(event) =>
                                        changeColumn(column.local, {
                                          options: column.options.map((item, i) =>
                                            i === optionIndex
                                              ? { ...item, label: event.target.value }
                                              : item,
                                          ),
                                        })
                                      }
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        changeColumn(column.local, {
                                          options: option.id
                                            ? column.options.map((item, i) =>
                                                i === optionIndex
                                                  ? { ...item, archived: !item.archived }
                                                  : item,
                                              )
                                            : column.options.filter((_, i) => i !== optionIndex),
                                        })
                                      }
                                    >
                                      {option.archived
                                        ? 'Вернуть вариант'
                                        : option.id
                                          ? 'В архив'
                                          : 'Убрать вариант'}
                                    </button>
                                    {option.archived && <small>В архиве</small>}
                                  </div>
                                ))}
                                <button
                                  type="button"
                                  disabled={column.options.length >= 200}
                                  onClick={() =>
                                    changeColumn(column.local, {
                                      options: [
                                        ...column.options,
                                        { id: null, label: '', archived: false },
                                      ],
                                    })
                                  }
                                >
                                  + Вариант
                                </button>
                              </fieldset>
                            )}
                          </div>
                        ))}
                        <button className={styles.add} type="button" onClick={addColumn}>
                          + Добавить столбец
                        </button>
                        <p className={styles.hint}>
                          Тип существующего столбца сохраняется вместе с данными. Убранные столбцы
                          можно вернуть; значения останутся на месте.
                        </p>
                      </fieldset>
                    ) : (
                      <p className={styles.empty}>
                        В этом разделе таблица настраивается в самом разделе. Подвкладки можно
                        добавлять здесь.
                      </p>
                    )}
                  </>
                ) : (
                  <p>Выберите вкладку слева.</p>
                )}
              </main>
            </div>
          )}
          {snapshot && page === 'links' && (
            <main className={styles.fullPage}>
              <div className={styles.editorHeading}>
                <div>
                  <h3>Как заполняется общий отчёт</h3>
                  <p>Каждое правило считает значения отдельно за каждую дату.</p>
                </div>
                <button
                  type="button"
                  disabled={dirty || busy}
                  onClick={() => setEditingRule('new')}
                >
                  + Строка отчёта
                </button>
              </div>
              {dirty && (
                <p className={styles.warning}>
                  Сохраните изменения структуры перед настройкой связей.
                </p>
              )}
              {editingRule ? (
                <RowDialog
                  inline
                  onBusyChange={setBusy}
                  dormitoryId={dormitoryId}
                  row={editingRule === 'new' ? null : editingRule}
                  rows={rules}
                  onClose={() => setEditingRule(null)}
                  onChanged={() => {
                    setAttempt((value) => value + 1);
                    void api
                      .dormitorySettings(dormitoryId)
                      .then(onChanged)
                      .catch((caught: unknown) => setError(errorText(caught)));
                  }}
                />
              ) : (
                rules.map((row) => (
                  <article className={styles.rule} key={row.id}>
                    <div>
                      <h4>{row.name}</h4>
                      <RuleSummary row={row} settings={snapshot} />
                    </div>
                    <div className={styles.toolbar}>
                      {row.link && (
                        <button
                          type="button"
                          disabled={dirty}
                          onClick={() => onOpen(row.link!.table_key)}
                        >
                          К источнику ↗
                        </button>
                      )}
                      <button type="button" disabled={dirty} onClick={() => setEditingRule(row)}>
                        Настроить
                      </button>
                    </div>
                  </article>
                ))
              )}
            </main>
          )}
          {snapshot && page === 'templates' && (
            <main className={styles.fullPage}>
              <h3>Библиотека структур</h3>
              <p className={styles.hint}>
                Шаблон хранит вкладки, столбцы, списки, формулы и связи на момент сохранения. Записи
                и дневные значения не копируются. Исходное общежитие и новые копии меняются
                независимо.
              </p>
              <div className={styles.templateSave}>
                <label>
                  Название нового шаблона
                  <input
                    value={templateName}
                    maxLength={120}
                    placeholder="Например, Рабочее общежитие"
                    onChange={(event) => setTemplateName(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!templateName.trim() || dirty || busy}
                  onClick={() => void saveTemplate()}
                >
                  Сохранить структуру
                </button>
              </div>
              {dirty && <p className={styles.warning}>Сначала сохраните изменения структуры.</p>}
              {templateError && <p role="alert">{templateError}</p>}
              {!templates.length && <p className={styles.empty}>Сохранённых структур пока нет.</p>}
              {templates.map((template) => (
                <article className={styles.rule} key={template.id}>
                  <div>
                    <h4>{template.name}</h4>
                    <p>
                      {template.tab_count} вкладок ·{' '}
                      {new Date(template.created_at).toLocaleDateString('ru')}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      deleteTemplate === template.id
                        ? void removeTemplate(template.id)
                        : setDeleteTemplate(template.id)
                    }
                  >
                    {deleteTemplate === template.id
                      ? 'Подтвердить удаление шаблона'
                      : 'Удалить шаблон'}
                  </button>
                </article>
              ))}
              <p className={styles.hint}>
                При создании общежития выберите «По образцу» и сохранённый шаблон. Структуру
                отдельной вкладки можно взять из другого общежития через «Добавить вкладку».
              </p>
            </main>
          )}
          <footer className={styles.footer}>
            <div>
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                  {
                    <button
                      type="button"
                      onClick={() =>
                        dirty ? setConfirmReload(true) : setAttempt((value) => value + 1)
                      }
                    >
                      {!snapshot ? 'Повторить' : 'Обновить настройки'}
                    </button>
                  }
                </p>
              )}
              {message && <p role="status">{message}</p>}
              {dirty && <span className={styles.unsaved}>Есть несохранённые изменения</span>}
            </div>
            <div className={styles.toolbar}>
              <button type="button" disabled={busy} onClick={close}>
                Закрыть
              </button>
              <button
                className={styles.primary}
                type="button"
                disabled={!dirty || busy}
                onClick={() => void save()}
              >
                {busy ? 'Сохраняем…' : 'Сохранить изменения'}
              </button>
            </div>
          </footer>
          {confirmClose && (
            <div className={styles.leave} role="alert">
              <span>Изменения ещё не сохранены.</span>
              <button type="button" onClick={() => setConfirmClose(false)}>
                Продолжить настройку
              </button>
              <button type="button" onClick={onClose}>
                Закрыть без сохранения
              </button>
            </div>
          )}
          {confirmReload && (
            <div className={styles.leave} role="alert">
              <span>При обновлении несохранённые изменения будут отменены.</span>
              <button type="button" onClick={() => setConfirmReload(false)}>
                Продолжить настройку
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmReload(false);
                  setAttempt((value) => value + 1);
                }}
              >
                Отменить изменения и обновить
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
