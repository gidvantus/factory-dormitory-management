import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type { Binding, EntryColumns, IdentityFields } from '../../api/personnel';
import s from './Personnel.module.css';

export interface EntryColumnState {
  ready: boolean;
  fields: EntryColumns;
  saving: boolean;
  dirty: boolean;
}
const roles = { full_name: 'ФИО', phone: 'Телефон' } as const;
type Role = keyof typeof roles;
const keys = Object.keys(roles) as Role[];

export function EntryColumnSettings({
  dormitoryId,
  identity,
  disabled,
  onChange,
  onSaved,
  reloadKey = 0,
}: {
  dormitoryId: string;
  identity: IdentityFields;
  disabled: boolean;
  onChange: (state: EntryColumnState) => void;
  onSaved?: () => void;
  reloadKey?: number;
}): JSX.Element {
  const [data, setData] = useState<Binding | null>(null);
  const [fields, setFields] = useState<EntryColumns>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void personnelApi
      .binding(dormitoryId, 'residents', controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setFields(result.fields);
        setDirty(false);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(
          caught instanceof ApiError ? caught.message : 'Не удалось загрузить назначение столбцов.',
        );
      });
    return () => controller.abort();
  }, [dormitoryId, attempt, reloadKey]);
  const selected = (role: Role): Binding['columns'][number] | undefined =>
    data?.columns.find((column) => column.id === fields[role]);
  const fits = (column: Binding['columns'][number], role: Role): boolean =>
    !column.has_fill &&
    (!column.builtin_key || column.builtin_key === role) &&
    (column.kind === 'text' ||
      (role === 'phone' && column.kind === 'number' && !!column.can_convert_to_text));
  const missing = keys.filter(
    (role) => identity[role]?.trim() && (!selected(role) || !fits(selected(role)!, role)),
  );
  const duplicate = !!fields.full_name && fields.full_name === fields.phone;
  const validSelections = keys.every(
    (role) => !fields[role] || (!!selected(role) && fits(selected(role)!, role)),
  );
  const ready =
    !!data &&
    !loading &&
    !saving &&
    !dirty &&
    !error &&
    !missing.length &&
    !duplicate &&
    validSelections;
  useEffect(() => {
    onChange({ ready, fields, saving, dirty });
  }, [ready, fields, saving, dirty, onChange]);
  const convertPhone = selected('phone')?.kind === 'number';
  async function save(): Promise<void> {
    if (disabled || saving || missing.length || duplicate || !validSelections) return;
    setSaving(true);
    setError('');
    try {
      await personnelApi.saveBinding(
        dormitoryId,
        'residents',
        fields as Record<string, number>,
        convertPhone,
      );
      const updated = await personnelApi.binding(dormitoryId, 'residents');
      setData(updated);
      setFields(updated.fields);
      setDirty(false);
      setEditing(false);
      onSaved?.();
    } catch (caught: unknown) {
      setError(
        caught instanceof ApiError ? caught.message : 'Не удалось сохранить назначение столбцов.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <details
      className={s.softCard}
      open={editing || !ready}
      onToggle={(event) => {
        if (ready) setEditing(event.currentTarget.open);
      }}
    >
      <summary>Куда записывать ФИО и телефон</summary>
      <p>
        Настройка сохраняется для этого общежития. Её можно изменить при следующем добавлении
        строки.
      </p>
      {loading && <p role="status">Загружаем столбцы…</p>}
      {data && (
        <>
          <div className={s.formGrid}>
            {keys.map((role) => (
              <label key={role}>
                Столбец для {role === 'full_name' ? 'ФИО' : 'телефона'}
                <select
                  disabled={disabled || saving || loading}
                  value={fields[role] ?? ''}
                  onChange={(event) => {
                    const next = { ...fields };
                    if (event.target.value) next[role] = Number(event.target.value);
                    else delete next[role];
                    setFields(next);
                    setDirty(true);
                    setError('');
                  }}
                >
                  <option value="">Выберите столбец</option>
                  {fields[role] && !selected(role) && (
                    <option value={fields[role]}>Столбец убран или недоступен</option>
                  )}
                  {data.columns
                    .filter((column) => fits(column, role))
                    .map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                        {column.kind === 'number' ? ' (число → текст)' : ''}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          {!!missing.length && (
            <p>
              Выберите столбцы для введённых данных: {missing.map((role) => roles[role]).join(', ')}
              .
            </p>
          )}
          {!validSelections && (
            <p>Ранее выбранный столбец недоступен для записи. Выберите другой.</p>
          )}
          {duplicate && <p role="alert">Для ФИО и телефона нужны разные столбцы.</p>}
          {convertPhone && (
            <p>
              Выбранный пустой числовой столбец телефона будет переведён в текстовый тип, чтобы
              сохранять «+» и ведущие нули.
            </p>
          )}
          <p>
            Пустые ячейки выбранных столбцов заполнятся уже сохранёнными ФИО и телефонами.
            Заполненные ячейки сохранят свои значения.
          </p>
          <p>После изменения назначения скачайте новый шаблон Excel для импорта.</p>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={
              disabled ||
              saving ||
              loading ||
              !dirty ||
              !!missing.length ||
              duplicate ||
              !validSelections
            }
            onClick={() => void save()}
          >
            {saving ? 'Сохраняем…' : 'Сохранить назначение столбцов'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}{' '}
          <button
            type="button"
            disabled={disabled || saving}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить загрузку
          </button>
        </p>
      )}
    </details>
  );
}
