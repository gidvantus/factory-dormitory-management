export interface UserProfile {
  email: string;
  full_name: string;
  created_at: string;
}

export interface RegisterResult extends UserProfile {
  /** Открытый пароль. Сервер возвращает его единственный раз — в ответе регистрации. */
  password: string;
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

export interface ReportTemplate {
  id: number;
  name: string;
  row_count: number;
  created_at: string;
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
    throw new ApiError(response.status, await readErrorMessage(response));
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

export const api = {
  register(email: string, fullName: string): Promise<RegisterResult> {
    return request<RegisterResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, full_name: fullName }),
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

  createDormitory(input: CreateDormitoryInput): Promise<Dormitory> {
    return request<Dormitory>('/dormitories', { method: 'POST', body: JSON.stringify(input) });
  },

  reportTemplates(signal?: AbortSignal): Promise<ReportTemplate[]> {
    return request<ReportTemplate[]>('/report-templates', { signal });
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
