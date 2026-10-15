import type { CustomTabOptions } from '../../api/client';
import styles from './CustomTabOptionsEditor.module.css';

export function CustomTabOptionsEditor({
  value,
  onChange,
  columns,
  dateColumnName,
  onDateColumnName,
  disabled = false,
}: {
  value: CustomTabOptions;
  onChange: (value: CustomTabOptions) => void;
  columns?: { id?: number; name: string; kind: string; archived: boolean }[];
  dateColumnName?: string | null;
  onDateColumnName?: (name: string | null) => void;
  disabled?: boolean;
}): JSX.Element {
  function patch(next: Partial<CustomTabOptions>): void {
    if (next.period_mode === 'none' || next.table_format === 'calendar') {
      next.date_column_id = null;
      onDateColumnName?.(null);
    }
    onChange({ ...value, ...next });
  }
  const dates = columns?.filter((col) => col.kind === 'date' && !col.archived);
  return (
    <fieldset className={styles.editor} disabled={disabled}>
      <legend>Возможности вкладки</legend>
      <div className={styles.selects}>
        <label>
          Формат таблицы
          <select
            aria-label="Формат таблицы"
            value={value.table_format}
            onChange={(event) =>
              patch({
                table_format: event.target.value as CustomTabOptions['table_format'],
                ...(event.target.value === 'calendar' && value.period_mode === 'none'
                  ? { period_mode: 'month' }
                  : {}),
              })
            }
          >
            <option value="list">Обычная таблица</option>
            <option value="calendar">Даты в столбцах, как в общем отчёте</option>
          </select>
        </label>
        <label>
          Выбор периода
          <select
            aria-label="Выбор периода"
            value={value.period_mode}
            onChange={(event) =>
              patch({ period_mode: event.target.value as CustomTabOptions['period_mode'] })
            }
          >
            {value.table_format === 'list' && <option value="none">Без периода</option>}
            <option value="range">Диапазон дат</option>
            <option value="month">Переключение месяцев</option>
          </select>
        </label>
        {value.table_format === 'list' && value.period_mode !== 'none' && dates && (
          <label>
            Столбец для фильтрации
            <select
              aria-label="Столбец для фильтрации"
              value={dateColumnName ? `name:${dateColumnName}` : (value.date_column_id ?? '')}
              onChange={(event) => {
                const selected = event.target.value;
                onDateColumnName?.(selected.startsWith('name:') ? selected.slice(5) : null);
                patch({
                  date_column_id:
                    selected && !selected.startsWith('name:') ? Number(selected) : null,
                });
              }}
            >
              <option value="">Выберите столбец даты</option>
              {dates.map((col, index) => (
                <option key={col.id ?? index} value={col.id ?? `name:${col.name}`}>
                  {col.name || 'Новый столбец даты'}
                </option>
              ))}
            </select>
            {!dates.length && (
              <small>Добавьте ниже столбец типа «Дата», затем выберите его здесь.</small>
            )}
          </label>
        )}
      </div>
      <div className={styles.checks}>
        {(
          [
            ['add_row', 'Добавить строку'],
            ['clear_list', 'Очистить список'],
            ['row_actions', 'Действия со строкой — удаление'],
            ...(value.table_format === 'list' ? [['show_dates', 'Показывать столбцы дат']] : []),
          ] as [keyof CustomTabOptions, string][]
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={!!value[key]}
              onChange={(event) => patch({ [key]: event.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <p className={styles.hint}>
        {value.table_format === 'calendar'
          ? 'Строки — ваши показатели, столбцы — дни выбранного периода. Значения вводятся вручную.'
          : value.period_mode === 'none'
            ? 'Показываются все строки за всё время.'
            : columns
              ? 'Период отбирает строки по выбранному столбцу. Строки без даты в период не попадают.'
              : 'Будет создан столбец «Дата» для фильтрации. Остальные столбцы можно настроить после создания.'}{' '}
        Настройки можно изменить позже. Сохранённые значения останутся на месте.
      </p>
    </fieldset>
  );
}
