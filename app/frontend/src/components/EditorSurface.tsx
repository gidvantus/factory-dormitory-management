import { createContext, useContext, useEffect } from 'react';
import type { ComponentType, ReactNode } from 'react';

export interface EditorSnapshot {
  kind: string;
  value: unknown;
}
export const EditorSurfaceContext = createContext<{
  inline: boolean;
  windowed?: boolean;
  intro?: ComponentType<{ editorId: string }>;
  layout?: ComponentType<{ editorId: string; children: ReactNode }>;
  publish: (snapshot: EditorSnapshot) => void;
} | null>(null);

/** Не меняет редактор; передаёт его черновик дополнительному предпросмотру. */
export function useEditorPreview(kind: string, value: unknown): void {
  const surface = useContext(EditorSurfaceContext);
  const serialized = surface ? JSON.stringify(value) : '';
  useEffect(
    () => () => {
      surface?.publish({ kind: 'none', value: null });
    },
    [surface, kind],
  );
  useEffect(() => {
    if (surface) surface.publish({ kind, value: JSON.parse(serialized) as unknown });
  }, [surface, kind, serialized]);
}
