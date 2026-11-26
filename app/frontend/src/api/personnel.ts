import { request, requestBlob } from './client';
import type { DateRange } from '../workspace/dashboard/dates';
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
  period?: DateRange | null;
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
  employee_ids?: Record<string, string>;
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
  'id' | 'revision' | 'workflow' | 'employee_ids' | 'dormitory_name' | 'is_archived'
> & {
  settings_revision?: number;
};
export type EmployeeArrivalResult =
  { created: boolean; plan: ArrivalPlan } | { required_fields: Field[] };
export type ArrivalConfiguration = Settings & {
  revision: number;
  archived_fields: Field[];
  used_fields: string[];
};
/** Карточки страницы сотрудников: `GET /api/personnel/employees` (#247). */
export type EmployeePage = {
  items: Employee[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
};
export type FinishedShift = {
  id: number;
  employee_id: string;
  full_name: string | null;
  dormitory_id: number;
  departure_date: string;
  notes: string | null;
};
export type FinishedShiftPage = { rows: FinishedShift[]; total: number; page: number };
/** Условия страницы: те же правила, что раньше считались в браузере по всему списку. */
export type EmployeeListQuery = {
  filter: Filter;
  dormitory: number | null;
  scope: number[];
  days: number;
  period?: DateRange | null;
  query: string;
  column_filters?: EmployeeColumnFilter[];
  page: number;
  per_page: number;
};
/** Данные блока рабочей поверхности без полной выборки карточек (#247). */
export type BlockPreview = {
  id: string;
  kind: BlockKind;
  title: string;
  count: number;
  items: Employee[];
  events: { date: string; count: number }[];
  dorms: {
    id: number;
    name: string;
    client_name: string;
    is_archived: boolean;
    count: number;
  }[];
  missing_list: boolean;
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
  /** Есть только при `employees=none`: так `Personnel.tsx` рисует блоки без полного списка. */
  block_previews?: BlockPreview[];
  /**
   * Сводка поверхности при `employees=none` (#247): числа «Персонал N»,
   * «Проживают сейчас» и «Завершают вахту» считает сервер, а не браузер по
   * всему массиву карточек. Срок вахты задаётся `days` того же запроса.
   */
  counts?: Partial<Record<Filter, number>>;
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
export type EmployeeProfileTarget =
  { employeeId: string; fullName?: never } | { employeeId?: never; fullName: string };
export type EmployeeProfileContext = Pick<PersonnelData, 'dormitories'> & {
  arrival_settings?: Pick<ArrivalConfiguration, 'fields'>;
};
export type EmployeeProfileData = EmployeeProfileContext & {
  employee: Employee;
  detail: EmployeeDetail;
};
export type Binding = {
  fields: Record<string, number>;
  columns: {
    id: number;
    name: string;
    kind: string;
    builtin_key: string | null;
    has_fill?: boolean;
    can_convert_to_text?: boolean;
  }[];
};
export type EntryColumns = Partial<Record<'full_name' | 'phone', number>>;

const send = <T = { ok: boolean }>(path: string, method: string, body?: unknown): Promise<T> =>
  request<T>(`/personnel${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Диапазон дат в запросе: сервер принимает обе границы вместе или ни одной. */
const periodParams = (params: URLSearchParams, period?: DateRange | null): void => {
  if (!period) return;
  params.set('period_from', period.from);
  params.set('period_to', period.to);
};

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
  /**
   * Рабочая поверхность. `employees: 'none'` — рамка без карточек: люди приходят
   * страницами из `employees()`, а блоки — из `block_previews` (#247).
   * `days` — срок вахты для сводки `counts`; страница запрашивает его же.
   * `period` — выбранный диапазон дат панели персонала: сервер считает «окончание
   * вахты» ровно в его границах, а `days` остаётся запасным правилом.
   * Умолчание `full` осталось ради остальных экранов, которым нужен весь список.
   */
  workspace: (
    signal?: AbortSignal,
    options?: {
      employees?: 'full' | 'none';
      dormitory?: number | null;
      days?: number;
      period?: DateRange | null;
    },
  ): Promise<PersonnelData> => {
    const params = new URLSearchParams();
    if (options?.employees === 'none') params.set('employees', 'none');
    if (options?.dormitory) params.set('dormitory', String(options.dormitory));
    if (options?.days != null) params.set('days', String(options.days));
    periodParams(params, options?.period);
    const search = params.toString();
    return request(`/personnel${search ? `?${search}` : ''}`, { signal });
  },
  /**
   * Все карточки сотрудников для конструктора подвкладок (#261). Конструктор
   * считает формулы по всему реестру, поэтому ему нужен каждый человек, но не
   * остальная поверхность: она приходит из `workspace({ employees: 'none' })`.
   */
  cards: (signal?: AbortSignal): Promise<{ employees: Employee[] }> =>
    request('/personnel/cards', { signal }),
  /**
   * Корень карточки, к которой привязана строка-источник (#261). Нужен, когда
   * сохранение ячейки создало карточку, не вернув её `id`: полный реестр за этим
   * не запрашивается.
   */
  employeeBySource: (
    dormitoryId: number,
    tableKey: SourceTable,
    rowId: number,
    signal?: AbortSignal,
  ): Promise<{ employee_id: string }> =>
    request(
      `/personnel/employees/by-source?${new URLSearchParams({
        dormitory_id: String(dormitoryId),
        table_key: tableKey,
        row_id: String(rowId),
      })}`,
      { signal },
    ),
  /** Страница сотрудников с серверной фильтрацией и сортировкой (#247). */
  employees: (query: EmployeeListQuery, signal?: AbortSignal): Promise<EmployeePage> => {
    const params = new URLSearchParams({
      filter: query.filter,
      page: String(query.page),
      per_page: String(query.per_page),
    });
    if (query.dormitory != null) params.set('dormitory', String(query.dormitory));
    for (const id of query.scope) params.append('scope', String(id));
    params.set('days', String(query.days));
    periodParams(params, query.period);
    const text = query.query.trim();
    if (text) params.set('query', text);
    if (query.column_filters?.length)
      params.set('column_filters', JSON.stringify(query.column_filters));
    return request(`/personnel/employees?${params}`, { signal });
  },
  finishedShifts: (
    filters: { period: DateRange; dormitory: number | null; query: string; page: number },
    signal?: AbortSignal,
  ): Promise<FinishedShiftPage> => {
    const params = new URLSearchParams({ ...filters.period, page: String(filters.page) });
    if (filters.dormitory !== null) params.set('dormitory', String(filters.dormitory));
    if (filters.query.trim()) params.set('query', filters.query.trim());
    return request(`/personnel/finished-shifts?${params}`, { signal });
  },
  detail: (id: string, signal?: AbortSignal): Promise<EmployeeDetail> =>
    request(`/personnel/employees/${encodeURIComponent(id)}`, { signal }),
  profile: (target: EmployeeProfileTarget, signal?: AbortSignal): Promise<EmployeeProfileData> =>
    target.employeeId !== undefined
      ? request(`/personnel/employees/${encodeURIComponent(target.employeeId)}/profile`, { signal })
      : request('/personnel/employee-profile/by-name', {
          method: 'POST',
          body: JSON.stringify({ full_name: target.fullName }),
          signal,
        }),
  check: (fields: IdentityFields, signal?: AbortSignal): Promise<IdentityCheck> =>
    request('/personnel/check', { method: 'POST', body: JSON.stringify(fields), signal }),
  createRecord: (
    dormitory_id: number,
    table_key: SourceTable,
    identity: IdentityChoice,
    values: Record<string, unknown> = {},
    entry_columns?: EntryColumns,
  ): Promise<{ row_id: number; employee_id: string }> =>
    send('/records', 'POST', {
      dormitory_id,
      table_key,
      identity,
      values,
      ...(entry_columns === undefined ? {} : { entry_columns }),
    }),
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
  addEmployeeToArrival: (
    employeeId: string,
    values: { date: string; dormitory_id: number; values?: Record<string, Value> },
  ) =>
    send<EmployeeArrivalResult>(
      `/arrivals/from-employee/${encodeURIComponent(employeeId)}`,
      'POST',
      values,
    ),
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
  saveBinding: (
    id: string,
    table: SourceTable,
    fields: Record<string, number>,
    convertPhoneToText = false,
  ) =>
    send(`/bindings/${id}/${table}`, 'PUT', {
      fields,
      ...(convertPhoneToText ? { convert_phone_to_text: true } : {}),
    }),
};
