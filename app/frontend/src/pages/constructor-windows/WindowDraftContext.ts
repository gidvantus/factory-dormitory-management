import { createContext } from 'react';
import type { EditorSnapshot } from '../../components/EditorSurface';
import type { TableKey } from '../../api/client';
import type { Sandbox } from '../constructor-sandbox/store';

export const WindowDraftContext = createContext<{
  store: Sandbox;
  dorm: string;
  table: TableKey;
  snapshot: EditorSnapshot | null;
  form: Record<string, string>;
} | null>(null);
