import { initialState, newColumn, newTab } from './model';
import type { DemoState, PersonnelTab } from './model';

export const PROJECT_STORAGE_KEY = 'domovoy-personnel-project-builder-v1';

export function projectState(): DemoState {
  const work: PersonnelTab = {
    ...newTab(),
    id: 'work-register',
    kind: 'table',
    name: 'Учёт работы',
    description:
      'Часы и ставку заполняете вы. Начислено считается по формуле, телефон берётся из карточки сотрудника.',
    columns: [
      { ...newColumn(), id: 'work-person', name: 'Сотрудник', kind: 'employee', required: true },
      { ...newColumn(), id: 'work-hours', name: 'Часы', kind: 'number' },
      { ...newColumn(), id: 'work-rate', name: 'Ставка за час', kind: 'number' },
      {
        ...newColumn(),
        id: 'work-total',
        name: 'Начислено',
        kind: 'number',
        rule: {
          mode: 'formula',
          expression: '=[Часы]*[Ставка за час]',
          refs: { Часы: 'work-hours', 'Ставка за час': 'work-rate' },
          link: null,
        },
      },
      {
        ...newColumn(),
        id: 'work-phone',
        name: 'Телефон сотрудника',
        kind: 'text',
        rule: {
          mode: 'link',
          expression: '=',
          refs: {},
          link: {
            sourceId: 'people',
            operation: 'lookup',
            valueField: 'phone',
            sourceRowId: null,
            match: { sourceField: '$employee', localColumnId: 'work-person' },
            filters: [],
            dateField: null,
            empty: 'blank',
          },
        },
      },
    ],
    rows: [
      {
        id: 'work-1',
        values: { 'work-person': 'employee-0', 'work-hours': '8', 'work-rate': '400' },
      },
      {
        id: 'work-2',
        values: { 'work-person': 'employee-1', 'work-hours': '10', 'work-rate': '450' },
      },
    ],
  };
  return {
    version: 3,
    defaultTab: 'workspace',
    tabs: [...initialState().tabs.filter((tab) => tab.builtin), work],
  };
}

export function loadProjectState(): DemoState {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PROJECT_STORAGE_KEY) ?? 'null',
    ) as DemoState | null;
    if (
      saved?.version === 3 &&
      Array.isArray(saved.tabs) &&
      ['workspace', 'employees', 'planning'].every((id) =>
        saved.tabs.some((tab) => tab.id === id && tab.builtin),
      )
    )
      return saved;
  } catch {
    /* Повреждённое хранилище не мешает открыть тестовую страницу. */
  }
  return projectState();
}
