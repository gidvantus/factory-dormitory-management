export type Cell = string | number | boolean;
export type Field = { id: string; name: string; kind: 'text' | 'number' | 'date' | 'checkbox' };
export type DataRow = Record<string, Cell>;
export type Source = { id: string; group: string; name: string; fields: Field[]; rows: DataRow[] };
export type Condition = { id: string; field: string; operator: string; value: string };
export type Block = {
  id: string;
  sourceId: string;
  title: string;
  fields: string[];
  scope: string;
  period: 'day' | 'yesterday' | 'week' | 'month' | 'all';
  dateField: string;
  format: 'rows' | 'count' | 'sum';
  sumField: string;
  match: 'all' | 'any';
  conditions: Condition[];
};
export type Schedule = {
  frequency: 'event' | 'daily' | 'weekly' | 'monthly' | 'interval' | 'once';
  times: string[];
  weekdays: number[];
  monthDay: number;
  interval: number;
  onceDate: string;
  timezone: string;
  weekends: boolean;
};
export type NotificationDraft = {
  id: string;
  name: string;
  enabled: boolean;
  intro: string;
  empty: 'skip' | 'send';
  blocks: Block[];
  schedule: Schedule;
};

const text = (id: string, name: string): Field => ({ id, name, kind: 'text' });
const number = (id: string, name: string): Field => ({ id, name, kind: 'number' });
const date = (id: string, name: string): Field => ({ id, name, kind: 'date' });
const dailyDates = ['2026-11-03', '2026-11-07', '2026-11-08', '2026-11-09'];
const people = ['Алексей Волков', 'Дмитрий Орлов', 'Анна Соколова', 'Иван Петров'];
export const SOURCES: Source[] = [
  {
    id: 'arrivals',
    group: 'Персонал',
    name: 'План заездов',
    fields: [
      text('name', 'ФИО'),
      date('date', 'Дата заезда'),
      text('dormitory', 'Общежитие'),
      text('status', 'Статус'),
      number('shifts', 'Количество смен'),
      text('phone', 'Телефон'),
    ],
    rows: dailyDates.flatMap((value, i) => [
      {
        name: people[i],
        date: value,
        dormitory: 'Северное',
        status: 'Ожидается',
        shifts: 30,
        phone: '+7 (900) 000-00-01',
      },
      {
        name: people[(i + 1) % 4],
        date: value,
        dormitory: 'Центральное',
        status: 'Ожидается',
        shifts: 45,
        phone: '+7 (900) 000-00-02',
      },
    ]),
  },
  {
    id: 'residents',
    group: 'Общежития',
    name: 'Проживающие',
    fields: [
      text('name', 'ФИО'),
      text('dormitory', 'Общежитие'),
      text('room', 'Комната'),
      text('number', 'Табельный номер'),
      date('date', 'Конец вахты'),
      number('shifts', 'Количество смен'),
      text('medical', 'ЛМК'),
    ],
    rows: dailyDates.map((value, i) => ({
      name: people[i],
      dormitory: i % 2 ? 'Центральное' : 'Северное',
      room: ['214', '108', '305', '202'][i],
      number: `0012${i}`,
      date: value,
      shifts: 30 + i,
      medical: i % 2 ? 'Нет' : 'Есть',
    })),
  },
  {
    id: 'places',
    group: 'Общежития',
    name: 'Размещение персонала',
    fields: [
      text('dormitory', 'Общежитие'),
      text('hostel', 'Хостел'),
      date('date', 'Дата'),
      number('paid', 'Оплачено мест'),
      number('occupied', 'Проживает'),
      number('free', 'Свободных мест'),
    ],
    rows: dailyDates.flatMap((value, i) => [
      {
        dormitory: 'Северное',
        hostel: 'Корпус А',
        date: value,
        paid: 120,
        occupied: 108 + i,
        free: 12 - i,
      },
      {
        dormitory: 'Центральное',
        hostel: 'Главный корпус',
        date: value,
        paid: 80,
        occupied: 74 - i,
        free: 6 + i,
      },
    ]),
  },
  {
    id: 'advance',
    group: 'Общежития',
    name: 'На аванс',
    fields: [
      text('name', 'ФИО'),
      text('dormitory', 'Общежитие'),
      number('amount', 'Сумма аванса'),
      date('date', 'Дата записи'),
      text('number', 'Табельный номер'),
    ],
    rows: dailyDates.map((value, i) => ({
      name: people[i],
      dormitory: 'Северное',
      amount: 5000 + i * 2000,
      date: value,
      number: `0012${i}`,
    })),
  },
  {
    id: 'settlement',
    group: 'Общежития',
    name: 'На расчёт',
    fields: [
      text('name', 'ФИО'),
      text('dormitory', 'Общежитие'),
      date('date', 'Дата расчёта'),
      number('amount', 'Сумма расчёта'),
    ],
    rows: dailyDates.map((value, i) => ({
      name: people[i],
      dormitory: 'Центральное',
      date: value,
      amount: 42000 + i * 1000,
    })),
  },
  ...(['inflow', 'outflow'] as const).map((id): Source => ({
    id,
    group: 'Общежития',
    name: id === 'inflow' ? 'Приток' : 'Отток',
    fields: [
      text('name', 'ФИО'),
      text('dormitory', 'Общежитие'),
      date('date', id === 'inflow' ? 'Дата заселения' : 'Дата выезда'),
      text('reason', 'Примечание'),
    ],
    rows: dailyDates.map((value, i) => ({
      name: people[i],
      dormitory: 'Северное',
      date: value,
      reason: id === 'inflow' ? 'Новая вахта' : 'Вахта завершена',
    })),
  })),
  {
    id: 'report',
    group: 'Общежития',
    name: 'Общий отчёт',
    fields: [
      text('dormitory', 'Общежитие'),
      date('date', 'Дата'),
      number('attendance', 'Выход на смену'),
      number('inflow', 'Приток за день'),
      number('outflow', 'Отток за день'),
    ],
    rows: dailyDates.map((value, i) => ({
      dormitory: 'Северное',
      date: value,
      attendance: 98 + i,
      inflow: i + 2,
      outflow: i,
    })),
  },
  {
    id: 'employees',
    group: 'Персонал',
    name: 'Сотрудники',
    fields: [
      text('name', 'ФИО'),
      text('position', 'Должность'),
      text('department', 'Подразделение'),
      text('status', 'Статус'),
      date('date', 'Дата приёма'),
    ],
    rows: dailyDates.map((value, i) => ({
      name: people[i],
      position: 'Комплектовщик',
      department: 'Склад',
      status: 'Работает',
      date: value,
    })),
  },
  {
    id: 'documents',
    group: 'Документы и свои таблицы',
    name: 'Документы / Проверки',
    fields: [
      text('name', 'Сотрудник'),
      text('document', 'Документ'),
      date('date', 'Срок действия'),
      text('status', 'Статус'),
      text('responsible', 'Ответственный'),
    ],
    rows: dailyDates.map((value, i) => ({
      name: people[i],
      document: 'Медицинская книжка',
      date: value,
      status: 'Проверить',
      responsible: 'Мария Смирнова',
    })),
  },
  {
    id: 'custom',
    group: 'Документы и свои таблицы',
    name: 'Своя таблица / Заявки на ремонт',
    fields: [
      text('title', 'Заявка'),
      text('dormitory', 'Общежитие'),
      text('room', 'Комната'),
      text('status', 'Статус'),
      date('date', 'Дата заявки'),
      number('cost', 'Стоимость'),
    ],
    rows: dailyDates.map((value, i) => ({
      title: ['Заменить лампу', 'Починить замок', 'Проверить кран', 'Заменить розетку'][i],
      dormitory: 'Северное',
      room: '214',
      status: 'Новая',
      date: value,
      cost: 500 + i * 300,
    })),
  },
  {
    id: 'organization',
    group: 'Компания',
    name: 'Организация',
    fields: [
      text('title', 'Название'),
      text('inn', 'ИНН'),
      text('email', 'Рабочая почта'),
      text('address', 'Адрес'),
    ],
    rows: [
      {
        title: 'ООО «Технопром»',
        inn: '0000000000',
        email: 'example@example.com',
        address: 'Демонстрационный адрес',
      },
    ],
  },
];

