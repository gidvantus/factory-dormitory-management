import { vi } from 'vitest';

/** Ответ, который «приходит» из сети. */
export interface MockResponse {
  status: number;
  body?: unknown;
}

/** Шаг очереди: готовый ответ, сетевой отказ или заранее подготовленное обещание. */
export type MockStep = MockResponse | { reject: true } | (() => Promise<MockResponse>);

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export interface FetchMock {
  /** Все запросы по порядку: путь и настройки. */
  calls: FetchCall[];
  /** Подменённый `fetch` — им же можно спрашивать количество вызовов. */
  fetchMock: ReturnType<typeof vi.fn>;
}

/**
 * Подменяет `fetch` очередью ответов.
 *
 * Очередь, а не «всегда 200»: экрану входа нужен и ответ входа, и проверка
 * сессии, а порядок запросов — часть проверки. Лишний запрос роняет тест: он
 * значит, что экран сходил туда, куда не должен был.
 */
export function mockFetch(steps: MockStep[]): FetchMock {
  const calls: FetchCall[] = [];
  const queue = [...steps];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = queue.shift();
    if (step === undefined) {
      throw new Error(`Неожиданный запрос: ${String(input)}`);
    }
    const reply = typeof step === 'function' ? await step() : step;
    if ('reject' in reply) {
      throw new TypeError('Failed to fetch');
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
