import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { ColumnInput, ColumnKind, CustomTab } from '../../api/client';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { useEditorPreview } from '../../components/EditorSurface';
import { EditorSection } from '../../components/EditorSection';
import { useOrganizedEditor } from '../../components/useOrganizedEditor';
import { columnKinds } from './columnKinds';
import formStyles from './ConfigurableColumns.module.css';
import styles from './CreateTableDialog.module.css';
import { CellFillEditor } from './CellFillEditor';
import { cellFillError, supportsCellFill, useCellFillSources } from './cellFill';
import { ColumnArchiveTabs } from '../../components/ColumnArchiveTabs';

interface DraftColumn extends ColumnInput {
  key: number;
}
function emptyColumn(key: number): DraftColumn {
  return { key, name: '', kind: 'text', options: [{ id: null, label: '', archived: false }] };
}
function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

export function CreateTableDialog({
  dormitoryId,
  tab,
  onClose,
  onCreated,
}: {
  dormitoryId: string;
  tab: CustomTab;
  onClose: () => void;
  onCreated: (tab: CustomTab) => void;
}): JSX.Element {
  const organized = useOrganizedEditor();
  const id = useId();
  const nextKey = useRef(1);
  const [columns, setColumns] = useState<DraftColumn[]>([emptyColumn(0)]);
  const [archivedDrafts, setArchivedDrafts] = useState<DraftColumn[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const fillSources = useCellFillSources(dormitoryId);
  const fillColumns = columns.map((column) => ({ ...column, id: -(column.key + 1) }));
  useEditorPreview('create-table', { columns });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  function update(key: number, patch: Partial<ColumnInput>): void {
    setColumns((current) =>
      current.map((column) => (column.key === key ? { ...column, ...patch } : column)),
    );
    setError('');
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving || !columns.length) return;
    const names = new Set(['удалить']);
    for (const [index, column] of columns.entries()) {
      const name = normalized(column.name);
      let message = '';
      if (!name) message = 'укажите название.';
      else if (names.has(name)) message = 'это название уже используется в таблице.';
      names.add(name);
      if (!message && column.kind === 'select') {
        const labels = column.options.map((option) => normalized(option.label));
        if (!labels.length || labels.some((label) => !label))
          message = 'заполните хотя бы один вариант списка.';
        else if (new Set(labels).size !== labels.length)
          message = 'варианты списка не должны повторяться.';
      }
      if (message) {
        setError(`Столбец ${index + 1}: ${message}`);
        return;
      }
      const fillError = cellFillError(column.fill, column.kind, fillColumns, fillSources.sources);
      if (fillError) {
        setError(`Столбец ${index + 1}: ${fillError}`);
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      const hasFill = columns.some((column) => column.fill);
      const payload = columns.map(({ key, name, kind, options, fill }) => ({
        name: name.trim(),
        kind,
        options:
          kind === 'select'
            ? options.map((option) => ({ ...option, label: option.label.trim() }))
            : [],
        ...(hasFill ? { client_id: -(key + 1), fill: fill ?? null } : {}),
      }));
      const updated = await api.createCustomTabTable(dormitoryId, tab.id, payload);
      onCreated(updated);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось создать таблицу.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="Создать таблицу"
      testId="create-table-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className={formStyles.form} onSubmit={(event) => void submit(event)}>
        <p className={formStyles.help}>
          Добавьте нужные столбцы и выберите тип данных для каждого. После создания таблицы столбцы
          можно будет добавлять и удалять.
        </p>
        <EditorSection
          title="Столбцы таблицы"
          description="У каждого столбца — название и тип. Порядок карточек определяет порядок в таблице."
        >
          <ColumnArchiveTabs
            archived={showArchived}
            onChange={setShowArchived}
            currentCount={columns.length}
            archivedCount={archivedDrafts.length}
          />
          {showArchived && (
            <div className={styles.columns}>
              {!archivedDrafts.length && (
                <p className={formStyles.help}>Архивных столбцов пока нет.</p>
              )}
              {archivedDrafts.map((column) => (
                <div key={column.key} className={styles.heading}>
                  <span>{column.name || 'Новый столбец'}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    disabled={saving}
                    onClick={() => {
                      setColumns((current) => [...current, column]);
                      setArchivedDrafts((current) =>
                        current.filter((item) => item.key !== column.key),
                      );
                    }}
                  >
                    Восстановить столбец
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={styles.columns} hidden={showArchived}>
            {fillSources.loading && <p role="status">Загружаем источники заполнения…</p>}
            {fillSources.error && (
              <p className={formStyles.help}>
                {fillSources.error}{' '}
                <button className="link-button" type="button" onClick={fillSources.retry}>
                  Повторить
                </button>
              </p>
            )}
            {columns.map((column, index) => (
              <fieldset
                className={styles.column}
                key={column.key}
                disabled={saving}
                aria-labelledby={`${id}-${column.key}`}
              >
                <div className={styles.heading}>
                  <h3 id={`${id}-${column.key}`}>
                    {organized
                      ? `${index + 1}. ${column.name || 'Новый столбец'}`
                      : `Столбец ${index + 1}`}
                  </h3>
                  {organized && (
                    <div>
                      <button
                        type="button"
                        className="btn btn--ghost btn--compact"
                        aria-label={`Поднять столбец ${index + 1}`}
                        disabled={saving || index === 0}
                        onClick={() =>
                          setColumns((current) => {
                            const next = [...current];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            return next;
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--compact"
                        aria-label={`Опустить столбец ${index + 1}`}
                        disabled={saving || index === columns.length - 1}
                        onClick={() =>
                          setColumns((current) => {
                            const next = [...current];
                            [next[index + 1], next[index]] = [next[index], next[index + 1]];
                            return next;
                          })
                        }
                      >
                        ↓
                      </button>
                    </div>
                  )}
                  <button
                    className={`btn btn--danger btn--compact ${styles.remove}`}
                    type="button"
                    aria-label={`Удалить столбец ${index + 1}`}
                    onClick={() => {
                      setArchivedDrafts((current) => [...current, column]);
                      setColumns((current) => current.filter((item) => item.key !== column.key));
                      setError('');
                    }}
                  >
                    Удалить
                  </button>
                </div>
                <div className={styles.fields}>
                  <label>
                    Название столбца
                    <input
                      value={column.name}
                      maxLength={120}
                      required
                      onChange={(event) => update(column.key, { name: event.target.value })}
                    />
                  </label>
                  <label>
                    Тип столбца
                    <select
                      value={column.kind}
                      onChange={(event) =>
                        update(column.key, { kind: event.target.value as ColumnKind, fill: null })
                      }
                    >
                      {Object.entries(columnKinds)
                        .filter(([key]) => !['action', 'hostel'].includes(key))
                        .map(([kind, label]) => (
                          <option value={kind} key={kind}>
                            {label}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                {supportsCellFill(column.kind) && (
                  <CellFillEditor
                    value={column.fill}
                    kind={column.kind}
                    columnId={-(column.key + 1)}
                    columns={fillColumns}
                    sources={fillSources.sources}
                    table={tab.table_key}
                    disabled={saving || fillSources.loading}
                    onChange={(fill) => update(column.key, { fill })}
                  />
                )}
                {column.kind === 'select' && (
                  <fieldset className={formStyles.options}>
                    <legend>Варианты списка</legend>
                    {column.options.map((option, optionIndex) => (
                      <div className={formStyles.option} key={optionIndex}>
                        <input
                          aria-label={`Вариант ${optionIndex + 1}`}
                          value={option.label}
                          maxLength={120}
                          required
                          onChange={(event) =>
                            update(column.key, {
                              options: column.options.map((item, i) =>
                                i === optionIndex ? { ...item, label: event.target.value } : item,
                              ),
                            })
                          }
                        />
                        <button
                          className="btn btn--ghost btn--compact"
                          type="button"
                          aria-label={`Удалить вариант ${optionIndex + 1}`}
                          onClick={() =>
                            update(column.key, {
                              options: column.options.filter((_, i) => i !== optionIndex),
                            })
                          }
                        >
                          Убрать
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn btn--ghost btn--compact"
                      type="button"
                      disabled={column.options.length >= 200}
                      onClick={() =>
                        update(column.key, {
                          options: [...column.options, { id: null, label: '', archived: false }],
                        })
                      }
                    >
                      + Вариант
                    </button>
                  </fieldset>
                )}
              </fieldset>
            ))}
            {!columns.length && <p className={formStyles.help}>Добавьте хотя бы один столбец.</p>}
          </div>
          <div>
            <button
              type="button"
              className={`btn btn--ghost btn--compact ${styles.add}`}
              disabled={saving}
              onClick={() => {
                const column = emptyColumn(nextKey.current++);
                setShowArchived(false);
                setColumns((current) => [...current, column]);
                setError('');
              }}
            >
              + Добавить столбец
            </button>
          </div>
        </EditorSection>
        {error && (
          <p role="alert" className={formStyles.error}>
            {error}
          </p>
        )}
        <div className={formStyles.actions}>
          <ModalCancelButton
            className="btn btn--ghost btn--compact"
            onClick={onClose}
            type="button"
            disabled={saving}
          >
            Отмена
          </ModalCancelButton>
          <button
            className="btn btn--primary btn--compact"
            type="submit"
            disabled={saving || !columns.length}
          >
            {saving ? 'Создаём…' : 'Создать таблицу'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
