import { request, requestBlob } from './client';
import type { Field, Settings, Value } from '../workspace/personnel/arrivals/data';

export type IdentityFields = {
  full_name: string | null;
  personnel_number: string | null;
  phone: string | null;
};
export type SourceTable = 'residents' | 'inflow' | 'outflow' | 'archive' | `custom_${number}`;
export type Source = {
  table_key: SourceTable;
  row_id: number;
  dormitory_id: number;
  source_name: string;
  values: Record<string, string | number | boolean | null | Record<string, unknown>>;
};
export type Employee = IdentityFields & {
  id: string;
  member_ids: string[];
  identity_status: 'pending' | 'confirmed';
  current: Source[];
  sources: Source[];
  history_dormitory_ids: number[];
  variants: Partial<Record<keyof IdentityFields, string[]>>;
};
export type Candidate = IdentityFields & {
  id: string;
  identity_status: 'pending' | 'confirmed';
  dormitories: string[];
  score: number;
  evidence: string[];
  differences: string[];
};
export type IdentityCheck = { check_token: string; candidates: Candidate[] };
export type IdentityChoice = IdentityFields & {
  mode: 'existing' | 'new' | 'pending';
  employee_id: string | null;
  check_token: string;
};
export type Filter = 'all' | 'current' | 'ending';
export type EmployeeColumnFilter = {
  field: string;
  operator: 'contains' | 'equals' | 'empty' | 'filled' | 'from' | 'to';
  value: string;
};
export type PersonnelSourceColumn = {
  id: number;
  dormitory_id: number;
  table_key: SourceTable;
  source_name: string;
  name: string;
  kind: 'text' | 'number' | 'date' | 'select' | 'checkbox';
  builtin_key: string | null;
  options: { id: string; label: string; archived: boolean }[];
};
export type SavedList = {
  id: string;
  name: string;
  filter: Filter;
  dormitory: number | null;
  days: number;
  query: string;
  scope: number[];
  column_filters?: EmployeeColumnFilter[];
};
export type BlockKind = 'residents' | 'ending' | 'contacts' | 'plans' | 'saved';
export type Block = {
  id: string;
  kind: BlockKind;
  title: string;
  scope: number[];
  days: number;
  limit: number;
  wide: boolean;
  saved_list_id: string | null;
};
export type Preferences = {
  revision: number;
  blocks: Block[] | null;
  lists: SavedList[];
};
export type Plan = {
  id: string;
  employee_id: string;
  kind: 'arrival' | 'departure';
  date: string;
  end: string | null;
  dormitory_id: number;
  confirmed: boolean;
  comment: string;
};
export type ArrivalPlan = {
  dormitory_name?: string;
  is_archived?: boolean;
  id: string;
  dormitory_id: number;
  date: string;
  count: number;
  names: string[];
  people?: { id: string; full_name: string; custom_values: Record<string, Value> }[];
  custom_values?: Record<string, Value>;
  revision: number;
  workflow?: Record<string, ArrivalVisit>;
};
export type ArrivalRef = { plan_id: string; person_id: string; date: string; dormitory_id: number };
export type ArrivalVisit = {
  status: 'expected' | 'arrived' | 'no_show' | 'moved' | 'settled';
  arrived_on: string | null;
  origin: ArrivalRef | null;
  destination: ArrivalRef | null;
  resident: { id: number; dormitory_id: number } | null;
  employee_id: string | null;
  history: {
    action: string;
    at: string;
    date: string;
    destination?: ArrivalRef;
    origin?: ArrivalRef;
  }[];
  settlement: {
    full_name: string;
    hostel_name: string;
    settlement_date: string;
    shift_start: string;
    shift_end: string | null;
    shift_count: number | null;
    fields: Field[];
    personal_values: Record<string, Value>;
    arrival_values: Record<string, Value>;
  } | null;
};
export type ArrivalWorkflowResult = { plans: ArrivalPlan[]; deleted_plan_ids: string[] };
export type ArrivalInput = Omit<
  ArrivalPlan,
  'id' | 'revision' | 'workflow' | 'dormitory_name' | 'is_archived'
> & {
  settings_revision?: number;
};
export type ArrivalConfiguration = Settings & {
  revision: number;
  archived_fields: Field[];
  used_fields: string[];
};
export type PersonnelData = {
  today: string;
  dormitories: { id: number; name: string; client_name: string; is_archived: boolean }[];
  employees: Employee[];
  source_columns?: PersonnelSourceColumn[];
  plans: Plan[];
  arrival_plans: ArrivalPlan[];
  arrival_settings?: ArrivalConfiguration;
  preferences: Preferences;
};
export type ArrivalPlanningData = Pick<
  PersonnelData,
  'today' | 'dormitories' | 'arrival_plans' | 'arrival_settings'
