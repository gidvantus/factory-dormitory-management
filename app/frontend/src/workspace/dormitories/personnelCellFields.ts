import type { CellValue } from '../../api/client';
import type { IdentityFields } from '../../api/personnel';

export function personnelCellFields(
  row: { id: number; custom_values?: Record<string, CellValue> },
  values: Record<string, CellValue>,
  binding: Record<string, number> = {},
): IdentityFields {
  const field = (role: keyof IdentityFields): string | null => {
    const column = binding[role];
    if (column === undefined) return null;
    const key = `${row.id}:${column}`;
    const value = key in values ? values[key] : row.custom_values?.[column];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  };
  return {
    full_name: field('full_name'),
    personnel_number: field('personnel_number'),
    phone: field('phone'),
  };
}
