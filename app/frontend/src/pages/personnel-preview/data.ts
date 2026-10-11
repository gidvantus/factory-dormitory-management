/** Изолированные демонстрационные данные. Рабочие записи не читаются и не изменяются. */
export const TODAY = '2026-10-10';
export const dormitories = [
  { id: 'north', name: 'Северное', client: 'Технопром', color: '#43866d' },
  { id: 'central', name: 'Центральное', client: 'Вектор', color: '#809cbe' },
  { id: 'park', name: 'Парковое', client: 'Технопром', color: '#bba1ca' },
  { id: 'south', name: 'Южное', client: 'Меридиан', color: '#d6aa67' },
];
export type EventKind = 'arrival' | 'transfer' | 'shift' | 'outflow' | 'review' | 'task' | 'note';
export type PersonEvent = {
  id: string;
  date: string;
  kind: EventKind;
  title: string;
  detail: string;
  dormitoryId: string;
  reason?: string;
  source?: string;
};
export type Shift = { start: string; end: string; dormitoryId: string; complete: boolean };
export type Person = {
  id: string;
  number: string;
  name: string;
  role: string;
  dormitoryId: string;
  room: string;
  phone: string | null;
  current: boolean;
  start: string | null;
  end: string | null;
  history: PersonEvent[];
  shifts: Shift[];
};
export type BlockKind =
  'residents' | 'ending' | 'contacts' | 'outflow' | 'missing' | 'plans' | 'tasks' | 'saved';
export type Block = {
  id: string;
  kind: BlockKind;
  title: string;
  scope: string[];
  width: 'half' | 'full';
  days: number | null;
  showPhone: boolean;
  presentation: 'distribution' | 'total';
  savedListId?: string;
};
export const blockNames: Record<BlockKind, string> = {
  residents: 'Проживающий персонал',
  ending: 'Заканчивается вахта',
  contacts: 'Контакты сотрудников',
  outflow: 'История оттока',
  missing: 'Неполные данные',
  plans: 'План заездов и выездов',
  tasks: 'Задачи по сотрудникам',
  saved: 'Сохранённый список',
};
export const blockDescriptions: Record<BlockKind, string> = {
  residents: 'Общее количество и распределение по общежитиям',
  ending: 'Сотрудники, у которых скоро закончится вахта',
  contacts: 'Телефоны проживающих и быстрый переход в карточку',
  outflow: 'События оттока с датой, общежитием и причиной',
  missing: 'У кого не указаны телефон или даты вахты',
  plans: 'Подтверждённые и ожидаемые заезды и выезды на неделю',
  tasks: 'Открытые задачи, сроки и ответственные',
  saved: 'Сотрудники по вашим сохранённым условиям',
};
export const dayDiff = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export function calendarDays(count: number): string {
  const remainder = count % 100;
  const word =
    remainder >= 11 && remainder <= 14
      ? 'календарных дней'
      : count % 10 === 1
        ? 'календарный день'
        : [2, 3, 4].includes(count % 10)
          ? 'календарных дня'
          : 'календарных дней';
  return `${count} ${word}`;
}
export const dateLabel = (date: string, year = false): string =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
export const dormName = (id: string): string => dormitories.find((d) => d.id === id)?.name ?? '—';
export const initials = (name: string): string =>
  name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0])
    .join('');
export function deadline(person: Person): string {
  if (!person.current) return 'В оттоке';
  if (!person.end) return 'Дата не указана';
  const days = dayDiff(TODAY, person.end);
  if (days < 0) return `Дата прошла: ${Math.abs(days)} дн.`;
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Завтра';
  return `Через ${days} дн.`;
}
export const endingSoon = (person: Person, days: number): boolean =>
  person.current &&
  !!person.end &&
  dayDiff(TODAY, person.end) >= 0 &&
  dayDiff(TODAY, person.end) <= days;
export const needsData = (person: Person): boolean =>
  person.current && (!person.phone || !person.start || !person.end);
