import type { Resident } from '../../api/client';

const normalize = (value: string): string =>
  value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
export function matchesResident(resident: Resident, query: string): boolean {
  const expected = normalize(query);
  if (!expected) return true;
  const haystack = normalize(
    [resident.full_name, resident.personnel_number, resident.phone].filter(Boolean).join(' '),
  );
  if (expected.split(' ').every((term) => haystack.includes(term))) return true;
  return (
    /^[+\d\s()-]+$/.test(expected) &&
    /\d/.test(expected) &&
    (resident.phone ?? '').replace(/\D/g, '').includes(expected.replace(/\D/g, ''))
  );
}
