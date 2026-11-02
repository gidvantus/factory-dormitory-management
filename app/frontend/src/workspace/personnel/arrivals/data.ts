export const FIELD_TYPES = {
  number: { label: 'Число', icon: '123' },
  text: { label: 'Текст', icon: 'Тт' },
  checkbox: { label: 'Чекбокс', icon: '☑' },
  date: { label: 'Дата', icon: '▦' },
  time: { label: 'Время', icon: '◷' },
  select: { label: 'Выпадающий список', icon: '⌄' },
  textarea: { label: 'Длинный текст', icon: '≡' },
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
export type Value = string | boolean;
export type Field = {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  inForm: boolean;
  scope: 'arrival' | 'person';
  options: string[];
};
export type Display = {
  order: string[];
  visible: string[];
  summary: boolean;
  hideEmpty: boolean;
  compact: boolean;
  namesLimit: number;
};
export type Settings = { fields: Field[]; display: Display };
export type Person = { id: string; name: string; values: Record<string, Value> };
export type Arrival = {
  id: string;
  dorm: string;
  date: string;
  count: string;
  people: Person[];
  values: Record<string, Value>;
};

export function initialSettings(): Settings {
  return {
    fields: [
      {
        id: 'shifts',
        label: 'Кол-во смен',
        type: 'number',
        required: false,
        inForm: true,
        scope: 'person',
        options: [],
      },
      {
        id: 'transfer',
        label: 'Трансфер заказан',
        type: 'checkbox',
        required: false,
        inForm: true,
        scope: 'arrival',
        options: [],
      },
      {
        id: 'workdate',
        label: 'Дата выхода на работу',
        type: 'date',
        required: false,
        inForm: true,
        scope: 'person',
        options: [],
      },
      {
        id: 'transport',
        label: 'Транспорт',
        type: 'select',
        required: false,
        inForm: true,
        scope: 'arrival',
        options: ['Автобус', 'Поезд', 'Самостоятельно'],
      },
      {
        id: 'comment',
        label: 'Комментарий',
        type: 'textarea',
        required: false,
        inForm: true,
        scope: 'arrival',
        options: [],
      },
    ],
    display: {
      order: ['transfer', 'transport', 'names', 'shifts', 'workdate', 'comment'],
      visible: ['shifts', 'transfer', 'transport', 'names', 'workdate'],
      summary: true,
      hideEmpty: true,
      compact: false,
      namesLimit: 3,
    },
  };
}

export function namesOf(arrival: Arrival): string[] {
  return arrival.people
    .slice(0, personCount(arrival.count))
    .map((person) => person.name.trim())
    .filter(Boolean);
}

export const PEOPLE_PAGE_SIZE = 25;

export function personCount(value: string): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 10000 ? count : 0;
}

export function peopleAtCount(people: Person[], count: number): Person[] {
  return Array.from(
    { length: count },
    (_, index) => people[index] ?? { id: crypto.randomUUID(), name: '', values: {} },
  );
}

export function hasPersonData(person: Person): boolean {
  return (
    !!person.name.trim() ||
    Object.values(person.values).some(
      (value) => value === true || (typeof value === 'string' && !!value.trim()),
    )
  );
}

export function newArrival(dorm: string, date: string): Arrival {
  return { id: '', dorm, date, count: '1', people: peopleAtCount([], 1), values: {} };
}

export function reconfigureArrival(arrival: Arrival, previous: Settings, next: Settings): Arrival {
  const values = { ...arrival.values };
  const people = arrival.people.map((person) => ({ ...person, values: { ...person.values } }));
  for (const field of next.fields) {
    const old = previous.fields.find((item) => item.id === field.id);
    if (!old) continue;
    if (old.type !== field.type) {
      delete values[field.id];
      people.forEach((person) => {
        delete person.values[field.id];
      });
    } else if (old.scope !== field.scope) {
      if (field.scope === 'person') {
        people.forEach((person) => {
          if (isEmpty(person.values[field.id]) && !isEmpty(values[field.id]))
            person.values[field.id] = values[field.id];
        });
      } else if (isEmpty(values[field.id])) {
        const first = people[0]?.values[field.id];
        if (
          !isEmpty(first) &&
          people
            .slice(0, personCount(arrival.count))
            .every((person) => person.values[field.id] === first)
        )
          values[field.id] = first;
      }
    }
  }
  return { ...arrival, values, people };
}

export function isEmpty(value: Value | undefined): boolean {
  return value === undefined || value === '';
}

export function sampleValue(field: Field, sampleDate = '2026-10-28'): Value {
  switch (field.type) {
    case 'number':
      return '30';
    case 'date':
      return sampleDate;
    case 'time':
      return '09:00';
    case 'checkbox':
      return true;
    case 'select':
      return field.options[0] ?? '';
    default:
      return 'Пример значения';
  }
}

export function printable(field: Field, value: Value | undefined): string {
  if (isEmpty(value)) return 'Не указано';
  if (field.type === 'checkbox') return value === true ? 'Да' : 'Нет';
  if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(`${value}T00:00:00Z`));
  }
  return String(value);
}
