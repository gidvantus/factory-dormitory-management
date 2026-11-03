import type { ArrivalConfiguration, ArrivalInput, ArrivalPlan } from '../../../api/personnel';
import type { Arrival, Settings, Value } from './data';
import { initialSettings, newArrival, peopleAtCount } from './data';

export type ArrivalDraft = Arrival & {
  dormitory_id: number;
  revision: number;
  settings_revision: number;
};

export function defaultConfiguration(): ArrivalConfiguration {
  return { ...initialSettings(), revision: 0, used_fields: [], archived_fields: [] };
}

export function viewOf(plan: ArrivalPlan, dorm: string): Arrival {
  const people =
    plan.people?.map((person) => ({
      id: person.id,
      name: person.full_name,
      values: { ...person.custom_values },
    })) ?? plan.names.map((name) => ({ id: crypto.randomUUID(), name, values: {} }));
  return {
    id: plan.id,
    dorm,
    date: plan.date,
    count: String(plan.count),
    people: peopleAtCount(people, plan.count),
    values: { ...(plan.custom_values ?? {}) },
  };
}

export function draftOf(
  plan: ArrivalPlan | undefined,
  dorm: { id: number; name: string },
  date: string,
  revision: number,
): ArrivalDraft {
  return {
    ...(plan
      ? viewOf({ ...plan, count: Math.max(1, plan.count) }, dorm.name)
      : newArrival(dorm.name, date)),
    dormitory_id: dorm.id,
    revision: plan?.revision ?? 0,
    settings_revision: revision,
  };
}

export function inputOf(draft: ArrivalDraft, settings: Settings): ArrivalInput {
  function valuesFor(
    values: Record<string, Value>,
    scope: 'arrival' | 'person',
  ): Record<string, Value> {
    return {
      ...values,
      ...Object.fromEntries(
        settings.fields
          .filter((field) => field.inForm && field.scope === scope && field.type === 'checkbox')
          .map((field) => [field.id, values[field.id] === true]),
      ),
    };
  }
  const people = draft.people.slice(0, Number(draft.count)).map((person) => ({
    id: person.id,
    full_name: person.name.trim(),
    custom_values: valuesFor(person.values, 'person'),
  }));
  return {
    dormitory_id: draft.dormitory_id,
    date: draft.date,
    count: Number(draft.count),
    names: people.map((person) => person.full_name).filter(Boolean),
    people,
    custom_values: valuesFor(draft.values, 'arrival'),
    settings_revision: draft.settings_revision,
  };
}