const names = [
  'Морозов Алексей Сергеевич',
  'Соколова Анна Дмитриевна',
  'Ковалёв Дмитрий Игоревич',
  'Волков Сергей Николаевич',
  'Орлова Мария Андреевна',
  'Лебедев Иван Петрович',
  'Смирнов Павел Олегович',
  'Новикова Елена Викторовна',
  'Попов Артём Денисович',
  'Захаров Максим Ильич',
  'Васильева Ольга Сергеевна',
  'Петров Николай Андреевич',
  'Егоров Андрей Владимирович',
  'Фёдорова Наталья Игоревна',
  'Павлов Кирилл Алексеевич',
  'Белов Роман Михайлович',
  'Козлова Дарья Олеговна',
  'Громов Виктор Петрович',
  'Тихонов Илья Сергеевич',
  'Кузнецова Ирина Павловна',
  'Семёнов Олег Юрьевич',
  'Мельников Денис Алексеевич',
  'Андреева Татьяна Ивановна',
  'Комаров Михаил Игоревич',
  'Савельев Антон Петрович',
  'Романова Екатерина Олеговна',
  'Борисов Глеб Андреевич',
  'Никитин Вадим Сергеевич',
  'Макарова Юлия Викторовна',
  'Соловьёв Евгений Иванович',
  'Медведев Руслан Олегович',
  'Зайцева Светлана Петровна',
  'Фомин Валерий Игоревич',
  'Давыдов Тимур Сергеевич',
  'Карпова Алина Андреевна',
  'Лазарев Леонид Михайлович',
];
const reasons = ['Завершил вахту', 'Уволился', 'По собственному желанию', 'Не вышел на работу'];
export const people: Person[] = names.map((name, index) => {
  const current = index < 28;
  const placement =
    ({ 2: 10, 10: 2, 3: 18, 18: 3, 5: 24, 24: 5 } as Record<number, number>)[index] ?? index;
  const dormitoryId =
    dormitories[placement < 10 ? 0 : placement < 18 ? 1 : placement < 24 ? 2 : 3].id;
  const previousDormitory = dormitories[(index + 1) % dormitories.length].id;
  const id = `person-${index + 1}`;
  const start = index === 15 ? null : '2026-09-01';
  const end = !current
    ? '2026-09-30'
    : index < 6
      ? `2026-10-${String(10 + index).padStart(2, '0')}`
      : index < 8
        ? '2026-10-08'
        : [12, 15].includes(index)
          ? null
          : `2026-10-${String(18 + (index % 12)).padStart(2, '0')}`;
  const history: PersonEvent[] = [
    {
      id: `${id}-arrival`,
      date: '2026-09-01',
      kind: 'arrival',
      title: 'Заселение на новую вахту',
      detail: `${dormName(dormitoryId)} · корпус А`,
      dormitoryId,
    },
    {
      id: `${id}-shift`,
      date: '2026-08-25',
      kind: 'shift',
      title: 'Запланирована новая вахта',
      detail: `Начало — 1 сентября · ${dormName(dormitoryId)}`,
      dormitoryId,
    },
  ];
  if (index % 3 === 0 || !current) {
    history.push(
      {
        id: `${id}-old-outflow`,
        date: '2026-07-30',
        kind: 'outflow',
        title: 'Запись в оттоке',
        detail: `${dormName(previousDormitory)} · предыдущая вахта`,
        dormitoryId: previousDormitory,
        reason: reasons[index % 4],
      },
      {
        id: `${id}-old-arrival`,
        date: '2026-06-16',
        kind: 'arrival',
        title: 'Заселение',
        detail: `${dormName(previousDormitory)} · корпус Б`,
        dormitoryId: previousDormitory,
      },
    );
  }
  if (!current)
    history.unshift({
      id: `${id}-outflow`,
      date: `2026-10-0${1 + (index % 8)}`,
      kind: 'outflow',
      title: 'Запись в оттоке',
      detail: `${dormName(dormitoryId)} · выезд из общежития`,
      dormitoryId,
      reason: reasons[index % 4],
    });
  return {
    id,
    number: String(1042 + index),
    name,
    role: ['Комплектовщик', 'Оператор линии', 'Упаковщик', 'Сборщик'][index % 4],
    dormitoryId,
    room: `Корпус А · комната ${201 + (index % 12)}`,
    phone: [4, 10, 15].includes(index)
      ? null
      : `+7 (000) 000-${String(10 + Math.floor(index / 10))}-${String(index % 10).padStart(2, '0')}`,
    current,
    start,
    end,
    history,
    shifts: [
      ...(start && end ? [{ start, end, dormitoryId, complete: !current }] : []),
      ...(history.some((event) => event.id.endsWith('old-arrival'))
        ? [
            {
              start: '2026-06-16',
              end: '2026-07-30',
              dormitoryId: previousDormitory,
              complete: true,
            },
          ]
        : []),
    ],
  };
});
// Один пример перевода внутри текущей вахты и повторного выхода после оттока.
const featured = people[0];
featured.end = '2026-10-14';
featured.history[0] = {
  id: 'featured-transfer',
  date: '2026-09-20',
  kind: 'transfer',
  title: 'Перевод в «Северное»',
  detail: 'Центральное → Северное · корпус А, комната 201',
  dormitoryId: 'north',
};
featured.history.push({
  id: 'featured-arrival',
  date: '2026-09-01',
  kind: 'arrival',
  title: 'Повторное заселение',
  detail: 'Центральное · начало новой вахты',
  dormitoryId: 'central',
});
featured.history.sort((a, b) => b.date.localeCompare(a.date));
featured.history.find((event) => event.kind === 'shift')!.detail =
  'Начало — 1 сентября · Центральное';
