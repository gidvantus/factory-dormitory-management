import { createContext } from 'react';
import type {
  BuilderCatalog,
  EvaluationRequest,
  EvaluationResult,
} from '../../api/personnelBuilder';

export type BuilderEnvironment = {
  registerDraft?: (id: string, active: boolean) => void;
  sources: BuilderCatalog['sources'];
  templates: BuilderCatalog['templates'];
  evaluate: (payload: EvaluationRequest, signal?: AbortSignal) => Promise<EvaluationResult>;
};
export const BuilderEnvironmentContext = createContext<BuilderEnvironment | null>(null);
