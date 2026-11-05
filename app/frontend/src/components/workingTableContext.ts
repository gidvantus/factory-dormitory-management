import { createContext, useContext } from 'react';
import { orderedKeys } from './workingTableModel';

export const OrderContext = createContext<string[]>([]);
export function useWorkingColumns<T extends { id: number | string }>(columns: T[]): T[] {
  const order = useContext(OrderContext);
  const byId = new Map(columns.map((column) => [String(column.id), column]));
  return orderedKeys([...byId.keys()], order).map((key) => byId.get(key)!);
}
