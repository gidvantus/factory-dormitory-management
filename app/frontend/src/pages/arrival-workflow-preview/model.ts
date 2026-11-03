import type { Arrival, Person, Settings } from '../../workspace/personnel/arrivals/data';
import { initialSettings } from '../../workspace/personnel/arrivals/data';
import { addDays } from '../../workspace/personnel/helpers';
import { DORMITORIES, TODAY } from '../arrival-settings-preview/data';

export { DORMITORIES, TODAY };
export type VisitStatus = 'expected' | 'arrived' | 'no_show';
export type VisitRef = { arrivalId: string; personId: string; date: string };
export type PlannedPerson = Person & {
  personKey: string;
  status: VisitStatus;
  card?: { id: string; number: string; phone: string };
  arrivedOn?: string;
  from?: VisitRef;
  history: string[];
};
export type PlannedArrival = Omit<Arrival, 'people' | 'count'> & {
  people: PlannedPerson[];
  createdByMove?: boolean;
};
export type WorkflowState = { arrivals: PlannedArrival[] };

export const STATUS_LABELS: Record<VisitStatus, string> = {
  expected: 'Ожидается',
  arrived: 'Прибыл',
  no_show: 'Не приехал',
};

export function workflowSettings(): Settings {
  const settings = initialSettings();
  settings.fields.push({
    id: 'brigade',
    label: 'Бригада',
    type: 'text',
    scope: 'person',
    inForm: true,
    required: false,
    options: [],
  });
  settings.display.order.push('brigade');
  settings.display.visible.push('brigade');
  settings.display.namesLimit = 4;
  return settings;
}

function demoPerson(id: string, name: string, shifts: string, brigade: string): PlannedPerson {
  return {
    id,
    personKey: id,
    name,
    values: { shifts, brigade, workdate: addDays(TODAY, 1) },
    status: 'expected',
    history: [],
  };
}

export function initialWorkflow(): WorkflowState {
  const alex = demoPerson('alex', 'Александр Волков', '15', 'Монтажная А');
  alex.card = { id: 'employee-alex', number: '0041', phone: '+7 (900) 000-00-41' };
  return {
    arrivals: [
      {
        id: 'north',
        dorm: 'Северное',
        date: TODAY,
        people: [
          alex,
          demoPerson('mikhail', 'Михаил Соколов', '30', 'Монтажная Б'),
          demoPerson('anna', 'Анна Морозова', '15', 'Отделка'),
          demoPerson('dmitry', 'Дмитрий Орлов', '30', 'Монтажная А'),
        ],
        values: {
          transfer: true,
          transport: 'Автобус',
          comment: 'Встреча у проходной в 09:00. С собой паспорт и направление.',
        },
      },
      {
        id: 'central',
        dorm: 'Центральное',
        date: TODAY,
        people: [
          demoPerson('elena', 'Елена Козлова', '30', 'Упаковка'),
          demoPerson('andrey', 'Андрей Белов', '15', 'Склад'),
        ],
        values: { transfer: false, transport: 'Самостоятельно' },
      },
      {
        id: 'tomorrow',
        dorm: 'Парковое',
        date: addDays(TODAY, 1),
        people: [demoPerson('sergey', 'Сергей Никитин', '30', 'Монтажная Б')],
        values: { transport: 'Поезд', transfer: true },
      },
      {
        id: 'target',
        dorm: 'Северное',
        date: addDays(TODAY, 2),
        people: [demoPerson('pavel', 'Павел Ильин', '30', 'Монтажная А')],
        values: { transport: 'Самостоятельно', comment: 'Заезд после 14:00.' },
      },
    ],
  };
}

export function asArrival(arrival: PlannedArrival): Arrival {
  return { ...arrival, count: String(arrival.people.length) };
}

export function findVisit(
  state: WorkflowState,
  arrivalId: string,
  personId: string,
): { arrival: PlannedArrival; person: PlannedPerson } {
  const arrival = state.arrivals.find((item) => item.id === arrivalId);
  const person = arrival?.people.find((item) => item.id === personId);
  if (!arrival || !person) throw new Error('Запись заезда не найдена.');
  return { arrival, person };
}

function replaceVisit(
  state: WorkflowState,
  arrivalId: string,
  person: PlannedPerson,
): WorkflowState {
  return {
    ...state,
    arrivals: state.arrivals.map((arrival) =>
      arrival.id === arrivalId
        ? {
            ...arrival,
            people: arrival.people.map((item) => (item.id === person.id ? person : item)),
          }
        : arrival,
    ),
  };
}

export function markVisit(
  state: WorkflowState,
  arrivalId: string,
  personId: string,
  status: 'arrived' | 'no_show' | 'expected',
): WorkflowState {
  const { person } = findVisit(state, arrivalId, personId);
  if (person.status === status) return state;
  if (!person.name.trim()) throw new Error('Сначала укажите ФИО человека.');
  if (status !== 'expected' && person.status !== 'expected')
    throw new Error('Сначала верните человека в ожидаемые.');
  return replaceVisit(state, arrivalId, {
    ...person,
    status,
    arrivedOn: status === 'arrived' ? TODAY : undefined,
    history: [...person.history, `${STATUS_LABELS[status]} · ${TODAY}`],
  });
}

export function validDate(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

export function moveVisit(
  state: WorkflowState,
  arrivalId: string,
  personId: string,
  date: string,
): WorkflowState {
  const { arrival, person } = findVisit(state, arrivalId, personId);
  if (!validDate(date) || date === arrival.date) throw new Error('Выберите другую дату заезда.');
  if (!person.name.trim()) throw new Error('Сначала укажите ФИО человека.');
  if (!['expected', 'no_show'].includes(person.status))
    throw new Error('Перенести можно человека, который ещё не прибыл.');
  const target = state.arrivals.find((item) => item.dorm === arrival.dorm && item.date === date);
  if (target?.people.some((item) => item.personKey === person.personKey))
    throw new Error('Этот человек уже есть в плане на выбранный день.');
  const targetId = target?.id ?? crypto.randomUUID();
  const visitId = crypto.randomUUID();
  const nextPerson: PlannedPerson = {
    ...person,
    id: visitId,
    status: 'expected',
    values: { ...person.values },
    from: { arrivalId, personId, date: arrival.date },
    arrivedOn: undefined,
    history: [...person.history],
  };
  const next = {
    ...state,
    arrivals: state.arrivals
      .map((item) =>
        item.id === arrivalId
          ? { ...item, people: item.people.filter((entry) => entry.id !== personId) }
          : item,
      )
      .filter((item) => item.people.length > 0),
  };
  return {
    ...next,
    arrivals: target
      ? next.arrivals.map((item) =>
          item.id === targetId ? { ...item, people: [...item.people, nextPerson] } : item,
        )
      : [
          ...next.arrivals,
          {
            id: targetId,
            dorm: arrival.dorm,
            date,
            people: [nextPerson],
            values: { ...arrival.values },
            createdByMove: true,
          },
        ],
  };
}

export function counts(arrivals: PlannedArrival[]): Record<VisitStatus, number> {
  return arrivals
    .flatMap((arrival) => arrival.people)
    .reduce((result, person) => ({ ...result, [person.status]: result[person.status] + 1 }), {
      expected: 0,
      arrived: 0,
      no_show: 0,
    });
}
