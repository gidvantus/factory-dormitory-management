import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmPlacesImport, uploadPlacesImport } from './client';
import { mockFetch } from '../test/mockFetch';

interface ProgressEvent {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

class FakeUpload {
  onprogress: ((event: ProgressEvent) => void) | null = null;
  onload: (() => void) | null = null;
}

/** Минимальная замена `XMLHttpRequest`: тесты сами решают, когда придёт ответ. */
class FakeXhr {
  static last: FakeXhr | null = null;

  upload = new FakeUpload();
  method = '';
  url = '';
  body: FormData | null = null;
  status = 0;
  response: unknown = null;
  withCredentials = false;
  responseType = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: FormData): void {
    this.body = body;
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  finish(status: number, response: unknown): void {
    this.status = status;
    this.response = response;
    this.onload?.();
  }
}

function file(): File {
  return new File(['x'], 'mesta.xlsx');
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.last = null;
});

describe('uploadPlacesImport', () => {
  it('шлёт файл multipart с cookie и отдаёт процент выгрузки', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const percent = vi.fn();

    const result = uploadPlacesImport('7', file(), percent);
    const xhr = FakeXhr.last!;

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/dormitories/7/hostels/import');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.responseType).toBe('json');
    expect((xhr.body as FormData).get('file')).toBeInstanceOf(File);

    xhr.progress(512, 1024);
    expect(percent).toHaveBeenCalledWith(50);
    xhr.upload.onload?.();
    expect(percent).toHaveBeenLastCalledWith(100);

    xhr.finish(200, { import_id: 1, status: 'ready', errors: [] });
    await expect(result).resolves.toMatchObject({ import_id: 1, status: 'ready' });
  });

  it('возвращает разбор при 422 и отказывает на прочих кодах', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const noop = (): void => undefined;

    const failed = uploadPlacesImport('7', file(), noop);
    FakeXhr.last!.finish(422, {
      import_id: 4,
      status: 'failed',
      errors: [{ row: 4, column: '05.11.2025', message: 'не число' }],
    });
    await expect(failed).resolves.toMatchObject({ status: 'failed', import_id: 4 });

    const tooBig = uploadPlacesImport('7', file(), noop);
    FakeXhr.last!.finish(413, { detail: 'Файл больше 20 МБ — уменьшите его и попробуйте снова' });
    await expect(tooBig).rejects.toThrow('Файл больше 20 МБ');

    const broken = uploadPlacesImport('7', file(), noop);
    FakeXhr.last!.finish(500, null);
    await expect(broken).rejects.toThrow('Запрос не удался (500)');
  });
});

describe('confirmPlacesImport', () => {
  it('подтверждает задание POST-ом на confirm', async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe('/api/dormitories/7/hostels/import/4/confirm');
      expect(init?.method).toBe('POST');
      return {
        status: 200,
        body: { import_id: 4, month: '2025-11-01', hostels: 3, cells: 4 },
      };
    });

    await expect(confirmPlacesImport('7', 4)).resolves.toEqual({
      import_id: 4,
      month: '2025-11-01',
      hostels: 3,
      cells: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
