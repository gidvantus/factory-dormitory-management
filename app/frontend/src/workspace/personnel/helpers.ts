import type {
  Block,
  BlockKind,
  Employee,
  Filter,
  PersonnelData,
  SavedList,
  Source,
} from '../../api/personnel';
import { ApiError } from '../../api/client';

export const names: Record<Filter, string> = {
  all: 'Все сотрудники',
  current: 'Проживают',
  ending: 'Заканчивается вахта',
};
export const blockNames: Record<BlockKind, string> = {
  residents: 'Проживающий персонал',
  ending: 'Заканчивается вахта',
  contacts: 'Контакты сотрудников',
  plans: 'План заездов',
  saved: 'Сохранённый список',
};
export const decisionNames = {
  waiting: 'Ожидаем решение',
  extend: 'Продление согласовано',
  departure: 'Планируется выезд',
};
export const defaultBlocks: Block[] = (['plans', 'residents', 'ending', 'contacts'] as const).map(
  (kind, index) => ({
    id: `default-${index}`,
    kind,
    title: blockNames[kind],
    scope: [],
    days: kind === 'plans' ? 7 : 5,
    limit: 4,
    wide: false,
    saved_list_id: null,
  }),
);
export const message = (error: unknown): string =>
  error instanceof ApiError
    ? error.message
    : 'Не удалось выполнить действие. Проверьте соединение и повторите попытку.';
export const value = (source: Source | undefined, field: string): string =>
  source?.values[field] == null ? '' : String(source.values[field]);
export const personName = (person: Employee | undefined): string =>
  person?.full_name || 'ФИО не указано';
export const dateLabel = (date: string | null | undefined, year = false): string =>
  date && /^\d{4}-\d{2}-\d{2}/.test(date)
    ? new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
        ...(year ? { year: 'numeric' } : {}),
        timeZone: 'UTC',
      }).format(new Date(`${date.slice(0, 10)}T00:00:00Z`))
    : '—';
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const dayDiff = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export const dormName = (data: PersonnelData, id: number | null): string =>
  data.dormitories.find((d) => d.id === id)?.name ?? 'Общежитие удалено';
export const currentSources = (person: Employee, dormitory: number | null = null): Source[] =>
  person.current.filter((source) => dormitory == null || source.dormitory_id === dormitory);
export function matches(
  person: Employee,
  filter: Filter,
  data: PersonnelData,
  days = 5,
  dormitory: number | null = null,
): boolean {
  const current = currentSources(person, dormitory);
  const ends = current.map((source) => value(source, 'shift_end')).filter(Boolean);
  switch (filter) {
    case 'current':
      return current.length > 0;
    case 'ending':
      return ends.some((end) => end >= data.today && dayDiff(data.today, end) <= days);
    default:
      return true;
  }
}
export function filterPeople(
  data: PersonnelData,
  list: Omit<SavedList, 'id' | 'name'>,
): Employee[] {
  const query = list.query.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const digits = query.replace(/\D/g, '');
  const scoped = list.dormitory != null || list.scope.length > 0;
  const allowed = (id: number): boolean =>
    (list.dormitory == null || id === list.dormitory) &&
    (!list.scope.length || list.scope.includes(id));
  return data.employees
    .filter((person) => {
      const inLocation =
        !scoped ||
        person.sources.some((source) => allowed(source.dormitory_id)) ||
        person.history_dormitory_ids.some(allowed);
      const text = [
        person.full_name,
        person.personnel_number,
        person.phone,
        ...Object.values(person.variants).flat(),
      ]
        .join(' ')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е');
      const scopedPerson = {
        ...person,
        current: person.current.filter((source) => allowed(source.dormitory_id)),
      };
      return (
        inLocation &&
        matches(scopedPerson, list.filter, data, list.days) &&
        (!query ||
          text.includes(query) ||
          (/^[+\d\s()-]+$/.test(query) &&
            digits.length >= 3 &&
            [person.phone, ...(person.variants.phone ?? [])].some((phone) =>
              phone?.replace(/\D/g, '').includes(digits),
            )))
      );
    })
    .sort((a, b) => {
      const end = (p: Employee): string =>
        p.current
          .filter((source) => allowed(source.dormitory_id))
          .map((source) => value(source, 'shift_end'))
          .filter(Boolean)
          .sort()[0] ?? '';
      const chronological = list.filter === 'ending' ? end(a).localeCompare(end(b)) : 0;
      return (
        chronological ||
        personName(a).localeCompare(personName(b), 'ru') ||
        a.id.localeCompare(b.id)
      );
    });
}
export function sourceUrl(source: Source): string {
  const path = source.table_key.startsWith('custom_')
    ? `custom/${source.table_key.slice(7)}`
    : source.table_key;
  const rawDate = value(
    source,
    source.table_key === 'outflow' ? 'departure_date' : 'settlement_date',
  );
  const period = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `&from=${rawDate}&to=${rawDate}` : '';
  return `/cabinet/dormitories/${source.dormitory_id}/${path}?row=${source.row_id}${period}`;
}
