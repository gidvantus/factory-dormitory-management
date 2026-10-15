export const designs = [
  {
    name: 'Иллюстрации',
    note: 'Знакомые таблицы, небольшие сюжетные рисунки, аватары и мягкие цветные акценты.',
  },
  {
    name: 'Инфографика',
    note: 'Вахты видны на шкалах, заезды — по дням недели. Цифры дополняют компактные диаграммы.',
  },
  {
    name: 'Открытая лента',
    note: 'Сотрудники — открытым списком, заезды — по линии времени. Меньше рамок и вложенных карточек.',
  },
  {
    name: 'Папки',
    note: 'Сотрудники и заезды разложены по общежитиям. Цветные ярлыки и бумажное оформление.',
  },
  {
    name: 'Главный акцент',
    note: 'Список рядом с выбранным сотрудником или датой. Подробности всегда перед глазами.',
  },
] as const;

export const TODAY = '2026-10-15';
export const dorms = ['Северное', 'Центральное', 'Парковое'];
export type Employee = {
  id: number;
  name: string;
  dorm: string;
  room: string;
  end: string;
  phone: string;
  current: boolean;
};
export const employees: Employee[] = [
  {
    id: 1,
    name: 'Александр Волков',
    dorm: 'Северное',
    room: '201 · место 2',
    end: '2026-10-16',
    phone: '+7 (900) 000-00-01',
    current: true,
  },
  {
    id: 2,
    name: 'Михаил Соколов',
    dorm: 'Центральное',
    room: '104 · место 1',
    end: '2026-10-19',
    phone: '+7 (900) 000-00-02',
    current: true,
  },
  {
    id: 3,
    name: 'Анна Морозова',
    dorm: 'Парковое',
    room: '302 · место 1',
    end: '2026-10-28',
    phone: '+7 (900) 000-00-03',
    current: true,
  },
  {
    id: 4,
    name: 'Сергей Козлов',
    dorm: 'Северное',
    room: '205 · место 3',
    end: '2026-10-21',
    phone: '+7 (900) 000-00-04',
    current: true,
  },
  {
    id: 5,
    name: 'Елена Белова',
    dorm: 'Парковое',
    room: '301 · место 2',
    end: '2026-10-17',
    phone: '+7 (900) 000-00-05',
    current: true,
  },
  {
    id: 6,
    name: 'Иван Лебедев',
    dorm: 'Центральное',
    room: '—',
    end: '2026-10-09',
    phone: '+7 (900) 000-00-06',
    current: false,
  },
];
export type Arrival = { id: number; dorm: string; date: string; count: number; names: string };
export const initialArrivals: Arrival[] = [
  { id: 1, dorm: 'Северное', date: TODAY, count: 6, names: 'А. Смирнов, П. Кузнецов' },
  { id: 2, dorm: 'Парковое', date: '2026-10-16', count: 4, names: 'Р. Фёдоров, А. Попов' },
  { id: 3, dorm: 'Центральное', date: '2026-10-17', count: 8, names: 'В. Петров, Н. Васильев' },
  { id: 4, dorm: 'Северное', date: '2026-10-19', count: 3, names: 'ФИО пока не указаны' },
  { id: 5, dorm: 'Центральное', date: '2026-10-21', count: 7, names: 'Д. Орлов, И. Захаров' },
];
export const addDays = (date: string, count: number): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};
export const dateLabel = (date: string): string =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
export const weekday = (date: string): string =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
export const monthLabel = (date: string, long = false): string =>
  new Intl.DateTimeFormat('ru-RU', { month: long ? 'long' : 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
export const daysLeft = (person: Employee): number =>
  Math.round((Date.parse(person.end) - Date.parse(TODAY)) / 86400000);
export const initials = (name: string): string =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
export const extraNames = {
  ending: 'Заканчивается вахта',
  contacts: 'Контакты сотрудников',
  saved: 'Сохранённый список',
  plans: 'Ближайшие заезды',
  residents: 'По общежитиям',
};
export type ExtraKind = keyof typeof extraNames;
export type ExtraBlock = { id: string; kind: ExtraKind; title: string; wide: boolean };
