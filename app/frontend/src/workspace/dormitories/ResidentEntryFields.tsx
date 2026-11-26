import type { CellValue, InflowEntryForm } from '../../api/client';
import type { IdentityFields } from '../../api/personnel';
import { identityKey, identityKeys } from './entryIdentity';
import s from './ResidentEntryFields.module.css';

export function ResidentEntryFields({
  form,
  values,
  identity,
  disabled,
  onChange,
  onIdentity,
}: {
  form: InflowEntryForm;
  values: Record<string, CellValue>;
  identity: IdentityFields;
  disabled: boolean;
  onChange: (key: string, value: CellValue) => void;
  onIdentity: (key: keyof IdentityFields, value: string | null) => void;
}): JSX.Element {
  const columns = form.columns.filter((column) => {
    const field = identityKey(column, form.identity_columns);
    if (!field || field === 'personnel_number') return true;
    const assigned = form.identity_columns?.[field];
    return assigned === undefined || assigned === column.id;
  });
  return (
    <>
      <p className={s.hint}>
        Заполните известные данные для заселения. Неизвестные сведения можно оставить пустыми.
      </p>
      <div className={s.grid}>
        {identityKeys
          .filter(
            (key) =>
              key !== 'personnel_number' &&
              !columns.some((column) => identityKey(column, form.identity_columns) === key),
          )
          .map((key) => {
            const label = key === 'full_name' ? 'ФИО' : 'Телефон';
            const duplicateLabel = columns.some(
              (column) => column.name.trim().toLowerCase() === label.toLowerCase(),
            );
            return (
              <label className={s.field} key={key}>
                {duplicateLabel ? `${label} (карточка сотрудника)` : label}
                <input
                  type={key === 'phone' ? 'tel' : 'text'}
                  value={identity[key] ?? ''}
                  disabled={disabled}
                  maxLength={key === 'full_name' ? 255 : 30}
                  onChange={(event) => onIdentity(key, event.target.value)}
                />
              </label>
            );
          })}
        {columns.map((column) => {
          const field = identityKey(column, form.identity_columns);
          const value = field ? identity[field] : values[String(column.id)];
          const change = (next: CellValue) => {
            if (field) onIdentity(field, next === null ? null : String(next));
            else onChange(String(column.id), next);
          };
          const maxLength =
            field === 'full_name'
              ? 255
              : field === 'phone'
                ? 30
                : field === 'personnel_number'
                  ? 40
                  : 5000;
          return (
            <label className={s.field} key={column.id}>
              {column.kind !== 'checkbox' && column.name}
              {column.kind === 'checkbox' ? (
                <span className={s.checkbox}>
                  <input
                    type="checkbox"
                    aria-label={column.name}
                    checked={value === true}
                    disabled={disabled}
                    onChange={(event) => change(event.target.checked)}
                  />
                  {column.name}
                </span>
              ) : column.kind === 'hostel' || column.kind === 'select' ? (
                <select
                  aria-label={column.name}
                  disabled={disabled}
                  value={String(value ?? '')}
                  onChange={(event) =>
                    change(
                      event.target.value === ''
                        ? null
                        : column.kind === 'hostel'
                          ? Number(event.target.value)
                          : event.target.value,
                    )
                  }
                >
                  <option value="">Не выбрано</option>
                  {column.kind === 'hostel'
                    ? form.hostels.map((hostel) => (
                        <option key={hostel.id} value={hostel.id}>
                          {hostel.name}
                        </option>
                      ))
                    : column.options
                        .filter((option) => !option.archived)
                        .map((option) => (
                          <option key={option.id} value={option.id ?? ''}>
                            {option.label}
                          </option>
                        ))}
                </select>
              ) : column.builtin_key === 'notes' ? (
                <textarea
                  aria-label={column.name}
                  rows={2}
                  value={String(value ?? '')}
                  disabled={disabled}
                  maxLength={maxLength}
                  onChange={(event) => change(event.target.value || null)}
                />
              ) : (
                <input
                  aria-label={column.name}
                  type={
                    column.kind === 'date'
                      ? 'date'
                      : column.kind === 'number'
                        ? 'number'
                        : field === 'phone'
                          ? 'tel'
                          : 'text'
                  }
                  value={String(value ?? '')}
                  disabled={disabled}
                  maxLength={maxLength}
                  step={
                    column.kind === 'number'
                      ? column.builtin_key === 'shift_count'
                        ? '1'
                        : 'any'
                      : undefined
                  }
                  min={column.builtin_key === 'shift_count' ? '0' : undefined}
                  max={column.builtin_key === 'shift_count' ? '1000000' : undefined}
                  onChange={(event) => change(event.target.value || null)}
                />
              )}
            </label>
          );
        })}
      </div>
    </>
  );
}