export const FREQUENCIES: Record<Schedule['frequency'], string> = {
  event: 'При изменении данных',
  daily: 'Ежедневно',
  weekly: 'Еженедельно',
  monthly: 'Ежемесячно',
  interval: 'Через интервал',
  once: 'Один раз',
};
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const OPERATORS: Record<string, string> = {
  equals: 'равно',
  not_equals: 'не равно',
  contains: 'содержит',
  greater: 'больше',
  less: 'меньше',
  filled: 'заполнено',
  empty: 'не заполнено',
  today: 'сегодня',
  next_days: 'в ближайшие дни',
};
export const uid = (): string => globalThis.crypto.randomUUID();
export const sourceFor = (id: string): Source =>
  SOURCES.find((source) => source.id === id) ?? SOURCES[0];
export function makeBlock(sourceId: string): Block {
  const source = sourceFor(sourceId);
  return {
    id: uid(),
    sourceId,
    title: source.name,
    fields: source.fields.slice(0, 3).map((field) => field.id),
    scope: 'all',
    period: source.fields.some((field) => field.kind === 'date') ? 'day' : 'all',
    dateField: source.fields.find((field) => field.kind === 'date')?.id ?? '',
    format: 'rows',
    sumField: source.fields.find((field) => field.kind === 'number')?.id ?? '',
    match: 'all',
    conditions: [],
  };
}
export function makeDraft(name = 'Утренняя сводка'): NotificationDraft {
  const draft: NotificationDraft = {
    id: uid(),
    name,
    enabled: true,
    intro: 'Что сегодня в общежитиях',
    empty: 'skip',
    blocks: [makeBlock('arrivals'), makeBlock('places')],
    schedule: {
      frequency: 'daily',
      times: ['09:00'],
      weekdays: [0, 1, 2, 3, 4],
      monthDay: 1,
      interval: 3,
      onceDate: '2026-11-09',
      timezone: 'Europe/Moscow',
      weekends: false,
    },
  };
  draft.blocks[0].title = 'Заезды на сегодня';
  draft.blocks[1].title = 'Свободные места';
  draft.blocks[1].fields = ['dormitory', 'free'];
  return draft;
}
export const DEMO_TODAY = '2026-11-03';
export const DEMO_MONDAY = '2026-11-09';
const dayNumber = (value: string): number => Date.parse(`${value}T00:00:00Z`) / 86400000;
export function dateLabel(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))
    return 'Выберите дату';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}
