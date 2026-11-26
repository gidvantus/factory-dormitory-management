export function FormulaResultFormat({
  percent,
  onChange,
  className,
  disabled,
}: {
  percent: boolean;
  onChange: (percent: boolean) => void;
  className?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className={className}>
      Формат результата
      <select
        value={percent ? 'percent' : 'number'}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === 'percent')}
      >
        <option value="number">Число</option>
        <option value="percent">Процент (0,75 → 75 %)</option>
      </select>
    </label>
  );
}
