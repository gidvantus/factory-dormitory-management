import { request } from './client';
import type { DemoState, PersonnelTab } from '../pages/personnel-tab-builder/model';
import type {
  CalculationSource,
  CellResult,
} from '../pages/personnel-tab-builder/calculationTypes';

export type BuilderDocument = { revision: number; state: DemoState };
export type BuilderCatalog = {
  sources: CalculationSource[];
  templates: (PersonnelTab & { templateLabel: string })[];
};
export type EvaluationRequest = {
  state: DemoState;
  tabId: string;
  rowId?: string;
  columnId?: string;
  day?: string;
  from?: string;
  to?: string;
};
export type EvaluationResult = {
  cell?: CellResult;
  columns?: Record<string, Record<string, CellResult>>;
  days?: Record<string, Record<string, CellResult>>;
};
export function serverState(state: DemoState): DemoState {
  return { ...state, tabs: state.tabs.filter((tab) => !tab.builtin) };
}
export const personnelBuilderApi = {
  read: (signal?: AbortSignal) => request<BuilderDocument>('/personnel/builder', { signal }),
  save: (document: BuilderDocument) =>
    request<BuilderDocument>('/personnel/builder', {
      method: 'PUT',
      body: JSON.stringify({ ...document, state: serverState(document.state) }),
    }),
  sources: (signal?: AbortSignal) =>
    request<BuilderCatalog>('/personnel/builder/sources', { signal }),
  evaluate: (payload: EvaluationRequest, signal?: AbortSignal) =>
    request<EvaluationResult>('/personnel/builder/evaluate', {
      method: 'POST',
      body: JSON.stringify({ ...payload, state: serverState(payload.state) }),
      signal,
    }),
};
