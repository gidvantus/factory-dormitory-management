import type {
  Arrival,
  Field,
  Person,
  Settings,
  Value,
} from '../../workspace/personnel/arrivals/data';
import { initialSettings } from '../../workspace/personnel/arrivals/data';
import { addDays } from '../../workspace/personnel/helpers';
import { DORMITORIES, TODAY } from '../arrival-settings-preview/data';

export { DORMITORIES, TODAY };
export type VisitStatus = 'expected' | 'arrived' | 'no_show' | 'moved' | 'settled';
export type VisitRef = { arrivalId: string; personId: string; date: string };
export type PlannedPerson = Person & {
  personKey: string;
  status: VisitStatus;
  card?: { id: string; number: string; phone: string };
  arrivedOn?: string;
  residentId?: string;
  from?: VisitRef;
  to?: VisitRef;
  previousStatus?: 'expected' | 'no_show';
  history: string[];
};
export type PlannedArrival = Omit<Arrival, 'people' | 'count'> & {
  people: PlannedPerson[];
  createdByMove?: boolean;
};
export type Residence = {
  id: string;
  personKey: string;
  employeeId: string;
  name: string;
  number: string;
  phone: string;
  dorm: string;
  hostel: string;
  settlementDate: string;
  start: string;
  end: string;
  shifts: string;
  source?: VisitRef;
  personalValues: Record<string, Value>;
  arrivalValues: Record<string, Value>;
  fields: Field[];
};
export type WorkflowState = { arrivals: PlannedArrival[]; residents: Residence[] };
export type SettlementInput = Pick<
  Residence,
  'number' | 'phone' | 'hostel' | 'settlementDate' | 'start' | 'end' | 'shifts'
>;

export const STATUS_LABELS: Record<VisitStatus, string> = {
  expected: 'Ожидается',
  arrived: 'Прибыл',
  no_show: 'Не приехал',
  moved: 'Перенесён',
  settled: 'В проживающих',
};
export const HOSTELS: Record<string, string[]> = {
  Северное: ['Корпус А', 'Корпус Б'],
  Центральное: ['Хостел «Центральный»', 'Корпус у проходной'],
  Парковое: ['Корпус 1', 'Корпус 2'],
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
    residents: [
      {
        id: 'resident-existing',
        personKey: 'existing',
        employeeId: 'employee-existing',
        name: 'Виктор Елисеев',
        number: '0038',
        phone: '+7 (900) 000-00-38',
        dorm: 'Северное',
        hostel: 'Корпус А',
        settlementDate: addDays(TODAY, -5),
        start: addDays(TODAY, -4),
        end: '',
        shifts: '30',
        personalValues: { brigade: 'Монтажная Б' },
        arrivalValues: {},
        fields: workflowSettings().fields,
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
  if (person.status === 'moved' || person.status === 'settled')
    throw new Error('Эта запись уже перенесена или оформлена в проживающие.');
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
  const moved: PlannedPerson = {
    ...person,
    status: 'moved',
    previousStatus: person.status as 'expected' | 'no_show',
    to: { arrivalId: targetId, personId: visitId, date },
    history: [...person.history, `Перенесён с ${arrival.date} на ${date}`],
  };
  const nextPerson: PlannedPerson = {
    ...person,
    id: visitId,
    status: 'expected',
    values: { ...person.values },
    from: { arrivalId, personId, date: arrival.date },
    to: undefined,
    previousStatus: undefined,
    arrivedOn: undefined,
    residentId: undefined,
    history: [...person.history, `Заезд перенесён с ${arrival.date} на ${date}`],
  };
  const next = replaceVisit(state, arrivalId, moved);
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

export function undoMove(state: WorkflowState, arrivalId: string, personId: string): WorkflowState {
  const { person } = findVisit(state, arrivalId, personId);
  if (person.status !== 'moved' || !person.to) throw new Error('У этой записи нет переноса.');
  const target = findVisit(state, person.to.arrivalId, person.to.personId);
  if (target.person.status !== 'expected')
    throw new Error(
      'В новой дате уже отмечено прибытие или выполнено другое действие. Отменить этот перенос нельзя.',
    );
  const next = replaceVisit(state, arrivalId, {
    ...person,
    status: person.previousStatus ?? 'expected',
    to: undefined,
    previousStatus: undefined,
    history: [...person.history, `Перенос на ${person.to.date} отменён`],
  });
  return {
    ...next,
    arrivals: next.arrivals
      .map((item) =>
        item.id === target.arrival.id
          ? { ...item, people: item.people.filter((entry) => entry.id !== target.person.id) }
          : item,
      )
      .filter((item) => !item.createdByMove || item.people.length > 0),
  };
}

export function settlementDefaults(person: PlannedPerson): SettlementInput {
  return {
    number: person.card?.number ?? '',
    phone: person.card?.phone ?? '',
    hostel: '',
    settlementDate: person.arrivedOn ?? TODAY,
    start: String(person.values.workdate || person.arrivedOn || TODAY),
    end: '',
    shifts: String(person.values.shifts ?? ''),
  };
}

export function settleVisit(
  state: WorkflowState,
  arrivalId: string,
  personId: string,
  input: SettlementInput,
  fields: Field[],
): WorkflowState {
  const { arrival, person } = findVisit(state, arrivalId, personId);
  if (person.status === 'settled') return state;
  if (person.status !== 'arrived') throw new Error('Сначала отметьте, что человек прибыл.');
  if (state.residents.some((item) => item.personKey === person.personKey))
    throw new Error('У этого человека уже есть действующее проживание.');
  if (!HOSTELS[arrival.dorm]?.includes(input.hostel)) throw new Error('Выберите место проживания.');
  if (
    !validDate(input.settlementDate) ||
    !validDate(input.start) ||
    (input.end && (!validDate(input.end) || input.end < input.start))
  )
    throw new Error('Проверьте даты: окончание вахты не может быть раньше начала.');
  if (input.shifts && (!/^\d+$/.test(input.shifts) || Number(input.shifts) > 100000))
    throw new Error('Количество смен должно быть целым числом от 0 до 100 000.');
  if (
    input.number.trim() &&
    state.residents.some(
      (item) => item.number === input.number.trim() && item.personKey !== person.personKey,
    )
  )
    throw new Error('Такой табельный номер уже есть у другого проживающего.');
  const id = crypto.randomUUID();
  const resident: Residence = {
    ...input,
    id,
    personKey: person.personKey,
    employeeId: person.card?.id ?? crypto.randomUUID(),
    name: person.name.trim(),
    dorm: arrival.dorm,
    number: input.number.trim(),
    phone: input.phone.trim(),
    source: { arrivalId, personId, date: arrival.date },
    personalValues: { ...person.values },
    arrivalValues: { ...arrival.values },
    fields: structuredClone(fields),
  };
  const next = replaceVisit(state, arrivalId, {
    ...person,
    status: 'settled',
    residentId: id,
    history: [
      ...person.history,
      `Оформлен в проживающие · ${input.settlementDate} · ${input.hostel}`,
    ],
  });
  return { ...next, residents: [resident, ...next.residents] };
}

export function counts(arrivals: PlannedArrival[]): Record<VisitStatus, number> {
  return arrivals
    .flatMap((arrival) => arrival.people)
    .reduce((result, person) => ({ ...result, [person.status]: result[person.status] + 1 }), {
      expected: 0,
      arrived: 0,
      no_show: 0,
      moved: 0,
      settled: 0,
    });
}