export function cellLabel(value: Cell | undefined, field?: Field): string {
  if (value === undefined || value === '') return '—';
  if (field?.kind === 'date') return dateLabel(String(value));
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return typeof value === 'number' ? new Intl.NumberFormat('ru-RU').format(value) : value;
}
export function matchesCondition(row: DataRow, condition: Condition, today: string): boolean {
  const actual = row[condition.field];
  const value = String(actual ?? '');
  switch (condition.operator) {
    case 'filled':
      return value.trim() !== '';
    case 'empty':
      return value.trim() === '';
    case 'equals':
      return value.toLocaleLowerCase('ru') === condition.value.toLocaleLowerCase('ru');
    case 'not_equals':
      return (
        value !== '' && value.toLocaleLowerCase('ru') !== condition.value.toLocaleLowerCase('ru')
      );
    case 'contains':
      return value.toLocaleLowerCase('ru').includes(condition.value.toLocaleLowerCase('ru'));
    case 'greater':
      return Number(actual) > Number(condition.value);
    case 'less':
      return Number(actual) < Number(condition.value);
    case 'today':
      return value === today;
    case 'next_days':
      return (
        dayNumber(value) >= dayNumber(today) &&
        dayNumber(value) <= dayNumber(today) + Number(condition.value)
      );
    default:
      return false;
  }
}
export type PreviewGroup = { label: string; rows: DataRow[]; weekend: boolean };
export function previewGroups(
  block: Block,
  dispatchDay: string,
  weekends: boolean,
): PreviewGroup[] {
  const source = sourceFor(block.sourceId);
  const monday = new Date(`${dispatchDay}T12:00:00Z`).getUTCDay() === 1;
  const carry = !weekends && monday;
  const reference = dayNumber(dispatchDay);
  const rows = source.rows.filter((row) => {
    if (block.scope !== 'all' && row.dormitory !== block.scope) return false;
    const recordDay = String(row[block.dateField] ?? '');
    const relativeDay =
      carry && [reference - 1, reference - 2].includes(dayNumber(recordDay))
        ? recordDay
        : dispatchDay;
    const checks = block.conditions.map((condition) =>
      matchesCondition(row, condition, relativeDay),
    );
    if (checks.length && !(block.match === 'all' ? checks.every(Boolean) : checks.some(Boolean)))
      return false;
    if (!block.dateField || block.period === 'all') return true;
    const value = String(row[block.dateField] ?? '');
    const day = dayNumber(value);
    if (carry && (day === reference - 1 || day === reference - 2)) return true;
    if (block.period === 'day') return day === reference;
    if (block.period === 'yesterday') return day === reference - 1;
    if (block.period === 'week') return day >= reference - 6 && day <= reference;
    return value.slice(0, 7) === dispatchDay.slice(0, 7) && day <= reference;
  });
  if (!carry || !block.dateField) return [{ label: '', rows, weekend: false }];
  const weekendDate = (offset: number): string =>
    new Date((reference - offset) * 86400000).toISOString().slice(0, 10);
  const saturday = weekendDate(2);
  const sunday = weekendDate(1);
  return [
    {
      label:
        block.period === 'day'
          ? `За понедельник, ${dateLabel(dispatchDay)}`
          : 'Остальные данные за выбранный период',
      rows: rows.filter((row) => ![saturday, sunday].includes(String(row[block.dateField]))),
      weekend: false,
    },
    {
      label: `За субботу, ${dateLabel(saturday)}`,
      rows: rows.filter((row) => row[block.dateField] === saturday),
      weekend: true,
    },
    {
      label: `За воскресенье, ${dateLabel(sunday)}`,
      rows: rows.filter((row) => row[block.dateField] === sunday),
      weekend: true,
    },
  ].filter((group) => group.rows.length > 0);
}
export function groupLines(block: Block, group: PreviewGroup): string[] {
  const source = sourceFor(block.sourceId);
  if (block.format === 'count') return [`Количество записей: ${group.rows.length}`];
  if (block.format === 'sum') {
    const field = source.fields.find((item) => item.id === block.sumField);
    return [
      `${field?.name ?? 'Сумма'}: ${cellLabel(group.rows.reduce((total, row) => total + Number(row[block.sumField] || 0), 0))}`,
    ];
  }
  return group.rows.map((row) =>
    block.fields
      .map((id) =>
        (() => {
          const field = source.fields.find((item) => item.id === id);
          const value = cellLabel(row[id], field);
          return field?.kind === 'number' || field?.kind === 'checkbox'
            ? `${field.name}: ${value}`
            : value;
        })(),
      )
      .join(' · '),
  );
}
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.frequency === 'event') return 'После изменения подходящих данных';
  const time = schedule.times.join(' и ');
  if (schedule.frequency === 'once')
    return `${dateLabel(schedule.onceDate)} в ${schedule.times[0]}`;
  if (schedule.frequency === 'interval')
    return `Каждые ${schedule.interval} ч, начиная с ${schedule.times[0]}`;
  if (schedule.frequency === 'weekly')
    return `${schedule.weekdays.map((day) => WEEKDAYS[day]).join(', ')} в ${time}`;
  if (schedule.frequency === 'monthly') return `${schedule.monthDay}-го числа в ${time}`;
  return `${schedule.weekends ? 'Каждый день' : 'По будням'} в ${time}`;
}

