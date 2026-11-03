import { useContext } from 'react';
import { EditorSurfaceContext } from './EditorSurface';

export function useOrganizedEditor(): boolean {
  return useContext(EditorSurfaceContext)?.organized ?? false;
}
