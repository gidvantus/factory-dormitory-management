import type { IdentityFields } from '../../api/personnel';

export const identityKeys = ['full_name', 'personnel_number', 'phone'] as const;

export function identityKey(value: string | null): keyof IdentityFields | null {
  return identityKeys.find((key) => key === value) ?? null;
}
