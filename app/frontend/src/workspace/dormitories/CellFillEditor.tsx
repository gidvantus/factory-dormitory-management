import type { CellFillConfig, CellFillSource, ColumnKind } from '../../api/client';
import { cellFillError } from './cellFill';
import type { FillColumn } from './cellFill';
import s from './CellFill.module.css';
export function CellFillEditor({
  value,
  kind,
  columnId,
  columns,
  sources,
  table,
  disabled = false,
  onChange,
}: {
  value: CellFillConfig | null | undefined;
  kind: ColumnKind;
  columnId?: number;
  columns: FillColumn[];
  sources: CellFillSource[];
  table: string;
  disabled?: boolean;
  onChange: (value: CellFillConfig | null) => void;
}): JSX.Element {
  const choices = sources.filter((source) => source.key !== table);
  const source = choices.find((item) => item.key === value?.source);
  const fields = source?.fields.filter((field) => field.kind === kind) ?? [];
  const selectors = columns.filter(
    (col) =>
      !col.archived &&
      col.id !== columnId &&
      col.fill?.mode === 'pick' &&
      col.fill.source === value?.source,
  );
  const error = value ? cellFillError(value, kind, columns, choices) : '';
  function mode(next: 'manual' | 'pick' | 'lookup'): void {
    if (next === 'manual') {
      onChange(null);
      return;
    }
    const selector = columns.find(
      (col) => !col.archived && col.id !== columnId && col.fill?.mode === 'pick',
    );
    const target =
      choices.find(
        (item) => item.key === (next === 'lookup' ? selector?.fill?.source : value?.source),
      ) ??
      choices.find((item) => item.key === 'residents') ??
      choices[0];
    onChange({
      mode: next,
      source: target?.key ?? 'personnel',
      field:
        target?.fields.find((item) => item.kind === kind && /фио/i.test(item.name))?.id ??
        target?.fields.find((item) => item.kind === kind)?.id ??
        '',
      match_column_id: next === 'lookup' ? (selector?.id ?? null) : null,
      update: 'live',
    });
  }
  return (
    <fieldset disabled={disabled} className={s.editor}>
      <legend>Как заполнять ячейки</legend>
      <div className={s.modes}>
        {(
          [
            ['manual', 'Вручную'],
            ...(kind === 'text' ? [['pick', 'Выбор записи']] : []),
            ['lookup', 'Из другой таблицы'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="btn btn--choice btn--compact"
            aria-pressed={(value?.mode ?? 'manual') === key}
            onClick={() => mode(key as 'manual' | 'pick' | 'lookup')}
          >
            {label}
          </button>
        ))}
      </div>
      {!value ? (
        <p className={s.help}>Значения вводятся отдельно в каждой строке.</p>
      ) : (
        <>
          <label>
            Таблица-источник
            <select
              value={source ? value.source : ''}
              required
              onChange={(event) => {
                const target = choices.find((item) => item.key === event.target.value)!;
                onChange({
                  ...value,
                  source: target.key,
                  field: target.fields.find((item) => item.kind === kind)?.id ?? '',
                  match_column_id:
                    value.mode === 'lookup'
                      ? (columns.find(
                          (col) =>
                            !col.archived &&
                            col.fill?.mode === 'pick' &&
                            col.fill.source === target.key,
                        )?.id ?? null)
                      : null,
                });
              }}
            >
              <option value="" disabled>
                Выберите таблицу
              </option>
              {choices.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {value.mode === 'pick'
              ? 'Показывать в списке значение столбца'
              : 'Взять значение из столбца'}
            <select
              value={fields.some((item) => item.id === value.field) ? value.field : ''}
              required
              onChange={(event) => onChange({ ...value, field: event.target.value })}
            >
              <option value="" disabled>
                Выберите столбец
              </option>
              {fields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </select>
          </label>
          {value.mode === 'lookup' ? (
            <>
              <label>
                Запись выбрать в столбце
                <select
                  value={
                    selectors.some((col) => col.id === value.match_column_id)
                      ? String(value.match_column_id)
                      : ''
                  }
                  required
                  onChange={(event) =>
                    onChange({ ...value, match_column_id: Number(event.target.value) })
                  }
                >
                  <option value="" disabled>
                    Выберите столбец
                  </option>
                  {selectors.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name || 'Новый столбец'}
                    </option>
                  ))}
                </select>
              </label>
              {!selectors.length && (
                <p className={s.help}>
                  Сначала добавьте текстовый столбец со способом «Выбор записи» из этой же таблицы.
                </p>
              )}
              <label>
                Если данные в источнике изменятся
                <select
                  value={value.update}
                  onChange={(event) =>
                    onChange({ ...value, update: event.target.value as 'live' | 'copy' })
                  }
                >
                  <option value="live">Обновлять автоматически</option>
                  <option value="copy">Скопировать один раз</option>
                </select>
              </label>
              <p className={s.help}>
                {value.update === 'copy'
                  ? 'Копия создаётся при выборе записи или изменении правила. Затем не меняется вслед за источником.'
                  : 'Связанные значения обновляются при открытии таблицы, возвращении в окно и каждые 30 секунд.'}{' '}
                Связанные ячейки доступны для чтения.
              </p>
            </>
          ) : (
            <p className={s.help}>
              Выберите запись в ячейке. Другие столбцы смогут взять данные из той же записи.
              Совпадающие имена различаются по номеру записи.
            </p>
          )}
          {error && <p className={s.error}>{error}</p>}
        </>
      )}
      <p className={s.help}>Ручные значения сохранятся при переключении способа заполнения.</p>
    </fieldset>
  );
}
