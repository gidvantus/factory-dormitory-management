import { request } from './client';

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
  values: Record<string, string | number | null | Record<string, unknown>>;
};
export type Employee = IdentityFields & {
  id: string;
  member_ids: string[];
  identity_status: 'pending' | 'confirmed';
  current: Source[];
  sources: Source[];
  has_outflow: boolean;
  history_dormitory_ids: number[];
  outflow_dormitory_ids: number[];
  last_outflow: { date: string; dormitory_id: number | null; reason: string | null } | null;
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
export type Filter =
  | 'all'
  | 'current'
  | 'ending'
  | 'overdue'
  | 'missing'
  | 'history'
  | 'mine'
  | 'returned'
  | 'arrivals'
  | 'no-phone'
  | 'pending';
export type SavedList = {
  id: string;
  name: string;
  filter: Filter;
  dormitory: number | null;
  days: number;
  query: string;
  scope: number[];
};
export type BlockKind =
  'residents' | 'ending' | 'contacts' | 'outflow' | 'missing' | 'plans' | 'tasks' | 'saved';
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
  favorites: string[];
};
export type Task = {
  id: string;
  employee_id: string;
  text: string;
  due: string;
  assignee_id: number | null;
  done: boolean;
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
export type Decision = {
  employee_id: string;
  resident_id: number;
  status: 'waiting' | 'extend' | 'departure';
  date: string | null;
  comment: string;
};
export type Match = {
  source_id: string;
  target_id: string;
  score: number;
  evidence: string[];
  differences: string[];
  signature: string;
};
export type PersonnelData = {
  today: string;
  user_id: number;
  dormitories: { id: number; name: string; client_name: string; is_archived: boolean }[];
  users: { id: number; name: string }[];
  employees: Employee[];
  tasks: Task[];
  plans: Plan[];
  decisions: Decision[];
  matches: Match[];
  preferences: Preferences;
};
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
  addTask: (id: string, values: Pick<Task, 'text' | 'due' | 'assignee_id'>) =>
    send(`/employees/${id}/tasks`, 'POST', values),
  toggleTask: (id: string, done: boolean) => send(`/tasks/${id}`, 'PATCH', { done }),
  addNote: (id: string, text: string) => send(`/employees/${id}/notes`, 'POST', { text }),
  savePlan: (
    id: string,
    values: {
      date: string;
      end: string;
      dormitory_id: number;
      confirmed: boolean;
      comment: string;
    },
  ) => send(`/employees/${id}/next-shift`, 'PUT', values),
  confirmPlan: (id: string, confirmed: boolean) => send(`/plans/${id}`, 'PATCH', { confirmed }),
  cancelPlan: (id: string) => send<void>(`/plans/${id}`, 'DELETE'),
  saveDecision: (id: string, values: Omit<Decision, 'employee_id'>) =>
    send(`/employees/${id}/decision`, 'PUT', values),
  merge: (match: Match, reason: string): Promise<{ employee_id: string; merge_id: string }> =>
    send('/merge', 'POST', {
      source_id: match.source_id,
      target_id: match.target_id,
      signature: match.signature,
      reason,
    }),
  separate: (match: Match, reason: string) =>
    send('/separate', 'POST', {
      source_id: match.source_id,
      target_id: match.target_id,
      signature: match.signature,
      reason,
    }),
  undoMerge: (id: string) => send(`/merges/${id}/undo`, 'POST'),
  preferences: (values: Preferences): Promise<Preferences> => send('/preferences', 'PUT', values),
  binding: (id: string, table: SourceTable): Promise<Binding> =>
    request(`/personnel/bindings/${id}/${table}`),
  saveBinding: (id: string, table: SourceTable, fields: Record<string, number>) =>
    send(`/bindings/${id}/${table}`, 'PUT', { fields }),
};