/** Следующие календарные отправки в выбранном часовом поясе, включая перенос на понедельник. */
export function nextDispatches(
  schedule: Schedule,
  now = new Date(),
): { day: string; time: string }[] {
  if (schedule.frequency === 'event') return [];
  if (schedule.frequency === 'once' && !Number.isFinite(Date.parse(schedule.onceDate))) return [];
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: schedule.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const [today, currentTime] = parts.split(' ');
  const start = new Date(`${today}T12:00:00Z`);
  const results: { day: string; time: string }[] = [];
  for (let offset = 0; offset < 100 && results.length < 3; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 86400000);
    const day = candidate.toISOString().slice(0, 10);
    const weekday = (candidate.getUTCDay() + 6) % 7;
    if (!schedule.weekends && weekday > 4) continue;
    const catchUp = !schedule.weekends && weekday === 0;
    if (schedule.frequency === 'weekly' && !schedule.weekdays.includes(weekday) && !catchUp)
      continue;
    if (schedule.frequency === 'monthly') {
      const lastDay = new Date(
        Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const due = Math.min(schedule.monthDay, lastDay);
      // Понедельник добавляется только если месячная дата попала на эти выходные.
      const carried =
        catchUp &&
        [1, 2].some((back) => {
          const previous = new Date(candidate.getTime() - back * 86400000);
          const end = new Date(
            Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 0),
          ).getUTCDate();
          return previous.getUTCDate() === Math.min(schedule.monthDay, end);
        });
      if (candidate.getUTCDate() !== due && !carried) continue;
    }
    if (schedule.frequency === 'once') {
      const original = new Date(`${schedule.onceDate}T12:00:00Z`);
      const originalWeekday = original.getUTCDay();
      const shift =
        !schedule.weekends && (originalWeekday === 0 || originalWeekday === 6)
          ? originalWeekday === 6
            ? 2
            : 1
          : 0;
      const target = new Date(original.getTime() + shift * 86400000).toISOString().slice(0, 10);
      if (day !== target) continue;
    }
    let times = [
      ...new Set(schedule.frequency === 'once' ? schedule.times.slice(0, 1) : schedule.times),
    ]
      .filter(Boolean)
      .sort();
    if (schedule.frequency === 'interval') {
      const [hour, minute] = schedule.times[0].split(':').map(Number);
      times = Array.from(
        { length: Math.ceil((24 - hour) / schedule.interval) },
        (_, index) =>
          `${String(hour + index * schedule.interval).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      );
    }
    for (const time of times) {
      if (day === today && time <= currentTime) continue;
      results.push({ day, time });
      if (results.length === 3) break;
    }
  }
  return results;
}
