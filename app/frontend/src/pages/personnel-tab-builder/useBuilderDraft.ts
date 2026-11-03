import { useContext, useId, useLayoutEffect } from 'react';
import { BuilderEnvironmentContext } from './BuilderEnvironment';

/** Открытый черновик сохраняет версию, с которой началось редактирование. */
export function useBuilderDraft(open: boolean): void {
  const register = useContext(BuilderEnvironmentContext)?.registerDraft;
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !register) return;
    register(id, true);
    return () => register(id, false);
  }, [open, register, id]);
}
