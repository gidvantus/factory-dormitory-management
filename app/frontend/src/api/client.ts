import { ACTIVATION_REQUIRED_DETAIL, notifyActivationRequired } from '../auth/activation';

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
  created_at: string;
}

export interface CreateDormitoryInput {
  name: string;
  client_name: string;
  template_id?: number;
}

export interface Organization {
  id: number;
  /** null — организация ещё не заполнена: сразу после активации оба поля пустые. */
  name: string | null;
  inn: string | null;
  created_at: string;
}

export interface UpdateOrganizationInput {
  name: string;
  inn: string;
}

export interface ReportTemplate {
  id: number;
  name: string;
  row_count: number;
  created_at: string;
}

export interface ReportTemplateDetail extends ReportTemplate {
  rows: { name: string; position: number; formula: string | null }[];
}

export interface ReportRow {
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

export type PlaceField = 'residents_m' | 'residents_f' | 'free_m' | 'free_f' | 'paid_m' | 'paid_f';

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

export type ResidentField = keyof Omit<Resident, 'id' | 'hostel_name'>;

export interface InflowRow {
  id: number;
  settlement_date: string | null;
  personnel_number: string | null;
  full_name: string | null;
  citizenship: string | null;
  notes: string | null;
  shift_count: number | null;
}

export type InflowField = keyof Omit<InflowRow, 'id'>;

export interface OutflowRow {
  id: number;
  departure_date: string | null;
  personnel_number: string | null;
  full_name: string | null;
  shift_start: string | null;
  reason: string | null;
  notes: string | null;
  additional_info: string | null;
}

export type OutflowField = keyof Omit<OutflowRow, 'id'>;

export type PaymentKind = 'advance' | 'settlement';

export interface PaymentRow {
  id: number;
  personnel_number: string | null;
  full_name: string | null;
  advance_amount: string | null;
  settlement_date: string | null;
}

export type PaymentField = keyof Omit<PaymentRow, 'id'>;

export interface DashboardResponse {
  snapshot_date: string | null;
  totals: { attendance: number | null; residents: number | null };
  dormitories: {
    id: string;
    name: string;
    residents: number | null;
    attendance: number | null;
    turnover: number | null;
    vacancies: number | null;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

/**
 * Текст ошибки для пользователя.
 *
 * У ошибки приложения `detail` — строка («Организация с таким ИНН уже есть»), а у
 * ошибки валидации FastAPI — **список** объектов вида
 * `{type, loc, msg, input}`. Из-за этой разницы раньше любой 422 показывался
 * пользователю как «Запрос не удался (422)» вместо конкретной причины, хотя
 * требование задачи — показывать текст сервера. Поэтому список разбираем:
 * берём `msg` каждого элемента и убираем служебную приставку pydantic.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === 'string') {
        return detail;
      }
      const validation = validationErrorsText(detail);
      if (validation) {
        return validation;
      }
    }
  } catch {
    // Тело не JSON — показываем общий текст ниже.
  }
  return `Запрос не удался (${response.status})`;
}

/** `loc` вида `['body', 'inn']` → «inn»: путь поля в теле запроса. */
function fieldFromLocation(location: unknown): string {
  if (!Array.isArray(location)) return '';
  const parts = location
    .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
    .map(String)
    .filter((part) => part !== 'body');
  return parts.length > 0 ? `${parts.join('.')}: ` : '';
}

function validationErrorsText(detail: unknown): string {
  if (!Array.isArray(detail)) return '';
  const messages = detail
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const error = item as { loc?: unknown; msg?: unknown };
      if (typeof error.msg !== 'string') return '';
      // pydantic предваряет текст валидатора: «Value error, ИНН должен…».
      const message = error.msg.replace(/^Value error,\s*/i, '').trim();
      if (!message) return '';
      return `${fieldFromLocation(error.loc)}${message}`;
    })
    .filter(Boolean);
  return messages.join('; ');
}

export const api = {
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

  /** Организация пользователя. 404 приходит как ApiError: он не привязан к организации. */
  organization(signal?: AbortSignal): Promise<Organization> {
    return request<Organization>('/organization', { signal });
  },

  /** Правка организации. Пустая строка очищает поле; 409 — занятый ИНН. */
  saveOrganization(input: UpdateOrganizationInput): Promise<Organization> {
    return request<Organization>('/organization', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  dormitories(signal?: AbortSignal): Promise<Dormitory[]> {
    return request<Dormitory[]>('/dormitories', { signal });
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

  createDormitory(input: CreateDormitoryInput): Promise<Dormitory> {
    return request<Dormitory>('/dormitories', { method: 'POST', body: JSON.stringify(input) });
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

  createReportRow(id: string, name: string, formula: string | null): Promise<ReportRow> {
    return request<ReportRow>(`/dormitories/${encodeURIComponent(id)}/report/rows`, {
      method: 'POST',
      body: JSON.stringify({ name, formula }),
    });
  },

  updateReportRow(
    id: string,
    rowId: number,
    name: string,
    formula: string | null,
  ): Promise<ReportRow> {
    return request<ReportRow>(`/dormitories/${encodeURIComponent(id)}/report/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, formula }),
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
