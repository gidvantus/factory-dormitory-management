import { ACTIVATION_REQUIRED_DETAIL, notifyActivationRequired } from '../auth/activation';
import type {
  CatalogDormitory,
  DashboardLayout,
  WidgetConfig,
  WidgetResult,
} from './dashboardBlocks';

export interface UserProfile {
  email: string;
  full_name: string;
  created_at: string;
  /** false — кабинет ещё не активирован по ссылке из письма. */
  is_active: boolean;
}

export interface RegisterResult {
  email: string;
  full_name: string;
  created_at: string;
  /** Ушло ли письмо активации: без настроенного SMTP сервер отвечает false. */
  activation_email_sent: boolean;
}

export interface ActivationInfo {
  email: string;
  full_name: string;
  expires_at: string;
}

export interface Dormitory {
  id: number;
  name: string;
  client_name: string;
  is_archived: boolean;
  section_states?: Record<string, 'active' | 'hidden' | 'deleted'>;
  section_parents?: Record<string, string | null>;
  created_at: string;
}

export interface CreateDormitoryInput {
  name: string;
  client_name: string;
  template_id?: number;
  structure_template_id?: number;
  structure_template_keys?: string[];
  tabs?: { source_id: string }[];
}

export interface ReportTemplate {
  id: number;
  name: string;
  row_count: number;
  created_at: string;
}

export interface ReportTemplateDetail extends ReportTemplate {
  rows: { name: string; position: number; formula: string | null; linked?: boolean }[];
}

export interface ReportRow {
  link?: ReportLink | null;
  id: number;
  name: string;
  position: number;
  formula: string | null;
  values: Record<string, string>;
  errors: Record<string, string>;
}

export interface DormitoryReport {
  from_date: string;
  to_date: string;
  rows: ReportRow[];
}

export type PlaceField = 'residents_m' | 'residents_f' | 'paid_m' | 'paid_f';

export interface HostelPlaces {
  months: {
    month: string;
    days: string[];
    hostels: {
      id: number;
      name: string;
      values: Record<string, Record<string, number>>;
    }[];
  }[];
}

export interface Resident {
  employee_id?: string | null;
  custom_values?: Record<string, CellValue>;
  id: number;
  gender: 'М' | 'Ж' | null;
  personnel_number: string | null;
  full_name: string | null;
  hostel_id: number | null;
  hostel_name: string | null;
  shift_start: string | null;
  shift_count: number | null;
  shift_end: string | null;
  phone: string | null;
  medical_book: 'Есть' | 'Нет' | 'Делается' | null;
  notes: string | null;
}

export interface ResidentsResponse {
  residents: Resident[];
  hostels: { id: number; name: string }[];
}

export type ResidentField = keyof Omit<
  Resident,
  'id' | 'hostel_name' | 'custom_values' | 'employee_id'
>;

export interface ResidentTransferPreview {
  target_dormitory_id: number;
  matched_columns: string[];
  warnings: { column: string; reason: string }[];
  empty_columns: string[];
  preview_token: string;
}

export interface ResidentOutflowPreview {
  matched_columns: string[];
  warnings: { column: string; reason: string }[];
  empty_columns: string[];
  departure_date: string | null;
  payments_to_delete: Record<PaymentKind, number>;
  preview_token: string;
}

export interface InflowRow {
  employee_id?: string | null;
  custom_values?: Record<string, CellValue>;
  id: number;
  settlement_date: string | null;
  personnel_number: string | null;
  full_name: string | null;
  citizenship: string | null;
  notes: string | null;
  shift_count: number | null;
}

export type InflowField = keyof Omit<InflowRow, 'id' | 'custom_values' | 'employee_id'>;

export interface OutflowRow {
  employee_id?: string | null;
  custom_values?: Record<string, CellValue>;
  id: number;
  departure_date: string | null;
  personnel_number: string | null;
  full_name: string | null;
  shift_start: string | null;
  reason: string | null;
  notes: string | null;
  additional_info: string | null;
}

export type OutflowField = keyof Omit<OutflowRow, 'id' | 'custom_values' | 'employee_id'>;

export type PaymentKind = 'advance' | 'settlement';

export interface PaymentRow {
  custom_values?: Record<string, CellValue>;
  id: number;
  personnel_number: string | null;
  full_name: string | null;
  advance_amount: string | null;
  settlement_date: string | null;
}

export type PaymentField = keyof Omit<PaymentRow, 'id' | 'custom_values'>;

