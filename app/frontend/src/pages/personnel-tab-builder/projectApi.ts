import { personnelApi } from '../../api/personnel';
import type { ArrivalPlan, ArrivalVisit, EmployeeDetail, PersonnelData } from '../../api/personnel';
import { addDays } from '../../workspace/personnel/helpers';
import { defaultConfiguration } from '../../workspace/personnel/arrivals/adapter';
import { copy, fail, Sandbox } from '../constructor-sandbox/store';

export const PROJECT_DATA_KEY = 'domovoy-personnel-project-data-v1';
export type ProjectData = { personnel: PersonnelData; details: Record<string, EmployeeDetail> };

export function projectStore(): { store: Sandbox; details: Record<string, EmployeeDetail> } {
  const store = new Sandbox();
  store.personnel.today = '2026-11-02';
  store.personnel.preferences.blocks = null;
  store.personnel.arrival_settings = defaultConfiguration();
  const plan = store.personnel.arrival_plans[0];
  plan.people = store.arrivalSample.people.map((person) => ({
    id: person.id,
    full_name: person.name,
    custom_values: copy(person.values),
  }));
  plan.custom_values = copy(store.arrivalSample.values);
  let details: Record<string, EmployeeDetail> = {};
  try {
    const saved = JSON.parse(
      localStorage.getItem(PROJECT_DATA_KEY) ?? 'null',
    ) as ProjectData | null;
    if (
      saved &&
      Array.isArray(saved.personnel?.employees) &&
      Array.isArray(saved.personnel.dormitories) &&
      Array.isArray(saved.personnel.arrival_plans)
    ) {
      store.personnel = saved.personnel;
      details = saved.details ?? {};
    }
  } catch {
    /* Независимая копия данных; исходный кабинет не затрагивается. */
  }
  return { store, details };
}

