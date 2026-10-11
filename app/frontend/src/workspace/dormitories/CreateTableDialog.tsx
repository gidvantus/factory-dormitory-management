import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { ColumnInput, ColumnKind, CustomTab } from '../../api/client';
import { Modal } from '../../components/Modal';
import { columnKinds } from './columnKinds';
import formStyles from './ConfigurableColumns.module.css';
import styles from './CreateTableDialog.module.css';

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
  const id = useId();
  const nextKey = useRef(1);
  const [columns, setColumns] = useState<DraftColumn[]>([emptyColumn(0)]);
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
    }
    setSaving(true);
    setError('');
    try {
      const payload = columns.map(({ name, kind, options }) => ({
        name: name.trim(),
        kind,
        options:
          kind === 'select'
            ? options.map((option) => ({ ...option, label: option.label.trim() }))
            : [],
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
        <div className={styles.columns}>
          {columns.map((column, index) => (
            <fieldset
              className={styles.column}
              key={column.key}
              disabled={saving}
              aria-labelledby={`${id}-${column.key}`}
            >
              <div className={styles.heading}>
                <h3 id={`${id}-${column.key}`}>Столбец {index + 1}</h3>
                <button
                  className={styles.remove}
                  type="button"
                  aria-label={`Удалить столбец ${index + 1}`}
                  onClick={() => {
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
                      update(column.key, { kind: event.target.value as ColumnKind })
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
            className={styles.add}
            disabled={saving}
            onClick={() => {
              const column = emptyColumn(nextKey.current++);
              setColumns((current) => [...current, column]);
              setError('');
            }}
          >
            + Добавить столбец
          </button>
        </div>
        {error && (
          <p role="alert" className={formStyles.error}>
            {error}
          </p>
        )}
        <div className={formStyles.actions}>
          <button type="button" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={saving || !columns.length}>
            {saving ? 'Создаём…' : 'Создать таблицу'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
