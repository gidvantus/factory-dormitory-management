import { createContext, useContext } from 'react';

export interface SettingsNavigation {
  open: (key?: string, page?: 'structure' | 'links' | 'templates') => void;
  revision: number;
  readOnly: boolean;
}
export const SettingsContext = createContext<SettingsNavigation | null>(null);
export const useSettingsNavigation = (): SettingsNavigation | null => useContext(SettingsContext);
