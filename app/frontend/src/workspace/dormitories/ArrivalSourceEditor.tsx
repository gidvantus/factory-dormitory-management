import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { CustomTabOptions } from '../../api/client';
import { EditorSection } from '../../components/EditorSection';
import styles from './CustomTabOptionsEditor.module.css';

export interface SourceColumn {
  id?: number;
  name: string;
  kind: string;
  archived: boolean;
}
const basicFields = [
  { id: 'full_name', label: 'ФИО', kind: 'text' },
  { id: 'date', label: 'Дата заезда', kind: 'date' },
  { id: 'status', label: 'Статус', kind: 'text' },
];
export function SourceChoice({
  value,
  onChange,
  columns,
}: {
  value: CustomTabOptions;
  onChange: (value: CustomTabOptions) => void;
  columns?: SourceColumn[];
}): JSX.Element {
  return (
    <EditorSection
      title="Источник строк"
      description="Вводите записи вручную или показывайте актуальный план заездов этого общежития."
    >
      <div className={styles.selects}>
        <label>
          Источник данных
          <select
            aria-label="Источник данных"
            value={value.data_source ?? 'manual'}
            onChange={(event) => {
              if (event.target.value === 'manual')
                onChange({
                  ...value,
                  data_source: 'manual',
                  arrival_columns: {},
                  add_row: true,
                  row_actions: true,
                  import_enabled: true,
                });
              else {
                const mapping: Record<string, string> = {};
                for (const column of columns ?? []) {
                  const label = column.name.trim().toLocaleLowerCase('ru');
                  const source =
                    label === 'фио'
                      ? 'full_name'
                      : ['дата', 'дата заезда'].includes(label)
                        ? 'date'
                        : label === 'статус'
                          ? 'status'
                          : null;
                  if (source && !column.archived && column.kind !== 'action')
                    mapping[column.id ? String(column.id) : 'name:' + column.name] = source;
                }
                onChange({
                  ...value,
                  data_source: 'arrival_plan',
                  table_format: 'list',
                  period_mode: 'month',
                  date_column_id: null,
                  arrival_columns: mapping,
                  add_row: false,
                  clear_list: false,
                  row_actions: false,
                  import_enabled: false,
                });
              }
            }}
          >
            <option value="manual">Ручное заполнение</option>
            <option value="arrival_plan">Персонал → План заездов</option>
          </select>
        </label>
      </div>
    </EditorSection>
  );
}

export function ArrivalSourceEditor({
  dormitoryId,
  value,
  onChange,
  columns,
}: {
  dormitoryId?: string;
  value: CustomTabOptions;
  onChange: (value: CustomTabOptions) => void;
  columns?: SourceColumn[];
}): JSX.Element {
  const [fields, setFields] = useState(basicFields);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!dormitoryId) return;
    const controller = new AbortController();
    setError('');
    void api
      .arrivalSourceFields(dormitoryId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setFields(items);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof ApiError
              ? caught.message
              : 'Не удалось загрузить поля плана заездов.',
          );
      });
    return () => controller.abort();
  }, [dormitoryId, attempt]);
  const visible = columns?.filter((column) => !column.archived && column.kind !== 'action') ?? [];
  return (
    <EditorSection
      title="Поля плана заездов"
      description="Каждый человек — отдельная строка. ФИО, дата и статус обновляются из персонала; изменения выполняются в плане заездов."
    >
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" className="link-button" onClick={() => setAttempt((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {visible.length ? (
        <div className={styles.selects}>
          {visible.map((column) => {
            const key = column.id ? String(column.id) : 'name:' + column.name;
            const source =
              value.arrival_columns?.[key] ?? value.arrival_columns?.['name:' + column.name] ?? '';
            return (
              <label key={key}>
                {column.name || 'Новый столбец'}
                <select
                  aria-label={'Поле плана заездов: ' + column.name}
                  value={source}
                  onChange={(event) => {
                    const mapping = { ...value.arrival_columns };
                    delete mapping['name:' + column.name];
                    if (event.target.value) mapping[key] = event.target.value;
                    else delete mapping[key];
                    onChange({ ...value, arrival_columns: mapping });
                  }}
                >
                  <option value="">Не отображать данные</option>
                  {source && !fields.some((field) => field.id === source) && (
                    <option value={source}>Поле недоступно — выберите другое</option>
                  )}
                  {fields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ) : (
        <p className={styles.hint}>
          Будут созданы столбцы «ФИО», «Дата» и «Статус». В конструкторе можно переименовать их и
          добавить другие поля плана заездов.
        </p>
      )}
      <p className={styles.hint}>
        Показываются люди только из этого общежития. Ближайшие будущие заезды находятся сверху. При
        переносе человек перемещается к новой дате. Для подключения используйте пустую таблицу.
      </p>
    </EditorSection>
  );
}
