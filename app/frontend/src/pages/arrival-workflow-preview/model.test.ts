import { describe, expect, it } from 'vitest';
import { addDays } from '../../workspace/personnel/helpers';
import {
  counts,
  findVisit,
  initialWorkflow,
  markVisit,
  moveVisit,
  settleVisit,
  settlementDefaults,
  TODAY,
  undoMove,
  workflowSettings,
} from './model';

describe('прототип связи заезда и проживания', () => {
  it('переносит только одного человека в существующий день, сохраняет личные поля и общие сведения целевого дня', () => {
    const original = initialWorkflow();
    const moved = moveVisit(original, 'north', 'anna', addDays(TODAY, 2));
    const source = findVisit(moved, 'north', 'anna').person;
    expect(source.status).toBe('moved');
    expect(source.to?.arrivalId).toBe('target');
    const target = findVisit(moved, 'target', source.to!.personId);
    expect(target.person.status).toBe('expected');
    expect(target.person.personKey).toBe('anna');
    expect(target.person.values).toEqual(findVisit(original, 'north', 'anna').person.values);
    expect(target.person.from).toEqual({ arrivalId: 'north', personId: 'anna', date: TODAY });
    expect(target.arrival.values).toEqual(
      original.arrivals.find((arrival) => arrival.id === 'target')!.values,
    );
    expect(target.arrival.people).toHaveLength(2);
    expect(counts(moved.arrivals).expected).toBe(counts(original.arrivals).expected);
    expect(counts(moved.arrivals.filter((arrival) => arrival.date === TODAY)).expected).toBe(5);
    expect(original.arrivals[0].people[2].status).toBe('expected');
    expect(moved.arrivals[0].people[0]).toBe(original.arrivals[0].people[0]);
  });
  it('создаёт новый день и отменяет перенос без пустого заезда', () => {
    let state = markVisit(initialWorkflow(), 'north', 'anna', 'no_show');
    state = moveVisit(state, 'north', 'anna', addDays(TODAY, 8));
    const source = findVisit(state, 'north', 'anna').person;
    expect(state.arrivals).toHaveLength(5);
    const target = findVisit(state, source.to!.arrivalId, source.to!.personId);
    expect(target.arrival.values).toEqual(state.arrivals[0].values);
    state = undoMove(state, 'north', 'anna');
    expect(state.arrivals).toHaveLength(4);
    expect(findVisit(state, 'north', 'anna').person.status).toBe('no_show');
  });
  it('не позволяет отменой переноса потерять уже отмеченное прибытие', () => {
    let state = moveVisit(initialWorkflow(), 'north', 'anna', addDays(TODAY, 2));
    const destination = findVisit(state, 'north', 'anna').person.to!;
    state = markVisit(state, destination.arrivalId, destination.personId, 'arrived');
    expect(() => undoMove(state, 'north', 'anna')).toThrow('Отменить этот перенос нельзя');
    expect(() => moveVisit(state, 'north', 'anna', addDays(TODAY, 3))).toThrow();
  });
  it('прибывший ещё не проживающий; заселение использует существующую карточку, сохраняет скрытые поля и не создаёт дубликат', () => {
    let state = markVisit(initialWorkflow(), 'north', 'alex', 'arrived');
    expect(state.residents).toHaveLength(1);
    const draft = {
      ...settlementDefaults(findVisit(state, 'north', 'alex').person),
      hostel: 'Корпус Б',
      end: '2026-11-20',
    };
    const fields = workflowSettings().fields;
    state = settleVisit(state, 'north', 'alex', draft, fields);
    const resident = state.residents[0];
    expect(resident).toMatchObject({
      name: 'Александр Волков',
      employeeId: 'employee-alex',
      number: '0041',
      shifts: '15',
      hostel: 'Корпус Б',
      source: { arrivalId: 'north', personId: 'alex', date: TODAY },
    });
    expect(resident.personalValues.brigade).toBe('Монтажная А');
    expect(resident.arrivalValues.comment).toContain('Встреча у проходной');
    expect(resident.fields).toEqual(fields);
    expect(resident.fields).not.toBe(fields);
    expect(findVisit(state, 'north', 'alex').person.status).toBe('settled');
    expect(settleVisit(state, 'north', 'alex', draft, fields)).toBe(state);
    expect(() => markVisit(state, 'north', 'alex', 'expected')).toThrow();
  });
  it('проверяет дату переноса, состояние человека, корпус и даты проживания', () => {
    const state = initialWorkflow();
    expect(() => moveVisit(state, 'north', 'alex', TODAY)).toThrow();
    expect(() => moveVisit(state, 'north', 'alex', '2026-02-30')).toThrow();
    const draft = {
      ...settlementDefaults(findVisit(state, 'north', 'alex').person),
      hostel: 'Корпус А',
    };
    expect(() => settleVisit(state, 'north', 'alex', draft, workflowSettings().fields)).toThrow(
      'Сначала отметьте',
    );
    const arrived = markVisit(state, 'north', 'alex', 'arrived');
    expect(() => settleVisit(arrived, 'north', 'alex', { ...draft, hostel: '' }, [])).toThrow(
      'место проживания',
    );
    expect(() =>
      settleVisit(arrived, 'north', 'alex', { ...draft, end: '2026-10-01' }, []),
    ).toThrow('Проверьте даты');
    expect(() =>
      settleVisit(
        {
          ...arrived,
          residents: [...arrived.residents, { ...arrived.residents[0], personKey: 'alex' }],
        },
        'north',
        'alex',
        draft,
        [],
      ),
    ).toThrow('уже есть действующее проживание');
  });
});
