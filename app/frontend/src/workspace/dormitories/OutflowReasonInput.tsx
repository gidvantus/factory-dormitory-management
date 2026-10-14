import { useEffect, useRef, useState } from 'react';
import styles from './OutflowReasonInput.module.css';

export function OutflowReasonInput({
  value,
  choices,
  allowCustom,
  onChange,
  onCommit,
  disabled,
  required,
  label,
  hint,
  compact = false,
}: {
  value: string;
  choices: { value: string; label: string }[];
  allowCustom: boolean;
  onChange: (value: string) => void;
  onCommit?: (value: string) => Promise<boolean>;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  hint?: string;
  compact?: boolean;
}): JSX.Element {
  const [manual, setManual] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (manual) input.current?.focus();
  }, [manual]);
  const typed =
    allowCustom &&
    (manual || !choices.length || (!!value && !choices.some((choice) => choice.value === value)));
  return (
    <span className={`${styles.field} ${compact ? styles.compact : ''}`}>
      {typed ? (
        <>
          <input
            ref={input}
            aria-label={label}
            type="text"
            value={value}
            maxLength={255}
            required={required}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => {
              if (onCommit)
                void onCommit(value.trim()).then((saved) => {
                  if (saved) setManual(false);
                });
            }}
            onKeyDown={(event) => {
              if (onCommit && event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          {hint && <small>{hint}</small>}
          {!!choices.length && (
            <button
              type="button"
              className={styles.returnButton}
              aria-label="Выбрать из списка"
              title="Выбрать из списка"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange('');
                setManual(false);
              }}
            >
              {compact ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              ) : (
                'Выбрать из списка'
              )}
            </button>
          )}
        </>
      ) : (
        <select
          aria-label={label}
          title={
            choices.find((choice) => choice.value === value)?.label || value || 'Выберите причину'
          }
          value={manual ? '__new_reason__' : value}
          required={required}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === '__new_reason__') {
              setManual(true);
              onChange('');
            } else {
              onChange(event.target.value);
              if (onCommit) void onCommit(event.target.value);
            }
          }}
        >
          <option value="">Выберите причину</option>
          {value && !choices.some((choice) => choice.value === value) && (
            <option value={value}>{value} (в архиве)</option>
          )}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
          {allowCustom && <option value="__new_reason__">Другая причина — ввести вручную</option>}
        </select>
      )}
    </span>
  );
}
