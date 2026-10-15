import { createContext, useContext } from 'react';

import { TODAY, dayDiff, dormitories, endingSoon, needsData, people as demoPeople } from './data';
import type { Person, PersonEvent } from './data';

export type ListFilter =
  | 'all'
  | 'current'
  | 'ending'
  | 'overdue'
  | 'missing'
  | 'history'
  | 'mine'
  | 'returned'
  | 'arrivals'
  | 'no-phone';
export type ProfileTab = 'overview' | 'history' | 'shifts' | 'notes' | 'next';
export type WorkspaceView = 'workspace' | 'list' | 'planning' | 'matches';
export type Note = { id: string; personId: string; text: string; date: string; author: string };
export type Plan = {
  id: string;
  personId: string;
  kind: 'arrival' | 'departure';
  date: string;
  end: string;
  dormitoryId: string;
  confirmed: boolean;
  comment: string;
};
export type SavedList = {
  id: string;
  name: string;
  filter: ListFilter;
  dormitory: string;
  scope: string[];
  days: number;
  query: string;
};
export type OperationsState = {
  notes: Note[];
  plans: Plan[];
  favorites: string[];
  lists: SavedList[];
  resolutions: Record<string, 'linked' | 'separate'>;
  events: Record<string, PersonEvent[]>;
};
export const MY_NAME = 'Марина Соколова';
export const listNames: Record<ListFilter, string> = {
  all: 'Все сотрудники',
  current: 'Проживают',
  ending: 'Заканчивается вахта',
  overdue: 'Дата вахты прошла',
  missing: 'Неполные данные',
  history: 'Были в оттоке',
  mine: 'Мои сотрудники',
  returned: 'Вернулись после оттока',
  arrivals: 'Ожидают заезда',
  'no-phone': 'Без телефона',
};
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const matches = [
  {
    id: 'match-1',
    personId: 'person-1',
    name: 'Морозов Алексей С.',
    number: '1042',
    phone: '+7 (000) 000-10-00',
    dormitoryId: 'central',
    source: 'Архив · Центральное',
    evidence: 'Совпадают табельный номер и телефон',
    date: '2026-07-30',
    reason: 'Завершил вахту',
  },
  {
    id: 'match-2',
    personId: 'person-3',
    name: 'Ковалёв Дмитрий Игоревич',
    number: '2044',
    phone: '+7 (000) 000-10-02',
    dormitoryId: 'park',
    source: 'Архив · Парковое',
    evidence: 'Совпадают ФИО и телефон, отличается табельный номер',
    date: '2026-08-12',
    reason: 'Перевод на другой объект',
  },
  {
    id: 'match-3',
    personId: 'person-5',
    name: 'Орлова Мария Андреевна',
    number: '3046',
    phone: null,
    dormitoryId: 'south',
    source: 'Архив · Южное',
    evidence: 'Совпадает только ФИО — данных недостаточно',
    date: '2026-08-01',
    reason: 'Завершил вахту',
  },
];
const seed: OperationsState = {
  notes: [
    {
      id: 'note-1',
      personId: 'person-1',
      text: 'Готов остаться ещё на две недели. Окончательное решение обещал сообщить 12 октября.',
      date: '2026-10-09',
      author: MY_NAME,
    },
  ],
  plans: [
    {
      id: 'departure-person-2',
      personId: 'person-2',
      kind: 'departure',
      date: '2026-10-10',
      end: '',
      dormitoryId: 'north',
      confirmed: true,
      comment: 'Сбор у корпуса в 18:00.',
    },
    {
      id: 'arrival-person-29',
      personId: 'person-29',
      kind: 'arrival',
      date: '2026-10-12',
      end: '2026-11-25',
      dormitoryId: 'north',
      confirmed: false,
      comment: 'Нужно уточнить билет и время прибытия.',
    },
    {
      id: 'arrival-person-30',
      personId: 'person-30',
      kind: 'arrival',
      date: '2026-10-13',
      end: '2026-11-26',
      dormitoryId: 'central',
      confirmed: true,
      comment: 'Билет куплен, приезд утром.',
    },
    {
      id: 'arrival-person-31',
      personId: 'person-31',
      kind: 'arrival',
      date: '2026-10-15',
      end: '2026-11-28',
      dormitoryId: 'park',
      confirmed: false,
      comment: '',
    },
  ],
  favorites: ['person-1', 'person-3', 'person-5', 'person-29'],
  lists: [
    {
      id: 'my-people',
      name: 'Мои сотрудники',
      filter: 'mine',
      dormitory: 'all',
      scope: [],
      days: 5,
      query: '',
    },
    {
      id: 'returning',
      name: 'Ожидаем на вахту',
      filter: 'arrivals',
      dormitory: 'all',
      scope: [],
      days: 5,
      query: '',
    },
    {
      id: 'phones',
      name: 'Нужны телефоны',
      filter: 'no-phone',
      dormitory: 'all',
      scope: [],
      days: 5,
      query: '',
    },
  ],
  resolutions: {},
  events: {
    'person-3': [
      {
        id: 'seed-extension',
        date: '2026-10-09',
        kind: 'shift',
        title: 'Продление вахты согласовано',
        detail: 'Период продлён с 12 до 25 октября. Подтверждено сотрудником.',
        dormitoryId: 'central',
        source: 'Решение по вахте',
      },
    ],
  },
};
export const storageKey = 'domovoy:personnel-operations:v1';
const isId = (value: unknown): value is string =>
  typeof value === 'string' && demoPeople.some((p) => p.id === value);
