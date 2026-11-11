import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { useUnsavedChanges } from '../../components/useUnsavedChanges';
import { personName } from '../../workspace/personnel/helpers';
import type { Column } from './model';
import { useBuilderDraft } from './useBuilderDraft';

export function InlineBuilderCell({
  column,
  value,
  label,
  data,
  onCommit,
  children,
}: {
  column: Column;
  value: string | boolean | undefined;
  label: string;
  data: PersonnelData;
  onCommit: (value: string | boolean) => void;
  children: ReactNode;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | boolean>(value ?? '');
  const [error, setError] = useState('');
  const control = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const dirty = draft !== (value ?? '');
  useBuilderDraft(dirty);
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);
  useEffect(() => {
    if (!editing) return;
    control.current?.focus();
    if (control.current instanceof HTMLInputElement && control.current.type === 'text')
      control.current.select();
  }, [editing]);
  function commit(): void {
    if (column.required && (column.kind === 'checkbox' ? draft !== true : !String(draft).trim())) {
      setError(`Заполните поле «${column.name}».`);
      return;
    }
    if (
      column.kind === 'number' &&
      String(draft).trim() &&
      !Number.isFinite(Number(String(draft).replace(',', '.')))
    ) {
      setError('Введите корректное число.');
      return;
    }
    if (dirty) onCommit(column.kind === 'number' ? String(draft).replace(',', '.') : draft);
    setError('');
    setEditing(false);
  }
  const editButton = (
    <button
      type="button"
      className="btn btn--quiet working-table-edit-button"
      data-table-edit-trigger
      aria-label={`Редактировать ${label}`}
      onClick={() => setEditing(true)}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
      >
        <path d="m16 3 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15l-1 6Z" />
      </svg>
    </button>
  );
  if (!editing)
    return column.kind === 'employee' ? (
      <>
        {children}
        {editButton}
      </>
    ) : (
      <span
        role="button"
        tabIndex={0}
        className="working-table-editable"
        data-table-edit-trigger
        aria-label={`Редактировать ${label}`}
        onClick={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            setEditing(true);
          }
        }}
      >
        {children}
      </span>
    );
  const common = {
    className: 'working-table-inline-input',
    'aria-label': label,
    'aria-invalid': !!error,
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDraft(value ?? '');
        setError('');
        setEditing(false);
      }
    },
  };
  return (
    <>
      {column.kind === 'select' || column.kind === 'employee' ? (
        <select
          {...common}
          ref={(element) => {
            control.current = element;
          }}
          value={
            column.kind === 'employee'
              ? (data.employees.find(
                  (person) => person.id === draft || person.member_ids.includes(String(draft)),
                )?.id ?? String(draft))
              : String(draft)
          }
          onChange={(event) => setDraft(event.target.value)}
        >
          <option value="">Не выбрано</option>
          {column.kind === 'employee' ? (
            data.employees.map((person) => (
              <option key={person.id} value={person.id}>
                {personName(person)} · № {person.personnel_number}
              </option>
            ))
          ) : (
            <>
              {draft && !column.options.includes(String(draft)) && (
                <option value={String(draft)}>{String(draft)}</option>
              )}
              {column.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </>
          )}
        </select>
      ) : column.kind === 'checkbox' ? (
        <input
          {...common}
          ref={(element) => {
            control.current = element;
          }}
          type="checkbox"
          checked={draft === true}
          onChange={(event) => setDraft(event.target.checked)}
        />
      ) : (
        <input
          {...common}
          ref={(element) => {
            control.current = element;
          }}
          type={column.kind === 'date' ? 'date' : 'text'}
          inputMode={column.kind === 'number' ? 'decimal' : undefined}
          maxLength={500}
          value={String(draft)}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {error && (
        <small className="working-table-cell-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
