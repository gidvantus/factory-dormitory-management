import { createContext, useContext } from 'react';
import type { CellValue, TableColumn, TableKey } from '../../api/client';

export type ColumnsDialog = null | 'manage' | 'new' | TableColumn;

export interface TableColumnsContext {
  dormitoryId: string;
  table: TableKey;
  columns: TableColumn[];
  loading: boolean;
  error: string;
  reload: () => void;
  edit: (dialog: ColumnsDialog) => void;
  values: Record<string, CellValue>;
  saved: (key: string, value: CellValue) => void;
  trackSave: <T>(key: string, promise: Promise<T>) => Promise<T>;
  waitForRowSaves: (rowId: number) => Promise<void>;
}

export const ColumnsContext = createContext<TableColumnsContext | null>(null);

export function useColumns(): TableColumnsContext {
  const value = useContext(ColumnsContext);
  if (!value) throw new Error('TableColumnsProvider is required');
  return value;
}

export function useTableSaves(): Pick<TableColumnsContext, 'trackSave' | 'waitForRowSaves'> {
  return useColumns();
}