export interface ResidentPaymentResult {
  payment: PaymentRow;
  created: boolean;
  copied_columns: string[];
  skipped_columns: string[];
}

export interface DailyReportReadiness {
  report_date: string;
  is_ready: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

export interface DashboardResponse {
  layout?: DashboardLayout;
  widgets?: WidgetResult[];
  report_date?: string;
  snapshot_date: string | null;
  totals: { attendance: number | null; residents: number | null };
  dormitories: {
    id: string;
    name: string;
    is_archived?: boolean;
    residents: number | null;
    attendance: number | null;
    turnover: number | null;
    vacancies: number | null;
    report_readiness?: DailyReportReadiness;
  }[];
  clients: { name: string; attendance: number | null }[];
  daily: {
    date: string;
    attendance: number | null;
    residents: number | null;
    turnover: number | null;
  }[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const pendingWrites = new Map<Promise<unknown>, string>();

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const operation = sendRequest<T>(path, init);
  if (!init.method || init.method === 'GET') return operation;
  pendingWrites.set(operation, path);
  try {
    return await operation;
  } finally {
    pendingWrites.delete(operation);
  }
}

export async function waitForDormitoryWrites(id: string): Promise<void> {
  // Opening the manager blurs cell editors and starts their saves.
  const prefix = `/dormitories/${encodeURIComponent(id)}/`;
  let writes: Promise<unknown>[];
  while (
    (writes = [...pendingWrites]
      .filter(([, path]) => path.startsWith(prefix))
      .map(([promise]) => promise)).length
  ) {
    const results = await Promise.allSettled(writes);
    if (results.some((result) => result.status === 'rejected'))
      throw new ApiError(409, 'Сначала исправьте ошибки сохранения данных.');
  }
  if (document.querySelector('[data-save-state="error"]'))
    throw new ApiError(409, 'Сначала исправьте ошибки сохранения данных.');
}

async function sendRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    // Cookie сессии — единственное хранилище токена, поэтому её надо отправлять всегда.
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    // 403 на рабочей ручке означает «кабинет не активирован»: экран активации
    // важнее, чем «не удалось загрузить» на конкретной странице.
    if (response.status === 403 && message === ACTIVATION_REQUIRED_DETAIL) {
      notifyActivationRequired();
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === 'string') {
        return detail;
      }
    }
  } catch {
    // Тело не JSON — показываем общий текст ниже.
  }
  return `Запрос не удался (${response.status})`;
}

export type BuiltinTableKey =
  'residents' | 'inflow' | 'outflow' | 'advance' | 'settlement' | 'archive';
export type TableKey = BuiltinTableKey | `custom_${number}`;
export type CellValue = string | number | boolean | null;
export type ColumnKind = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'action' | 'hostel';
export interface ColumnOption {
  id: string | null;
  label: string;
  archived: boolean;
}
export interface TableColumn {
  id: number;
  table_key: TableKey;
  builtin_key: string | null;
  name: string;
  kind: ColumnKind;
  position: number;
  options: ColumnOption[];
  archived: boolean;
}
export type ColumnInput = Pick<TableColumn, 'name' | 'kind' | 'options'>;
export interface ReportTableLink {
  table_key: TableKey;
  column_id: number;
  operator?: 'equals' | 'not_empty';
  value: CellValue;
  date_column_id: number | null;
}
export type PlaceMetric =
  PlaceField | 'residents_total' | 'paid_total' | 'free_m' | 'free_f' | 'free_total';
export interface PlaceReportLink {
  table_key: 'places';
  hostel_id: number | null;
  metric: PlaceMetric;
}
export type ReportLink = ReportTableLink | PlaceReportLink;
export interface ArchiveRow {
  employee_id?: string | null;
  id: number;
  created_at: string;
  custom_values: Record<string, CellValue>;
}
export interface CustomTab {
  id: number;
  dormitory_id: number;
  name: string;
  parent_id?: number | null;
  parent_section?: string | null;
  is_group?: boolean;
  table_key: `custom_${number}`;
  table_created: boolean;
  is_active: boolean;
  has_data: boolean;
  delete_block_reason: string | null;
}
export interface CustomTabTemplate extends CustomTab {
  dormitory_name: string;
  client_name: string;
}
export interface CustomTabRow {
  employee_id?: string | null;
  id: number;
  custom_values: Record<string, CellValue>;
}

