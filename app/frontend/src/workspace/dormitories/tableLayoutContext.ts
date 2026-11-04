import { createContext } from 'react';
import type { ReactNode } from 'react';

export const TableLayoutContext = createContext<{
  exchange: ReactNode;
  period: ReactNode;
  readOnly: boolean;
}>({ exchange: null, period: null, readOnly: false });
