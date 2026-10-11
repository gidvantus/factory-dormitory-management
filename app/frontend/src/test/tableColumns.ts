import type { TableColumn, BuiltinTableKey as TableKey } from '../api/client';
import { mockFetch } from './mockFetch';
import type { MockHandler } from './mockFetch';
import { standardTabs } from '../workspace/dormitories/tabStructure';
import { todayDate } from '../workspace/dashboard/dates';

export const defaultTabChoices = standardTabs.map((tab) => ({
  source_id: `standard:0:${tab.path}`,
}));

export const defaultTabCatalog = standardTabs.map((tab) => ({
  id: tab.label.toLocaleLowerCase('ru').replaceAll('ё', 'е'),
  name: tab.label,
  variants: [
    {
      id: `standard:0:${tab.path}`,
      name: tab.label,
      kind: 'standard',
      section_key: tab.path,
      dormitory_name: 'Стандартная структура',
      client_name: '',
      path: [tab.label],
    },
  ],
}));

const fields: Record<TableKey, string[]> = {
  residents: [
    'row_number',
    'gender',
    'personnel_number',
    'full_name',
    'hostel_id',
    'shift_start',
    'shift_count',
    'shift_end',
    'phone',
    'medical_book',
    'notes',
    'action_advance',
    'action_settlement',
    'action_transfer',
    'action_outflow',
    'action_delete',
  ],
  inflow: [
    'settlement_date',
    'personnel_number',
    'full_name',
    'citizenship',
    'notes',
    'shift_count',
    'action_delete',
  ],
  outflow: [
    'departure_date',
    'personnel_number',
    'full_name',
    'shift_start',
    'reason',
    'notes',
    'additional_info',
    'action_evict',
    'action_delete',
  ],
  advance: ['personnel_number', 'full_name', 'advance_amount', 'action_delete'],
  settlement: ['personnel_number', 'full_name', 'settlement_date', 'action_delete'],
  archive: ['action_delete'],
};

export function defaultColumns(table: TableKey): TableColumn[] {
  return fields[table].map((field, index) => ({
    id: index + 1,
    name:
      field === 'action_advance'
        ? 'Запись на аванс'
        : field === 'action_settlement'
          ? 'Запись на расчёт'
          : field,
    builtin_key: field,
    table_key: table,
    kind:
      field.startsWith('action_') || field === 'row_number'
        ? 'action'
        : field.includes('date') || (field.startsWith('shift_') && field !== 'shift_count')
          ? 'date'
          : 'text',
    position: index,
    options: [],
    archived: false,
  }));
}

/** Existing row editor tests supply the table schema explicitly through this fixture. */
export function mockTableFetch(handler: MockHandler): ReturnType<typeof mockFetch> {
  return mockFetch((url, init) => {
    if (/\/dormitories\/\d+\/report-readiness$/.test(url) && !init?.method)
      return {
        status: 200,
        body: {
          report_date: todayDate(),
          is_ready: false,
          confirmed_at: null,
          confirmed_by: null,
        },
      };
    if (url.endsWith('/api/dormitory-tab-catalog') && !init?.method)
      return { status: 200, body: defaultTabCatalog };
    if (/\/dormitories\/\d+\/tabs$/.test(url) && !init?.method) return { status: 200, body: [] };
    const match = /\/tables\/(residents|inflow|outflow|advance|settlement|archive)\/columns$/.exec(
      url,
    );
    if (match && !init?.method) return { status: 200, body: defaultColumns(match[1] as TableKey) };
    return handler(url, init);
  });
}
