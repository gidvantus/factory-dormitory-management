import type { Arrival, Person, Value } from '../../workspace/personnel/arrivals/data';
import { peopleAtCount } from '../../workspace/personnel/arrivals/data';
export * from '../../workspace/personnel/arrivals/data';
export const TODAY = '2026-10-27';
export const DORMITORIES = ['Северное', 'Центральное', 'Парковое'];

export function initialArrivals(): Arrival[] {
  return [
    {
      id: 'north',
      dorm: 'Северное',
      date: TODAY,
      count: '12',
      people: demoPeople(
        12,
        ['Александр Волков', 'Михаил Соколов', 'Дмитрий Орлов', 'Андрей Белов'],
        ['15', '30', '45', '30'],
        '2026-10-28',
      ),
      values: {
        transfer: true,
        transport: 'Автобус',
        comment: 'Встреча у проходной в 09:00.',
      },
    },
    {
      id: 'central',
      dorm: 'Центральное',
      date: TODAY,
      count: '6',
      people: demoPeople(6, ['Анна Морозова', 'Елена Козлова'], ['15', '30'], '2026-10-29'),
      values: {
        transfer: false,
        transport: 'Самостоятельно',
      },
    },
    {
      id: 'next',
      dorm: 'Парковое',
      date: '2026-10-28',
      count: '8',
      people: peopleAtCount([], 8),
      values: { transfer: true, transport: 'Поезд' },
    },
    {
      id: 'later',
      dorm: 'Северное',
      date: '2026-10-30',
      count: '10',
      people: peopleAtCount([], 10),
      values: { transfer: false },
    },
    {
      id: 'weekend',
      dorm: 'Центральное',
      date: '2026-11-01',
      count: '4',
      people: peopleAtCount([], 4),
      values: {},
    },
  ];
}

function demoPeople(count: number, names: string[], shifts: string[], date: string): Person[] {
  return peopleAtCount([], count).map((person, index) => {
    const values: Record<string, Value> = {};
    if (index < names.length) {
      values.shifts = shifts[index];
      values.workdate = date;
    }
    return { ...person, name: names[index] ?? '', values };
  });
}
