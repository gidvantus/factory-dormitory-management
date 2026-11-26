const percent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 2 });

export function formatPercent(value: string | number): string {
  if (typeof value === 'string' && !value.trim()) return value;
  const number = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  return Number.isFinite(number) ? percent.format(number) : String(value);
}
