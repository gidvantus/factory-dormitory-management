/**
 * Клиент API кабинета оператора.
 *
 * Ручки ровно те, что отдаёт `operator-api`: вход, «кто вошёл», выход
 * (`operator/backend/app/api/auth.py`) и организации платформы
 * (`operator/backend/app/api/organizations.py`). Токен не хранится в JS: сессия
 * живёт в httpOnly cookie `operator_session`, поэтому каждый запрос идёт с
 * `credentials: 'include'`.
 *
 * Путь относительный (`/api`) — так же, как у основного кабинета: nginx кабинета
 * проксирует `/api/` в `operator-api`, и cookie остаётся first-party.
 */

/** Ответ `POST /api/auth/login` и `GET /api/auth/me`: логин единственного оператора. */
export interface Operator {
  username: string;
}

/** Отказ API с кодом ответа и текстом, который сервер прислал в `detail`. */
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
    // Cookie сессии — единственное хранилище токена: без этого браузер её не отправит.
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

/**
 * Текст отказа для пользователя.
 *
 * У ошибки приложения `detail` — строка («Неверный логин или пароль»), и её
 * экран показывает дословно: это контракт. У ошибки валидации FastAPI `detail` —
 * список объектов `{type, loc, msg, input}`: берём первое `msg`, иначе
 * пользователь увидел бы «Запрос не удался (422)» вместо причины.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    return errorText(response.status, await response.json());
  } catch {
    return `Запрос не удался (${response.status})`;
  }
}

function errorText(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    const validation = validationErrorsText(detail);
    if (validation !== '') {
      return validation;
    }
  }
  return `Запрос не удался (${status})`;
}

/**
 * Тексты ошибок валидации FastAPI — через `; `, без служебной приставки.
 *
 * pydantic предваряет текст валидатора: «Value error, Название не может быть
 * пустым». Кабинет показывает отказ дословно и по контракту ровно «Название не
 * может быть пустым», поэтому приставка снимается, а `loc` не печатается: текст
 * уже называет поле словами, а «body.inn:» в лицо оператору не нужно.
 */
function validationErrorsText(detail: unknown): string {
  if (!Array.isArray(detail)) {
    return '';
  }
  return detail
    .map((item) => {
      if (item === null || typeof item !== 'object') {
        return '';
      }
      const message = (item as { msg?: unknown }).msg;
      if (typeof message !== 'string') {
        return '';
      }
      return message.replace(/^Value error,\s*/i, '').trim();
    })
    .filter((message) => message !== '')
    .join('; ');
}

/** Вход по паре из конфига. Неверная пара — `ApiError` со статусом 401. */
export function login(username: string, password: string): Promise<Operator> {
  return request<Operator>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** Кто вошёл. Без сессии — `ApiError` со статусом 401. */
export function me(): Promise<Operator> {
  return request<Operator>('/auth/me');
}

/** Выход: сервер гасит cookie и отвечает `204`, в том числе без сессии. */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

// --- Организации платформы --------------------------------------------------
// Форма ответа — та же, что у основного API: кабинет-API её не переписывает
// (`operator/backend/app/schemas.py`). Название и ИНН бывают `null` у пустой
// заготовки организации — это нормальное состояние, а не отсутствие данных.

/** Строка списка организаций. */
export interface OrganizationListItem {
  id: number;
  name: string | null;
  inn: string | null;
  /** ISO-8601 из API; показывается как дата без времени. */
  created_at: string;
}

/** Карточка организации: реквизиты и счётчики. */
export interface OrganizationDetails {
  id: number;
  name: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  created_at: string;
  /** Участники организации, владелец считается. */
  members_count: number;
  /** Общежития организации, архивные считаются. */
  dormitories_count: number;
}

/** Страница списка: элементы и общее число организаций. */
export interface OrganizationPage {
  items: OrganizationListItem[];
  total: number;
}

/**
 * Тело правки. Кабинет отправляет все пять полей всегда (`Контракт половин`),
 * а `null` в реквизите означает очистку поля. Пустое название отправляется как
 * есть: правило «название не пустое» живёт в основном API, и его отказ
 * показывается дословно.
 */
export interface OrganizationUpdate {
  name: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
}

/** Страница организаций: свежие сверху. `limit` 1..100, `offset` ≥ 0. */
export function listOrganizations(limit: number, offset: number): Promise<OrganizationPage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<OrganizationPage>(`/organizations?${query.toString()}`);
}

/** Карточка организации. Неизвестный `id` — `ApiError` со статусом 404. */
export function getOrganization(id: number): Promise<OrganizationDetails> {
  return request<OrganizationDetails>(`/organizations/${id}`);
}

/** Правка организации: ответ — то, что сохранил основной API. */
export function updateOrganization(
  id: number,
  payload: OrganizationUpdate,
): Promise<OrganizationDetails> {
  return request<OrganizationDetails>(`/organizations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
