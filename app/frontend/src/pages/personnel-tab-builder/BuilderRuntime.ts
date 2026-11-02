import type { Dispatch, SetStateAction } from 'react';
import type { PersonnelData } from '../../api/personnel';
import type { DemoState } from './model';

export type BuilderRuntime = {
  state: DemoState;
  setState: Dispatch<SetStateAction<DemoState>>;
  data: PersonnelData | null;
  ready: boolean;
  loadData: () => Promise<void>;
  onNativeData: (data: PersonnelData) => void;
};
