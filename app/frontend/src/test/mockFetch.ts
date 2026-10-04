import { vi } from 'vitest';

export interface MockResponse {
  status: number;
  body?: unknown;
}

export type MockHandler = (url: string, init?: RequestInit) => MockResponse;

/**
 * Подменяет fetch. Возвращает мок, по вызовам которого тесты проверяют,
 * ходил ли клиент на конкретный маршрут API.
 */
export function mockFetch(handler: MockHandler): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function anonymousSession(): MockResponse {
  return { status: 401, body: { detail: 'Требуется авторизация' } };
}

export function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(path));
}