/** Обработчики штатной страницы работают только с копией в браузере. */
export function installProjectPersonnelApis(
  store: Sandbox,
  details: Record<string, EmployeeDetail>,
): () => void {
  const previous = { ...personnelApi };
  const plan = (id: string): ArrivalPlan =>
    store.personnel.arrival_plans.find((plan) => plan.id === id) ?? fail('Заезд не найден.', 404);
  const revision = (item: ArrivalPlan, value: number): void => {
    if (item.revision !== value) fail('Запись уже изменилась. Откройте её заново.', 409);
  };
  const personDetail = (id: string): EmployeeDetail => {
    const employee =
      store.personnel.employees.find((person) => person.id === id) ??
      fail('Сотрудник не найден.', 404);
    return (
      details[id] ??
      (details[id] = {
        employee_id: id,
        notes: [],
        merges: [],
        events: employee.sources.map((source, index) => ({
          id: index + 1,
          kind: 'residence',
          title: 'Запись в общежитии',
          date: String(source.values.shift_start ?? store.personnel.today),
          created_at: `${store.personnel.today}T09:00:00Z`,
          actor: 'Тестовый кабинет',
          dormitory_id: source.dormitory_id,
          source_table: source.table_key,
          source_id: source.row_id,
          snapshot: copy(source.values),
        })),
      })
    );
  };
  const emptyVisit = (): ArrivalVisit => ({
    status: 'expected',
    arrived_on: null,
    origin: null,
    destination: null,
    resident: null,
    employee_id: null,
    history: [],
    settlement: null,
  });
  const handlers: Partial<typeof personnelApi> = {
    arrivals: async (range, dormitory) => {
      const from = range?.from ?? store.personnel.today,
        to = range?.to ?? addDays(from, 6);
      return copy({
        ...store.personnel,
        from,
        to,
        arrival_plans: store.personnel.arrival_plans.filter(
          (item) =>
            (!dormitory || item.dormitory_id === dormitory) && item.date >= from && item.date <= to,
        ),
      });
    },
    arrival: async (id) => copy(plan(id)),
    arrivalSettings: async () => copy(store.personnel.arrival_settings ?? defaultConfiguration()),
    saveArrivalSettings: async (values) => {
      const old = store.personnel.arrival_settings ?? defaultConfiguration();
      if (values.revision !== old.revision)
        fail('Настройки уже изменились. Откройте окно заново.', 409);
      store.personnel.arrival_settings = {
        ...copy(values),
        revision: old.revision + 1,
        used_fields: [
          ...new Set(
            store.personnel.arrival_plans.flatMap((item) => [
              ...Object.keys(item.custom_values ?? {}),
              ...(item.people ?? []).flatMap((person) => Object.keys(person.custom_values)),
            ]),
          ),
        ],
        archived_fields: [
          ...old.archived_fields,
          ...old.fields.filter((field) => !values.fields.some((next) => next.id === field.id)),
        ],
      };
      store.changed();
      return copy(store.personnel.arrival_settings);
    },
    createArrival: async (values) => {
      const created: ArrivalPlan = { ...copy(values), id: crypto.randomUUID(), revision: 1 };
      store.personnel.arrival_plans.push(created);
      store.changed();
      return copy(created);
    },
    updateArrival: async (id, values) => {
      const old = plan(id);
      revision(old, values.revision);
      const next = { ...old, ...copy(values), id, revision: old.revision + 1 };
      store.personnel.arrival_plans = store.personnel.arrival_plans.map((item) =>
        item.id === id ? next : item,
      );
      store.changed();
      return copy(next);
    },
    deleteArrival: async (id, value) => {
      revision(plan(id), value);
      store.personnel.arrival_plans = store.personnel.arrival_plans.filter(
        (item) => item.id !== id,
      );
      store.changed();
    },
    markArrival: async (id, personId, status, value) => {
      const item = plan(id);
      revision(item, value);
      if (!item.people?.some((person) => person.id === personId)) fail('Человек не найден.');
      const visit = item.workflow?.[personId] ?? emptyVisit();
      item.workflow = {
        ...item.workflow,
        [personId]: {
          ...visit,
          status,
          arrived_on: status === 'arrived' ? store.personnel.today : null,
          history: [
            ...visit.history,
            {
              action: status,
              at: `${store.personnel.today}T09:00:00Z`,
              date: item.date,
            },
          ],
        },
      };
      item.revision++;
      store.changed();
      return copy({ plans: [item], deleted_plan_ids: [] });
    },
    moveArrival: async (id, personId, date, value) => {
      const source = plan(id);
      revision(source, value);
      if (date === source.date) fail('Выберите другую дату.');
      const person =
        source.people?.find((person) => person.id === personId) ?? fail('Человек не найден.');
      let target = store.personnel.arrival_plans.find(
        (item) => item.dormitory_id === source.dormitory_id && item.date === date,
      );
      if (!target) {
        target = {
          ...copy(source),
          id: crypto.randomUUID(),
          date,
          people: [],
          names: [],
          count: 0,
          workflow: {},
          revision: 0,
        };
        store.personnel.arrival_plans.push(target);
      }
      const moved = { ...copy(person), id: crypto.randomUUID() };
      const origin = {
        plan_id: source.id,
        person_id: person.id,
        date: source.date,
        dormitory_id: source.dormitory_id,
      };
      const destination = {
        plan_id: target.id,
        person_id: moved.id,
        date,
        dormitory_id: target.dormitory_id,
      };
      source.workflow = {
        ...source.workflow,
        [person.id]: {
          ...(source.workflow?.[person.id] ?? emptyVisit()),
          status: 'moved',
          destination,
        },
      };
      target.people = [...(target.people ?? []), moved];
      target.names = target.people.map((person) => person.full_name);
      target.count = target.people.length;
      target.workflow = { ...target.workflow, [moved.id]: { ...emptyVisit(), origin } };
      source.revision++;
      target.revision++;
      store.changed();
      return copy({ plans: [source, target], deleted_plan_ids: [] });
    },
    detail: async (id) => copy(personDetail(id)),
    updateEmployee: async (id, values) => {
      const employee =
        store.personnel.employees.find((person) => person.id === id) ??
        fail('Сотрудник не найден.', 404);
      Object.assign(employee, copy(values));
      store.changed();
      return { ok: true };
    },
    addNote: async (id, text) => {
      personDetail(id).notes.unshift({
        id: crypto.randomUUID(),
        text,
        author: 'Тестовый кабинет',
        created_at: `${store.personnel.today}T09:00:00Z`,
      });
      store.changed();
      return { ok: true };
    },
  };
  Object.assign(personnelApi, handlers);
  return () => {
    Object.assign(personnelApi, previous);
  };
}