> & { from: string; to: string };
export type EmployeeDetail = {
  employee_id: string;
  events: {
    id: number;
    kind: string;
    title: string;
    date: string;
    created_at: string;
    actor: string;
    dormitory_id: number | null;
    source_table: SourceTable | null;
    source_id: number | null;
    snapshot: Record<string, unknown>;
  }[];
  notes: { id: string; text: string; author: string; created_at: string }[];
  merges: {
    id: string;
    source_id: string;
    target_id: string;
    reason: string;
    actor: string;
    created_at: string;
    undone_at: string | null;
  }[];
};
export type Binding = {
  fields: Record<string, number>;
  columns: { id: number; name: string; kind: string; builtin_key: string | null }[];
};

const send = <T = { ok: boolean }>(path: string, method: string, body?: unknown): Promise<T> =>
  request<T>(`/personnel${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
export const personnelApi = {
  arrivals: (
    range?: { from: string; to: string },
    dormitory?: number | null,
    signal?: AbortSignal,
  ): Promise<ArrivalPlanningData> => {
    const params = new URLSearchParams(range);
    if (dormitory) params.set('dormitory_id', String(dormitory));
    return request(`/personnel/arrivals?${params}`, { signal });
  },
  exportSelected: (name: string, employee_ids: string[], columns: number[][]): Promise<Blob> =>
    requestBlob('/personnel/export', {
      method: 'POST',
      body: JSON.stringify({ name, employee_ids, columns }),
    }),
  workspace: (signal?: AbortSignal): Promise<PersonnelData> => request('/personnel', { signal }),
  detail: (id: string, signal?: AbortSignal): Promise<EmployeeDetail> =>
    request(`/personnel/employees/${encodeURIComponent(id)}`, { signal }),
  check: (fields: IdentityFields, signal?: AbortSignal): Promise<IdentityCheck> =>
    request('/personnel/check', { method: 'POST', body: JSON.stringify(fields), signal }),
  createRecord: (
    dormitory_id: number,
    table_key: SourceTable,
    identity: IdentityChoice,
    values: Record<string, unknown> = {},
  ): Promise<{ row_id: number; employee_id: string }> =>
    send('/records', 'POST', { dormitory_id, table_key, identity, values }),
  link: (
    dormitory_id: number,
    table_key: SourceTable,
    row_id: number,
    identity: IdentityChoice,
  ): Promise<{ employee_id: string }> =>
    send('/link', 'POST', { dormitory_id, table_key, row_id, identity }),
  updateEmployee: (
    id: string,
    values: IdentityFields & { identity_status: 'pending' | 'confirmed' },
  ) => send(`/employees/${id}`, 'PATCH', values),
  addNote: (id: string, text: string) => send(`/employees/${id}/notes`, 'POST', { text }),
  createArrival: (values: ArrivalInput) => send<ArrivalPlan>('/arrivals', 'POST', values),
  arrivalSettings: (signal?: AbortSignal) =>
    request<ArrivalConfiguration>('/personnel/arrivals/settings', { signal }),
  saveArrivalSettings: (values: Settings & { revision: number }) =>
    send<ArrivalConfiguration>('/arrivals/settings', 'PUT', values),
  updateArrival: (id: string, values: ArrivalInput & { revision: number }) =>
    send<ArrivalPlan>(`/arrivals/${id}`, 'PUT', values),
  deleteArrival: (id: string, revision: number) =>
    send<void>(`/arrivals/${id}?revision=${revision}`, 'DELETE'),
  arrival: (id: string, signal?: AbortSignal) =>
    request<ArrivalPlan>(`/personnel/arrivals/${id}`, { signal }),
  markArrival: (
    plan: string,
    person: string,
    status: 'expected' | 'arrived' | 'no_show',
    revision: number,
  ) =>
    send<ArrivalWorkflowResult>(`/arrivals/${plan}/people/${person}/status`, 'POST', {
      status,
      revision,
    }),
  moveArrival: (plan: string, person: string, date: string, revision: number) =>
    send<ArrivalWorkflowResult>(`/arrivals/${plan}/people/${person}/move`, 'POST', {
      date,
      revision,
    }),
  undoMerge: (id: string) => send(`/merges/${id}/undo`, 'POST'),
  preferences: (values: Preferences): Promise<Preferences> => send('/preferences', 'PUT', values),
  binding: (id: string, table: SourceTable, signal?: AbortSignal): Promise<Binding> =>
    request(`/personnel/bindings/${id}/${table}`, { signal }),
  saveBinding: (id: string, table: SourceTable, fields: Record<string, number>) =>
    send(`/bindings/${id}/${table}`, 'PUT', { fields }),
};
