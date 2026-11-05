export function ColumnArchiveTabs({
  archived,
  onChange,
  currentCount,
  archivedCount,
}: {
  archived: boolean;
  onChange: (value: boolean) => void;
  currentCount: number;
  archivedCount: number;
}): JSX.Element {
  return (
    <div className="column-archive-tabs" role="tablist" aria-label="Столбцы таблицы">
      {[false, true].map((value) => (
        <button
          key={String(value)}
          type="button"
          role="tab"
          aria-selected={archived === value}
          tabIndex={archived === value ? 0 : -1}
          className="btn btn--quiet btn--compact"
          onClick={() => onChange(value)}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next = event.key === 'Home' ? false : event.key === 'End' ? true : !value;
              onChange(next);
              const tabs =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              tabs?.item(next ? 1 : 0)?.focus();
            }
          }}
        >
          {value ? 'Архивные столбцы' : 'Текущие столбцы'}
          <span>{value ? archivedCount : currentCount}</span>
        </button>
      ))}
    </div>
  );
}