const isDorm = (value: unknown): value is string =>
  typeof value === 'string' && dormitories.some((d) => d.id === value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 3000;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
function validState(value: unknown): value is OperationsState {
  if (!value || typeof value !== 'object') return false;
  const s = value as OperationsState;
  if (
    !s.events ||
    !s.resolutions ||
    !Array.isArray(s.notes) ||
    !Array.isArray(s.plans) ||
    !Array.isArray(s.favorites) ||
    !Array.isArray(s.lists)
  )
    return false;
  return (
    s.notes.every(
      (n) =>
        n &&
        isText(n.id) &&
        isId(n.personId) &&
        isText(n.text) &&
        isDate(n.date) &&
        isText(n.author),
    ) &&
    s.plans.every(
      (p) =>
        p &&
        isText(p.id) &&
        isId(p.personId) &&
        ['arrival', 'departure'].includes(p.kind) &&
        isDate(p.date) &&
        (p.kind === 'departure' || (isDate(p.end) && p.end >= p.date)) &&
        isDorm(p.dormitoryId) &&
        typeof p.confirmed === 'boolean' &&
        isText(p.comment),
    ) &&
    s.favorites.every(isId) &&
    s.lists.every(
      (l) =>
        l &&
        isText(l.id) &&
        isText(l.name) &&
        Object.hasOwn(listNames, l.filter) &&
        (l.dormitory === 'all' || isDorm(l.dormitory)) &&
        Array.isArray(l.scope) &&
        l.scope.every(isDorm) &&
        Number.isInteger(l.days) &&
        l.days >= 0 &&
        l.days <= 90 &&
        isText(l.query),
    ) &&
    Object.entries(s.resolutions).every(
      ([id, r]) => matches.some((m) => m.id === id) && ['linked', 'separate'].includes(r),
    ) &&
    Object.entries(s.events).every(
      ([id, events]) =>
        isId(id) &&
        Array.isArray(events) &&
        events.every(
          (e) =>
            e &&
            isText(e.id) &&
            isDate(e.date) &&
            ['arrival', 'transfer', 'shift', 'outflow', 'review', 'note'].includes(e.kind) &&
            isText(e.title) &&
            isText(e.detail) &&
            isDorm(e.dormitoryId) &&
            (!e.source || isText(e.source)),
        ),
    )
  );
}
export function readState(): OperationsState {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (stored && typeof stored === 'object') {
      const raw = stored as Record<string, unknown>;
      const events =
        raw.events && typeof raw.events === 'object'
          ? Object.fromEntries(
              Object.entries(raw.events).map(([id, entries]: [string, unknown]) => [
                id,
                Array.isArray(entries)
                  ? entries.filter(
                      (entry: unknown) =>
                        !entry ||
                        typeof entry !== 'object' ||
                        (entry as Record<string, unknown>).kind !== 'task',
                    )
                  : entries,
              ]),
            )
          : raw.events;
      const state = {
        notes: raw.notes,
        plans: raw.plans,
        favorites: raw.favorites,
        lists: raw.lists,
        resolutions: raw.resolutions,
        events,
      };
      if (validState(state)) return state;
    }
  } catch {
    /* Используем демонстрационный набор при недоступном хранилище. */
  }
  return structuredClone(seed);
}
export function materializePeople(state: OperationsState): Person[] {
  return demoPeople.map((person) => {
    const end = person.end;
    return {
      ...person,
      end,
      shifts: person.shifts.map((shift, index) =>
        index === 0 && person.current && end ? { ...shift, end } : shift,
      ),
      history: [...(state.events[person.id] ?? []), ...person.history].sort((a, b) =>
        b.date.localeCompare(a.date),
      ),
    };
  });
}
export function matchesFilter(
  person: Person,
  filter: ListFilter,
  days: number,
  state: Pick<OperationsState, 'favorites' | 'plans'>,
): boolean {
  switch (filter) {
    case 'current':
      return person.current;
    case 'ending':
      return endingSoon(person, days);
    case 'overdue':
      return person.current && !!person.end && dayDiff(TODAY, person.end) < 0;
    case 'missing':
      return needsData(person);
    case 'history':
      return person.history.some((e) => e.kind === 'outflow');
    case 'mine':
      return state.favorites.includes(person.id);
    case 'returned':
      return person.current && person.history.some((e) => e.kind === 'outflow');
    case 'arrivals':
      return state.plans.some(
        (p) => p.personId === person.id && p.kind === 'arrival' && p.date >= TODAY,
      );
    case 'no-phone':
      return person.current && !person.phone;
    default:
      return true;
  }
}
export function selectSavedList(
  list: SavedList,
  people: Person[],
  state: Pick<OperationsState, 'favorites' | 'plans'>,
  pageDormitory = 'all',
): Person[] {
  return people.filter((person) => {
    const applicable = (id: string): boolean =>
      (pageDormitory === 'all' || id === pageDormitory) &&
      (list.dormitory === 'all' || id === list.dormitory) &&
      (!list.scope.length || list.scope.includes(id));
    const scopeMatches =
      list.filter === 'history'
        ? person.history.some((e) => e.kind === 'outflow' && applicable(e.dormitoryId))
        : list.filter === 'arrivals'
          ? state.plans.some(
              (p) =>
                p.personId === person.id &&
                p.kind === 'arrival' &&
                p.date >= TODAY &&
                applicable(p.dormitoryId),
            )
          : applicable(person.dormitoryId);
    const query = list.query.trim().toLocaleLowerCase('ru-RU');
    const search =
      `${person.name} ${person.number} ${person.phone ?? ''} ${(person.phone ?? '').replace(/\D/g, '')}`.toLocaleLowerCase(
        'ru-RU',
      );
    return (
      scopeMatches &&
      matchesFilter(person, list.filter, list.days, state) &&
      (search.includes(query) ||
        (/^[+\d\s()-]+$/.test(query) &&
          query.replace(/\D/g, '').length >= 3 &&
          (person.phone ?? '').replace(/\D/g, '').includes(query.replace(/\D/g, ''))))
    );
  });
}
export type OperationsContextValue = {
  state: OperationsState;
  people: Person[];
  storageError: boolean;
  toggleFavorite: (id: string) => void;
  savePlan: (plan: Plan) => void;
  removePlan: (id: string) => void;
  confirmPlan: (id: string) => void;
  addNote: (personId: string, text: string) => void;
  saveList: (list: SavedList) => void;
  removeList: (id: string) => void;
  resolveMatch: (id: string, resolution: 'linked' | 'separate') => void;
};
export const OperationsContext = createContext<OperationsContextValue | null>(null);
export function usePersonnelOperations(): OperationsContextValue {
  const context = useContext(OperationsContext);
  if (!context) throw new Error('Не найдено демонстрационное пространство персонала');
  return context;
}
