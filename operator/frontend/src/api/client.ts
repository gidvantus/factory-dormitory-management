/**
 * Клиент API кабинета оператора.
 *
 * Ручки ровно те, что отдаёт `operator-api` (`operator/backend/app/api/auth.py`):
 * вход, «кто вошёл» и выход. Токен не хранится в JS: сессия живёт в httpOnly
 * cookie `operator_session`, поэтому каждый запрос идёт с `credentials: 'include'`.
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
    if (Array.isArray(detail)) {
      for (const item of detail) {
        if (item && typeof item === 'object') {
          const message = (item as { msg?: unknown }).msg;
          if (typeof message === 'string') {
            return message;
          }
        }
      }
    }
  }
  return `Запрос не удался (${status})`;
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
