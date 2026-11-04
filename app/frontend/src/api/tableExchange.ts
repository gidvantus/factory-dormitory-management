import { request, requestBlob, waitForDormitoryWrites } from './client';
import type { DateRange } from '../workspace/dashboard/dates';

export const TABLE_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export interface TableImportResult {
  rows_added: number;
  cells_added: number;
}

function path(id: string, key: string, action: string, range?: DateRange): string {
  const query = range ? `?${new URLSearchParams({ from: range.from, to: range.to })}` : '';
  return `/dormitories/${encodeURIComponent(id)}/data-transfer/${encodeURIComponent(key)}/${action}${query}`;
}

export async function downloadTableFile(
  id: string,
  key: string,
  action: 'template' | 'export',
  range?: DateRange,
  name = 'Таблица',
): Promise<void> {
  await waitForDormitoryWrites(id);
  const blob = await requestBlob(path(id, key, action, range));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const filename = name.replace(/[<>:"/\\|?*]/g, '-');
  link.download = `${action === 'template' ? 'Шаблон' : 'Экспорт'}-${filename}.xlsx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importTableFile(
  id: string,
  key: string,
  file: File,
  range?: DateRange,
): Promise<TableImportResult> {
  await waitForDormitoryWrites(id);
  const body = new FormData();
  body.append('file', file);
  return request(path(id, key, 'import', range), { method: 'POST', body });
}
