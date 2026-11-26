import type { InflowEntryForm, TableColumn } from '../../api/client';
import type { IdentityFields } from '../../api/personnel';

export const identityKeys = ['full_name', 'personnel_number', 'phone'] as const;

export function identityKey(
  column: TableColumn,
  assigned: InflowEntryForm['identity_columns'],
): keyof IdentityFields | null {
  return (
    identityKeys.find(
      (key) =>
        (key !== 'personnel_number' && assigned?.[key] === column.id) || key === column.builtin_key,
    ) ?? null
  );
}
