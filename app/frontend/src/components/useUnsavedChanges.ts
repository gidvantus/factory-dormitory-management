import { createContext, useCallback, useContext, useEffect, useId } from 'react';

export const DISCARD_MESSAGE = 'Есть несохранённые изменения. Уйти без сохранения?';
export const ChangesContext = createContext<
  ((id: string, active: boolean, ignoreSearch?: boolean) => void) | null
>(null);

export function useUnloadWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/** Защищает переходы и перезагрузку; возвращает проверку явного закрытия формы. */
export function useUnsavedChanges(
  dirty: boolean,
  options?: { ignoreSearch?: boolean },
): () => boolean {
  const register = useContext(ChangesContext);
  const id = useId();
  useEffect(() => {
    if (!dirty) return;
    if (options?.ignoreSearch) register?.(id, true, true);
    else register?.(id, true);
    return () => register?.(id, false);
  }, [register, id, dirty, options?.ignoreSearch]);
  useUnloadWarning(dirty && !register);
  return useCallback(() => !dirty || window.confirm(DISCARD_MESSAGE), [dirty]);
}