export interface StandardSection {
  key: string;
  name: string;
  parent_key: string | null;
  status: 'active' | 'hidden' | 'deleted';
  has_data: boolean;
  delete_block_reason: string | null;
}

export interface TabCatalogVariant {
  id: string;
  name: string;
  kind: 'standard' | 'custom';
  section_key: string | null;
  tab_id: number | null;
  dormitory_id: number | null;
  dormitory_name: string;
  client_name: string;
  parent_name: string | null;
  path: string[];
}
export interface TabCatalogItem {
  id: string;
  name: string;
  variants: TabCatalogVariant[];
}

export interface SettingsColumn extends TableColumn {
  used_by: string[];
}
export interface DormitorySettings {
  revision: string;
  tables: Record<string, SettingsColumn[]>;
  tabs: CustomTab[];
  sections: StandardSection[];
  rules: Pick<ReportRow, 'id' | 'name' | 'formula' | 'link'>[];
}
export interface SettingsInput {
  revision: string;
  tables: { key: string; columns: (ColumnInput & { id?: number; archived: boolean })[] }[];
  tabs: { key: string; name: string; parent_key: string | null; is_active: boolean }[];
  sections: Record<string, 'active' | 'hidden'>;
  deleted: string[];
}
export interface StructureTemplate {
  id: number;
  name: string;
  tab_count: number;
  created_at: string;
}
export interface StructureTemplateDetail extends StructureTemplate {
  snapshot: {
    sections: Record<string, 'active' | 'hidden' | 'deleted'>;
    parents: Record<string, string | null>;
    tabs: { key: string; name: string; parent: string | null; is_active: boolean }[];
    columns: Record<string, TableColumn[]>;
    rows: Pick<ReportRow, 'name' | 'formula' | 'link'>[];
  };
}