featured.shifts[0] = {
  start: '2026-09-01',
  end: '2026-10-14',
  dormitoryId: 'north',
  complete: false,
};
// Включаем пример окончания именно сегодня.
people[1].end = '2026-10-10';
people[1].shifts[0].end = '2026-10-10';

export const initialBlocks: Block[] = [
  {
    id: 'plans',
    kind: 'plans',
    title: blockNames.plans,
    scope: [],
    width: 'half',
    days: null,
    showPhone: false,
    presentation: 'distribution',
  },
  {
    id: 'tasks',
    kind: 'tasks',
    title: blockNames.tasks,
    scope: [],
    width: 'half',
    days: null,
    showPhone: false,
    presentation: 'distribution',
  },
  {
    id: 'residents',
    kind: 'residents',
    title: blockNames.residents,
    scope: [],
    width: 'half',
    days: null,
    showPhone: false,
    presentation: 'distribution',
  },
  {
    id: 'ending',
    kind: 'ending',
    title: blockNames.ending,
    scope: [],
    width: 'half',
    days: null,
    showPhone: true,
    presentation: 'distribution',
  },
  {
    id: 'contacts',
    kind: 'contacts',
    title: blockNames.contacts,
    scope: [],
    width: 'half',
    days: null,
    showPhone: true,
    presentation: 'distribution',
  },
  {
    id: 'outflow',
    kind: 'outflow',
    title: blockNames.outflow,
    scope: [],
    width: 'half',
    days: null,
    showPhone: false,
    presentation: 'distribution',
  },
];
export const blockStorageKey = 'domovoy:personnel-preview:v2';
export function readBlocks(): Block[] {
  try {
    const previous = localStorage.getItem('domovoy:personnel-preview:v1');
    const current = localStorage.getItem(blockStorageKey);
    const saved: unknown = JSON.parse(current ?? previous ?? 'null');
    if (
      Array.isArray(saved) &&
      saved.length <= 20 &&
      saved.every((block: unknown) => {
        if (!block || typeof block !== 'object') return false;
        const b = block as Record<string, unknown>;
        return (
          typeof b.id === 'string' &&
          typeof b.title === 'string' &&
          b.title.length <= 70 &&
          typeof b.kind === 'string' &&
          Object.hasOwn(blockNames, b.kind) &&
          Array.isArray(b.scope) &&
          b.scope.every((id) => dormitories.some((d) => d.id === id)) &&
          ['half', 'full'].includes(String(b.width)) &&
          typeof b.showPhone === 'boolean' &&
          (b.savedListId === undefined || typeof b.savedListId === 'string') &&
          ['distribution', 'total'].includes(String(b.presentation)) &&
          (b.days === null ||
            (typeof b.days === 'number' && Number.isInteger(b.days) && b.days >= 0 && b.days <= 90))
        );
      }) &&
      new Set(saved.map((b) => b.id)).size === saved.length
    )
      return current
        ? (saved as Block[])
        : [
            ...initialBlocks.filter(
              (b) => ['plans', 'tasks'].includes(b.kind) && !saved.some((old) => old.id === b.id),
            ),
            ...(saved as Block[]),
          ].slice(0, 20);
  } catch {
    /* Недоступное или устаревшее хранилище не мешает открыть макет. */
  }
  return initialBlocks.map((block) => ({ ...block, scope: [...block.scope] }));
}
