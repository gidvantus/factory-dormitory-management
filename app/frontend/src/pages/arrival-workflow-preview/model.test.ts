import { expect, it } from 'vitest';
import { addDays } from '../../workspace/personnel/helpers';
import { counts, findVisit, initialWorkflow, markVisit, moveVisit, TODAY } from './model';

it('переносит человека из старой даты в существующий день со всеми полями', () => {
  const original = initialWorkflow();
  const moved = moveVisit(original, 'north', 'anna', addDays(TODAY, 2));
  expect(moved.arrivals[0].people.some((person) => person.id === 'anna')).toBe(false);
  const target = moved.arrivals.find((arrival) => arrival.id === 'target')!;
  const person = target.people.find((person) => person.personKey === 'anna')!;
  expect(person.status).toBe('expected');
  expect(person.values).toEqual(findVisit(original, 'north', 'anna').person.values);
  expect(person.from?.date).toBe(TODAY);
  expect(target.values).toEqual(
    original.arrivals.find((arrival) => arrival.id === 'target')!.values,
  );
  expect(target.people).toHaveLength(2);
  expect(counts(moved.arrivals).expected).toBe(counts(original.arrivals).expected);
});
it('позволяет перенести обратно обычной командой и убирает опустевший день', () => {
  let state = moveVisit(initialWorkflow(), 'north', 'anna', addDays(TODAY, 8));
  const target = state.arrivals.find((arrival) => arrival.date === addDays(TODAY, 8))!;
  state = moveVisit(state, target.id, target.people[0].id, TODAY);
  expect(state.arrivals.some((arrival) => arrival.id === target.id)).toBe(false);
  expect(state.arrivals[0].people.filter((person) => person.personKey === 'anna')).toHaveLength(1);
});
it('перенос после смены решения сохраняет личные поля', () => {
  let state = markVisit(initialWorkflow(), 'north', 'alex', 'arrived');
  expect(() => moveVisit(state, 'north', 'alex', addDays(TODAY, 2))).toThrow();
  state = markVisit(state, 'north', 'alex', 'expected');
  state = moveVisit(state, 'north', 'alex', addDays(TODAY, 2));
  expect(state.arrivals[0].people.some((person) => person.personKey === 'alex')).toBe(false);
  expect(state.arrivals.find((arrival) => arrival.id === 'target')!.people.at(-1)?.status).toBe(
    'expected',
  );
});
it('проверяет дату переноса', () => {
  const state = initialWorkflow();
  expect(() => moveVisit(state, 'north', 'alex', TODAY)).toThrow();
  expect(() => moveVisit(state, 'north', 'alex', '2026-02-30')).toThrow();
});