export const api = {
  dormitorySettings(id: string, signal?: AbortSignal): Promise<DormitorySettings> {
    return request(`/dormitories/${encodeURIComponent(id)}/settings`, { signal });
  },
  saveDormitorySettings(id: string, input: SettingsInput): Promise<DormitorySettings> {
    return request(`/dormitories/${encodeURIComponent(id)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  structureTemplates(signal?: AbortSignal): Promise<StructureTemplate[]> {
    return request('/dormitory-templates', { signal });
  },
  structureTemplate(id: number, signal?: AbortSignal): Promise<StructureTemplateDetail> {
    return request(`/dormitory-templates/${id}`, { signal });
  },
  saveStructureTemplate(dormitoryId: string, name: string): Promise<StructureTemplate> {
    return request('/dormitory-templates', {
      method: 'POST',
      body: JSON.stringify({ dormitory_id: Number(dormitoryId), name }),
    });
  },
  deleteStructureTemplate(id: number): Promise<void> {
    return request(`/dormitory-templates/${id}`, { method: 'DELETE' });
  },
  customTabs(id: string, signal?: AbortSignal): Promise<CustomTab[]> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs`, { signal });
  },
  setCustomTabActive(id: string, tabId: number, active: boolean): Promise<CustomTab> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs/${tabId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: active }),
    });
  },
  deleteCustomTab(id: string, tabId: number): Promise<void> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs/${tabId}`, { method: 'DELETE' });
  },
  reportHostels(id: string, signal?: AbortSignal): Promise<{ id: number; name: string }[]> {
    return request(`/dormitories/${encodeURIComponent(id)}/hostels/sources`, { signal });
  },
  customTabTemplates(signal?: AbortSignal): Promise<CustomTabTemplate[]> {
    return request('/custom-tab-templates', { signal });
  },
  standardSections(id: string, signal?: AbortSignal): Promise<StandardSection[]> {
    return request(`/dormitories/${encodeURIComponent(id)}/sections`, { signal });
  },
  tabCatalog(signal?: AbortSignal): Promise<TabCatalogItem[]> {
    return request('/dormitory-tab-catalog', { signal });
  },
  changeStandardSection(
    id: string,
    key: string,
    status: 'active' | 'hidden' | 'deleted',
  ): Promise<StandardSection[]> {
    return request(`/dormitories/${encodeURIComponent(id)}/sections/${encodeURIComponent(key)}`, {
      method: status === 'deleted' ? 'DELETE' : 'PATCH',
      ...(status === 'deleted' ? {} : { body: JSON.stringify({ status }) }),
    });
  },
  createCustomTab(
    id: string,
    name: string,
    sourceTabId: number | null,
    subtabs: string[] = [],
    parentId: number | null = null,
    parentSection: string | null = null,
  ): Promise<CustomTab> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        source_tab_id: sourceTabId,
        ...(subtabs.length ? { subtabs } : {}),
        ...(parentId ? { parent_id: parentId } : {}),
        ...(parentSection ? { parent_section: parentSection } : {}),
      }),
    });
  },
  createCustomTabTable(id: string, tabId: number, columns: ColumnInput[]): Promise<CustomTab> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs/${tabId}/table`, {
      method: 'POST',
      body: JSON.stringify({ columns }),
    });
  },
  customTabRows(id: string, tabId: number, signal?: AbortSignal): Promise<CustomTabRow[]> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs/${tabId}/rows`, { signal });
  },
  createCustomTabRow(id: string, tabId: number): Promise<CustomTabRow> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs/${tabId}/rows`, { method: 'POST' });
  },
  deleteCustomTabRow(id: string, tabId: number, rowId: number): Promise<void> {
    return request(`/dormitories/${encodeURIComponent(id)}/tabs/${tabId}/rows/${rowId}`, {
      method: 'DELETE',
    });
  },
  tableColumns(id: string, table: TableKey, signal?: AbortSignal): Promise<TableColumn[]> {
    return request(`/dormitories/${encodeURIComponent(id)}/tables/${table}/columns`, { signal });
  },
  createColumn(id: string, table: TableKey, input: ColumnInput): Promise<TableColumn> {
    return request(`/dormitories/${encodeURIComponent(id)}/tables/${table}/columns`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateColumn(
    id: string,
    table: TableKey,
    columnId: number,
    input: ColumnInput,
  ): Promise<TableColumn> {
    return request(`/dormitories/${encodeURIComponent(id)}/tables/${table}/columns/${columnId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  deleteColumn(id: string, table: TableKey, columnId: number): Promise<void> {
    return request(`/dormitories/${encodeURIComponent(id)}/tables/${table}/columns/${columnId}`, {
      method: 'DELETE',
    });
  },
  restoreColumn(id: string, table: TableKey, columnId: number): Promise<TableColumn> {
    return request(
      `/dormitories/${encodeURIComponent(id)}/tables/${table}/columns/${columnId}/restore`,
      { method: 'POST' },
    );
  },
  saveCustomCell(
    id: string,
    table: TableKey,
    rowId: number,
    columnId: number,
    value: CellValue,
  ): Promise<{ value: CellValue }> {
    return request(
      `/dormitories/${encodeURIComponent(id)}/tables/${table}/rows/${rowId}/cells/${columnId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ value }),
      },
    );
  },
  archive(id: string, from: string, to: string, signal?: AbortSignal): Promise<ArchiveRow[]> {
    return request(
      `/dormitories/${encodeURIComponent(id)}/tables/archive/rows?${new URLSearchParams({ from, to })}`,
      { signal },
    );
  },
  createArchiveRow(id: string): Promise<ArchiveRow> {
    return request(`/dormitories/${encodeURIComponent(id)}/tables/archive/rows`, {
      method: 'POST',
    });
  },
  deleteArchiveRow(id: string, rowId: number): Promise<void> {
    return request(`/dormitories/${encodeURIComponent(id)}/tables/archive/rows/${rowId}`, {
      method: 'DELETE',
    });
  },
  register(email: string, fullName: string): Promise<RegisterResult> {
    return request<RegisterResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, full_name: fullName }),
    });
  },

  /** Проверка ссылки из письма: 410 приходит как ApiError с текстом причины. */
  activateInfo(token: string): Promise<ActivationInfo> {
    return request<ActivationInfo>(`/auth/activate/${encodeURIComponent(token)}`);
  },

  /** Новый пароль по ссылке: сервер активирует кабинет и ставит cookie сессии. */
  activate(token: string, password: string): Promise<UserProfile> {
    return request<UserProfile>('/auth/activate', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  },

  /** Повторная отправка письма. Ответ всегда 200 — адреса не перечисляются. */
  resendActivation(email: string): Promise<{ detail: string }> {
    return request<{ detail: string }>('/auth/activate/resend', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  /** Запрос письма для восстановления пароля. Ответ тоже всегда 200. */
  requestPasswordRecovery(email: string): Promise<{ detail: string }> {
    return request<{ detail: string }>('/auth/password-recovery', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  login(email: string, password: string): Promise<UserProfile> {
    return request<UserProfile>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  logout(): Promise<void> {
    return request<void>('/auth/logout', { method: 'POST' });
  },

  me(): Promise<UserProfile> {
    return request<UserProfile>('/me');
  },

  dormitories(signal?: AbortSignal): Promise<Dormitory[]> {
    return request<Dormitory[]>('/dormitories', { signal });
  },

  reportReadiness(id: string, signal?: AbortSignal): Promise<DailyReportReadiness> {
    return request<DailyReportReadiness>(
      `/dormitories/${encodeURIComponent(id)}/report-readiness`,
      {
        signal,
      },
    );
  },

  setReportReadiness(
    id: string,
    reportDate: string,
    isReady: boolean,
  ): Promise<DailyReportReadiness> {
    return request<DailyReportReadiness>(
      `/dormitories/${encodeURIComponent(id)}/report-readiness`,
      {
        method: 'PUT',
        body: JSON.stringify({ report_date: reportDate, is_ready: isReady }),
      },
    );
  },

  dashboard(
    from: string,
    to: string,
    signal?: AbortSignal,
    dormitoryId?: string | null,
  ): Promise<DashboardResponse> {
    const query = new URLSearchParams({ from, to });
    if (dormitoryId) query.set('dormitory_id', dormitoryId);
    return request<DashboardResponse>(`/dashboard?${query}`, { signal });
  },

  dashboardSources(signal?: AbortSignal): Promise<CatalogDormitory[]> {
    return request<CatalogDormitory[]>('/dashboard/sources', { signal });
  },
  saveDashboardLayout(
    input: Pick<DashboardLayout, 'revision' | 'order' | 'hidden'>,
  ): Promise<DashboardLayout> {
    return request<DashboardLayout>('/dashboard/layout', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  saveDashboardBlock(
    revision: number,
    config: WidgetConfig,
    id?: number,
  ): Promise<DashboardLayout> {
    return request<DashboardLayout>(id ? `/dashboard/blocks/${id}` : '/dashboard/blocks', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({ revision, config }),
    });
  },
  deleteDashboardBlock(id: number, revision: number): Promise<DashboardLayout> {
    return request<DashboardLayout>(`/dashboard/blocks/${id}?revision=${revision}`, {
      method: 'DELETE',
    });
  },
  previewDashboardBlock(config: WidgetConfig, from: string, to: string): Promise<WidgetResult> {
    return request<WidgetResult>(`/dashboard/preview?${new URLSearchParams({ from, to })}`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  createDormitory(input: CreateDormitoryInput): Promise<Dormitory> {
    return request<Dormitory>('/dormitories', { method: 'POST', body: JSON.stringify(input) });
  },

  updateDormitory(
    id: string,
    input: { name?: string; client_name?: string; is_archived?: boolean },
  ): Promise<Dormitory> {
    return request<Dormitory>(`/dormitories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  reportTemplates(signal?: AbortSignal): Promise<ReportTemplate[]> {
    return request<ReportTemplate[]>('/report-templates', { signal });
  },

  reportTemplate(id: number, signal?: AbortSignal): Promise<ReportTemplateDetail> {
    return request<ReportTemplateDetail>(`/report-templates/${id}`, { signal });
  },

  saveReportTemplate(dormitoryId: string, name: string): Promise<ReportTemplate> {
    return request<ReportTemplate>('/report-templates', {
      method: 'POST',
      body: JSON.stringify({ name, dormitory_id: Number(dormitoryId) }),
    });
  },

  deleteReportTemplate(templateId: number): Promise<void> {
    return request<void>(`/report-templates/${templateId}`, { method: 'DELETE' });
  },

  dormitory(id: string, signal?: AbortSignal): Promise<Dormitory> {
    return request<Dormitory>(`/dormitories/${encodeURIComponent(id)}`, { signal });
  },

  report(id: string, from: string, to: string, signal?: AbortSignal): Promise<DormitoryReport> {
    const query = new URLSearchParams({ from, to });
    return request<DormitoryReport>(`/dormitories/${encodeURIComponent(id)}/report?${query}`, {
      signal,
    });
  },

  hostelPlaces(id: string, from: string, to: string, signal?: AbortSignal): Promise<HostelPlaces> {
    const query = new URLSearchParams({ from, to });
    return request<HostelPlaces>(`/dormitories/${encodeURIComponent(id)}/hostels?${query}`, {
      signal,
    });
  },

  residents(id: string, month: string, signal?: AbortSignal): Promise<ResidentsResponse> {
    const query = new URLSearchParams({ month: `${month}-01` });
    return request<ResidentsResponse>(`/dormitories/${encodeURIComponent(id)}/residents?${query}`, {
      signal,
    });
  },

  createResident(id: string): Promise<Resident> {
    return request<Resident>(`/dormitories/${encodeURIComponent(id)}/residents`, {
      method: 'POST',
    });
  },

  updateResident(
    id: string,
    residentId: number,
    month: string,
    field: ResidentField,
    value: string | number | null,
  ): Promise<Resident> {
    const query = new URLSearchParams({ month: `${month}-01` });
    return request<Resident>(
      `/dormitories/${encodeURIComponent(id)}/residents/${residentId}?${query}`,
      { method: 'PATCH', body: JSON.stringify({ [field]: value }) },
    );
  },

  deleteResident(id: string, residentId: number): Promise<void> {
    return request<void>(`/dormitories/${encodeURIComponent(id)}/residents/${residentId}`, {
      method: 'DELETE',
    });
  },

  registerResidentPayment(
    id: string,
    residentId: number,
    kind: PaymentKind,
  ): Promise<ResidentPaymentResult> {
    return request<ResidentPaymentResult>(
      `/dormitories/${encodeURIComponent(id)}/residents/${residentId}/payments/${kind}`,
      { method: 'POST' },
    );
  },

  previewResidentTransfer(
    id: string,
    residentId: number,
    targetId: number,
    month: string,
    signal?: AbortSignal,
  ): Promise<ResidentTransferPreview> {
    return request(
      `/dormitories/${encodeURIComponent(id)}/residents/${residentId}/transfer/preview`,
      {
        method: 'POST',
        body: JSON.stringify({ target_dormitory_id: targetId, month: `${month}-01` }),
        signal,
      },
    );
  },

  transferResident(
    id: string,
    residentId: number,
    targetId: number,
    month: string,
    previewToken: string,
    confirmLoss: boolean,
  ): Promise<Resident> {
    return request(`/dormitories/${encodeURIComponent(id)}/residents/${residentId}/transfer`, {
      method: 'POST',
      body: JSON.stringify({
        target_dormitory_id: targetId,
        month: `${month}-01`,
        preview_token: previewToken,
        confirm_loss: confirmLoss,
      }),
    });
  },

  previewResidentOutflow(
    id: string,
    residentId: number,
    signal?: AbortSignal,
  ): Promise<ResidentOutflowPreview> {
    return request(
      `/dormitories/${encodeURIComponent(id)}/residents/${residentId}/outflow/preview`,
      {
        method: 'POST',
        signal,
      },
    );
  },

  moveResidentToOutflow(
    id: string,
    residentId: number,
    previewToken: string,
    confirmLoss: boolean,
  ): Promise<OutflowRow> {
    return request(`/dormitories/${encodeURIComponent(id)}/residents/${residentId}/outflow`, {
      method: 'POST',
      body: JSON.stringify({ preview_token: previewToken, confirm_loss: confirmLoss }),
    });
  },

  inflow(id: string, from: string, to: string, signal?: AbortSignal): Promise<InflowRow[]> {
    const query = new URLSearchParams({ from, to });
    return request<InflowRow[]>(`/dormitories/${encodeURIComponent(id)}/inflow?${query}`, {
      signal,
    });
  },

  createInflowRow(id: string): Promise<InflowRow> {
    return request<InflowRow>(`/dormitories/${encodeURIComponent(id)}/inflow`, {
      method: 'POST',
    });
  },

  updateInflowRow(
    id: string,
    rowId: number,
    field: InflowField,
    value: string | number | null,
  ): Promise<InflowRow> {
    return request<InflowRow>(`/dormitories/${encodeURIComponent(id)}/inflow/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
  },

  deleteInflowRow(id: string, rowId: number): Promise<void> {
    return request<void>(`/dormitories/${encodeURIComponent(id)}/inflow/${rowId}`, {
      method: 'DELETE',
    });
  },

  outflow(id: string, from: string, to: string, signal?: AbortSignal): Promise<OutflowRow[]> {
    const query = new URLSearchParams({ from, to });
    return request<OutflowRow[]>(`/dormitories/${encodeURIComponent(id)}/outflow?${query}`, {
      signal,
    });
  },

  createOutflowRow(id: string): Promise<OutflowRow> {
    return request<OutflowRow>(`/dormitories/${encodeURIComponent(id)}/outflow`, {
      method: 'POST',
    });
  },

  updateOutflowRow(
    id: string,
    rowId: number,
    field: OutflowField,
    value: string | null,
  ): Promise<OutflowRow> {
    return request<OutflowRow>(`/dormitories/${encodeURIComponent(id)}/outflow/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
  },

  deleteOutflowRow(id: string, rowId: number): Promise<void> {
    return request<void>(`/dormitories/${encodeURIComponent(id)}/outflow/${rowId}`, {
      method: 'DELETE',
    });
  },

  payments(
    id: string,
    kind: PaymentKind,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<PaymentRow[]> {
    const query = kind === 'settlement' ? `?${new URLSearchParams({ from, to })}` : '';
    return request<PaymentRow[]>(
      `/dormitories/${encodeURIComponent(id)}/payments/${kind}${query}`,
      {
        signal,
      },
    );
  },

  createPaymentRow(id: string, kind: PaymentKind): Promise<PaymentRow> {
    return request<PaymentRow>(`/dormitories/${encodeURIComponent(id)}/payments/${kind}`, {
      method: 'POST',
    });
  },

  updatePaymentRow(
    id: string,
    kind: PaymentKind,
    rowId: number,
    field: PaymentField,
    value: string | null,
  ): Promise<PaymentRow> {
    return request<PaymentRow>(`/dormitories/${encodeURIComponent(id)}/payments/${kind}/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
  },

  deletePaymentRow(id: string, kind: PaymentKind, rowId: number): Promise<void> {
    return request<void>(`/dormitories/${encodeURIComponent(id)}/payments/${kind}/${rowId}`, {
      method: 'DELETE',
    });
  },

  clearPaymentRows(id: string, kind: PaymentKind): Promise<void> {
    return request<void>(`/dormitories/${encodeURIComponent(id)}/payments/${kind}`, {
      method: 'DELETE',
    });
  },

  createHostel(id: string, name: string, month: string): Promise<{ id: number; name: string }> {
    return request<{ id: number; name: string }>(`/dormitories/${encodeURIComponent(id)}/hostels`, {
      method: 'POST',
      body: JSON.stringify({ name, month }),
    });
  },

  removeHostel(id: string, hostelId: number, month: string): Promise<void> {
    const query = new URLSearchParams({ month });
    return request<void>(`/dormitories/${encodeURIComponent(id)}/hostels/${hostelId}?${query}`, {
      method: 'DELETE',
    });
  },

  saveHostelCell(
    id: string,
    hostelId: number,
    date: string,
    field: PlaceField,
    value: number | null,
  ): Promise<void> {
    return request<void>(
      `/dormitories/${encodeURIComponent(id)}/hostels/${hostelId}/cells/${date}/${field}`,
      {
        method: 'PUT',
        body: JSON.stringify({ value }),
      },
    );
  },

  createReportRow(
    id: string,
    name: string,
    formula: string | null,
    link?: ReportLink | null,
  ): Promise<ReportRow> {
    return request<ReportRow>(`/dormitories/${encodeURIComponent(id)}/report/rows`, {
      method: 'POST',
      body: JSON.stringify({ name, formula, ...(link !== undefined ? { link } : {}) }),
    });
  },

  updateReportRow(
    id: string,
    rowId: number,
    name: string,
    formula: string | null,
    link?: ReportLink | null,
  ): Promise<ReportRow> {
    return request<ReportRow>(`/dormitories/${encodeURIComponent(id)}/report/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, formula, ...(link !== undefined ? { link } : {}) }),
    });
  },

  moveReportRow(id: string, rowId: number, direction: 'up' | 'down'): Promise<ReportRow> {
    return request<ReportRow>(`/dormitories/${encodeURIComponent(id)}/report/rows/${rowId}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ direction }),
    });
  },

  deleteReportRow(id: string, rowId: number): Promise<void> {
    return request<void>(`/dormitories/${encodeURIComponent(id)}/report/rows/${rowId}`, {
      method: 'DELETE',
    });
  },

  saveReportCell(id: string, rowId: number, date: string, value: string): Promise<void> {
    return request<void>(
      `/dormitories/${encodeURIComponent(id)}/report/rows/${rowId}/cells/${date}`,
      { method: 'PUT', body: JSON.stringify({ value }) },
    );
  },
};
