import { afterEach, beforeEach, expect, it } from 'vitest';
import { personnelApi } from '../../api/personnel';
import { installSandboxApis } from '../constructor-sandbox/api';
import { installProjectPersonnelApis, PROJECT_DATA_KEY, projectStore } from './projectApi';

let restore = () => {};
beforeEach(() => localStorage.removeItem(PROJECT_DATA_KEY));
afterEach(() => restore());
it('штатные заезды используют изолированную неделю, сохраняют правки и проверяют ревизию', async () => {
  const { store, details } = projectStore();
  const base = installSandboxApis(store);
  const local = installProjectPersonnelApis(store, details);
  restore = () => {
    local();
    base();
  };
  const data = await personnelApi.arrivals({ from: '2026-11-02', to: '2026-11-08' }, 1);
  expect(data.arrival_plans).toHaveLength(1);
  expect(data.arrival_settings?.revision).toBe(0);
  const original = data.arrival_plans[0];
  const saved = await personnelApi.updateArrival(original.id, { ...original, date: '2026-11-04' });
  expect(saved.revision).toBe(original.revision + 1);
  await expect(
    personnelApi.updateArrival(original.id, { ...original, date: '2026-11-05' }),
  ).rejects.toThrow('уже изменилась');
  expect(
    (await personnelApi.arrivals({ from: '2026-11-02', to: '2026-11-03' })).arrival_plans,
  ).toEqual([]);
  const settings = await personnelApi.arrivalSettings();
  expect((await personnelApi.saveArrivalSettings({ ...settings })).revision).toBe(1);
});
it('отметка и перенос человека обновляют те же планы, которые видит исходная страница', async () => {
  const { store, details } = projectStore();
  restore = installProjectPersonnelApis(store, details);
  const original = store.personnel.arrival_plans[0];
  const person = original.people![0];
  const marked = await personnelApi.markArrival(
    original.id,
    person.id,
    'arrived',
    original.revision,
  );
  expect(marked.plans[0].workflow?.[person.id].arrived_on).toBe(store.personnel.today);
  const moved = await personnelApi.moveArrival(
    original.id,
    person.id,
    '2026-11-04',
    marked.plans[0].revision,
  );
  expect(moved.plans[0].workflow?.[person.id].status).toBe('moved');
  const target = moved.plans[1];
  expect(target.people![0].full_name).toBe(person.full_name);
  expect(target.workflow?.[target.people![0].id].origin?.plan_id).toBe(original.id);
  expect((await personnelApi.arrival(target.id)).date).toBe('2026-11-04');
});
