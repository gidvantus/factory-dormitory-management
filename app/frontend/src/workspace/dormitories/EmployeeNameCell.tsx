import { useEffect, useRef, useState } from 'react';
import type { IdentityFields, SourceTable } from '../../api/personnel';
import { useEmployeeCard } from '../personnel/useEmployeeCard';
import { useSettingsNavigation } from './settingsContext';
import styles from './EmployeeNameCell.module.css';

export function EmployeeNameCell({
  fields,
  rowId,
  employeeId,
  tableKey,
  rowLabel = `строка ${rowId}`,
  label = 'ФИО',
  dormitoryId,
  onChange,
  onSave,
  beforeOpen,
  onLinked,
  readOnly = false,
}: {
  fields: Partial<IdentityFields>;
  rowId: number;
  employeeId?: string | null;
  tableKey: SourceTable;
  rowLabel?: string;
  label?: string;
  dormitoryId: string;
  onChange: (name: string) => void;
  onSave: (name: string) => Promise<boolean>;
  beforeOpen?: () => Promise<unknown>;
  onLinked?: (id: string) => void;
  readOnly?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const settings = useSettingsNavigation();
  const disabled = readOnly || !!settings?.readOnly;
  const name = fields.full_name ?? '';
  const card = useEmployeeCard({
    dormitoryId,
    tableKey,
    rowId,
    employeeId,
    fields,
    beforeOpen,
    onLinked,
  });
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  return (
    <>
      {editing || !name.trim() ? (
        <input
          ref={input}
          aria-label={`${label}, ${rowLabel}`}
          type="text"
          value={name}
          maxLength={255}
          disabled={disabled || saving}
          onFocus={() => setEditing(true)}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (saving) return;
            setSaving(true);
            void onSave(name)
              .then((saved) => {
                if (saved) setEditing(false);
              })
              .finally(() => setSaving(false));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div className={styles.nameCell}>
          <a
            href={
              employeeId ? `/cabinet/personnel?employee=${encodeURIComponent(employeeId)}` : '#'
            }
            className={styles.nameLink}
            title="Открыть карточку сотрудника"
            aria-busy={card.busy}
            onClick={(event) => {
              if (employeeId && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))
                return;
              event.preventDefault();
              void card.open();
            }}
          >
            {name}
          </a>
          {!disabled && (
            <button
              type="button"
              className={styles.nameEdit}
              aria-label={`Редактировать ${label}, ${rowLabel}`}
              title={`Редактировать ${label}`}
              disabled={card.busy}
              onClick={() => setEditing(true)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m16 3 5 5M3 21l5-1L21 7a2.1 2.1 0 0 0-5-5L3 15l-1 6Z" />
              </svg>
            </button>
          )}
        </div>
      )}
      {card.error && (
        <small role="alert" className={styles.error}>
          {card.error}
        </small>
      )}
      {card.dialog}
    </>
  );
}
