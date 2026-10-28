import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError } from '../api/client';
import type { OrganizationTariff } from '../api/client';

/** Текст сбоя, когда сервер не сказал ничего внятного. */
const LOAD_ERROR = 'Не удалось загрузить тариф организации';

/** `401` — конец сессии, а не сбой чтения: об этом говорит другая часть кабинета. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status !== 401) return error.message;
  return LOAD_ERROR;
}

export interface SubscriptionValue {
  /** Действующий тариф, его конец и оплаченный вперёд период; `null` — ещё не прочитано. */
  state: OrganizationTariff | null;
  status: 'loading' | 'ready' | 'error';
  /** Текст сбоя чтения: экран показывает его и предлагает повторить. */
  error: string;
  /** Перечитать подписку. */
  reload: () => void;
}

const SubscriptionContext = createContext<SubscriptionValue>({
  state: null,
  status: 'loading',
  error: '',
  reload: () => undefined,
});

/**
 * Подписка организации нужна трём местам кабинета сразу: ленте тарифа
 * (`DashboardTariff`), предупреждению о сроке (`TrialNotice`) и пределу мест на
 * странице сотрудников (`Members`). Читается она один раз здесь, а не в каждом
 * экране: ручка описывает организацию, а не экран, и три одинаковых запроса
 * за одним и тем же ответом — это шум.
 *
 * Срок и дни считает сервер (`app/subscription.py`): здесь нет ни вычитания
 * дней из `ends_at`, ни своей копии правила «за 14 дней предупредить».
 */
export function SubscriptionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<OrganizationTariff | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .currentTariff(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setState(value);
        setError('');
        setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        // Сбой чтения не закрывает кабинет: закрытость решает `TrialProvider`.
        // Пока подписка не известна, экраны показывают своё «не удалось».
        setState(null);
        setError(errorMessage(caught));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const value = useMemo<SubscriptionValue>(
    () => ({ state, status, error, reload }),
    [state, status, error, reload],
  );

  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>;
}

// Провайдер и хук живут в одном модуле: это одна публичная точка входа слоя.
// eslint-disable-next-line react-refresh/only-export-components
export function useSubscription(): SubscriptionValue {
  return useContext(SubscriptionContext);
}
