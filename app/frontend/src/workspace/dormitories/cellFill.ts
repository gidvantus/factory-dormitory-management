import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { CellFillConfig, CellFillSource, ColumnKind } from '../../api/client';

export interface FillColumn {
  id: number;
  name: string;
  kind: ColumnKind;
  fill?: CellFillConfig | null;
  archived?: boolean;
}
export const personnelFillSource: CellFillSource = {
  key: 'personnel',
  name: 'Персонал / Сотрудники',
  fields: [
    { id: 'full_name', name: 'ФИО', kind: 'text' },
    { id: 'personnel_number', name: 'Табельный номер', kind: 'text' },
    { id: 'phone', name: 'Телефон', kind: 'text' },
  ],
};
export const supportsCellFill = (kind: ColumnKind): boolean =>
  ['text', 'number', 'date', 'checkbox'].includes(kind);

export function sourceFields(
  columns: (FillColumn & { builtin_key?: string | null })[],
): CellFillSource['fields'] {
  return columns
    .filter((col) => !col.archived && col.kind !== 'action')
    .map((col) => ({
      id: String(col.id),
      name: col.name,
      kind: col.kind === 'select' || col.kind === 'hostel' ? 'text' : col.kind,
    }));
}

export function useCellFillSources(
  dormitoryId?: string,
  enabled = true,
): { sources: CellFillSource[]; loading: boolean; error: string; retry: () => void } {
  const [sources, setSources] = useState<CellFillSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!dormitoryId || !enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .cellFillSources(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setSources(result);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить источники.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, enabled, attempt]);
  return { sources, loading, error, retry: () => setAttempt((value) => value + 1) };
}

export function cellFillError(
  value: CellFillConfig | null | undefined,
  kind: ColumnKind,
  columns: FillColumn[],
  sources: CellFillSource[],
): string {
  if (!value) return '';
  const source = sources.find((item) => item.key === value.source);
  const field = source?.fields.find((item) => item.id === value.field);
  if (!field || field.kind !== kind) return 'Выберите таблицу и совместимый столбец источника.';
  if (
    value.mode === 'lookup' &&
    !columns.some(
      (col) =>
        !col.archived &&
        col.id === value.match_column_id &&
        col.fill?.mode === 'pick' &&
        col.fill.source === value.source,
    )
  )
    return 'Выберите столбец выбора записи из той же таблицы.';
  return '';
}
