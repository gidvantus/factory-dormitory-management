import { vi } from 'vitest';
import { personnelApi } from '../api/personnel';
import type {
  Block,
  BlockPreview,
  EmployeeListQuery,
  Filter,
  PersonnelData,
} from '../api/personnel';
import { defaultBlocks, filterPeople, value } from '../workspace/personnel/helpers';
import {
  blockCriteria,
  blockSource,
  workspaceBlockData,
} from '../workspace/personnel/workspaceBlockData';

/**
 * Двойник серверных ручек персонала для тестов страницы (#247).
 *
 * `GET /personnel?employees=none` отдаёт рамку с `block_previews`, а `GET
 * /personnel/employees` — страницу карточек. Правила отбора здесь те же, что уже
 * проверены в `helpers.test`/`employeeListFilters.test` и на сервере: двойник
 * повторяет форму ответа, а не проверяет расчёт.
 */
function previewOf(block: Block, data: PersonnelData, dormitory: number | null): BlockPreview {
  const model = workspaceBlockData(block, data, dormitory);
  const criteria = blockCriteria(block, dormitory, data);
  return {
    id: block.id,
    kind: block.kind,
    title: block.title,
    count: model.total,
    items: model.people.slice(0, block.limit),
    events:
      block.kind === 'ending'
        ? model.people.flatMap((person) => {
            const end = value(blockSource(person, criteria, data.today), 'shift_end');
            return end ? [{ date: end, count: 1 }] : [];
          })
        : [],
    dorms: model.dorms.map(({ id, name, client_name, is_archived, count }) => ({
      id,
      name,
      client_name,
      is_archived,
      count,
    })),
    missing_list: model.missingList,
  };
}

/** Подменяет обе ручки персонала: рамку без карточек и страницу сотрудников. */
export function mockPersonnelServer(payload: PersonnelData): void {
  vi.spyOn(personnelApi, 'workspace').mockImplementation(async (_signal, options) => {
    const dormitory = options?.dormitory ?? null;
    const days = options?.days ?? 5;
    const frame = structuredClone(payload);
    if (options?.employees !== 'none') return frame;
    const blocks = frame.preferences.blocks ?? defaultBlocks;
    const count = (filter: Filter): number =>
      filterPeople(frame, { filter, dormitory, days, query: '', scope: [] }).length;
    return {
      ...frame,
      employees: [],
      // Сводка поверхности считается сервером по своим карточкам (#247).
      counts: { all: count('all'), current: count('current'), ending: count('ending') },
      block_previews: blocks.map((block) => previewOf(block, frame, dormitory)),
    };
  });
  vi.spyOn(personnelApi, 'employees').mockImplementation(async (query: EmployeeListQuery) => {
    const people = filterPeople(payload, query);
    const per = query.per_page;
    const start = (query.page - 1) * per;
    return {
      items: people.slice(start, start + per),
      total: people.length,
      page: query.page,
      per_page: per,
      pages: Math.ceil(people.length / per),
    };
  });
}
