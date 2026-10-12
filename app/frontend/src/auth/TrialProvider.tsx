import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../api/client';
import type { TrialState } from '../api/client';
import { subscribeToTrialExpired } from './trial';

export interface TrialValue {
  /** `null` — состояние ещё не известно: разделы ведут себя как рабочие. */
  state: TrialState | null;
  /** Кабинет закрыт: рабочие разделы недоступны, открыты обзор, тариф и аккаунт. */
  locked: boolean;
}

/**
 * Состояние до сбоя загрузки: кабинет закрыт, но подробностей об остатке дней
 * нет. Нужно как замена, если 403 про пробный период пришёл раньше, чем
 * успел ответить `GET /api/trial`.
 */
const LOCKED_FALLBACK: TrialState = {
  ends_at: null,
  days_left: 0,
  is_active: false,
  locked: true,
  member_limit: 0,
};

const TrialContext = createContext<TrialValue>({ state: null, locked: false });

/**
 * Пробный период нужен трём экранам сразу: оболочке (какие пункты меню
 * закрыты), обзору (сообщение об окончании) и сотрудникам (лимит). Состояние
 * читается один раз здесь, а не в каждом экране: у закрытого кабинета рабочие
 * ручки отвечают 403, и лишние запросы только шумят.
 */
export function TrialProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<TrialState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .trial(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState(value);
      })
      .catch(() => {
        // Сбой загрузки сам по себе не закрывает кабинет: пока состояние не
        // известно, разделы работают как раньше. 403 про неактивированный
        // кабинет уводит на активацию отдельный обработчик в `client.ts`.
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(
    // 403 «пробный период закончился» с рабочей ручки: закрываем разделы сразу
    // и перечитываем состояние, чтобы остаток дней не остался прошлым.
    () =>
      subscribeToTrialExpired(() => {
        setState((current) => ({
          ...(current ?? LOCKED_FALLBACK),
          days_left: 0,
          is_active: false,
          locked: true,
        }));
        setAttempt((value) => value + 1);
      }),
    [],
  );

  const value = useMemo<TrialValue>(() => ({ state, locked: state?.locked ?? false }), [state]);

  return <TrialContext.Provider value={value}>{children}</TrialContext.Provider>;
}

// Провайдер и хук живут в одном модуле: это одна публичная точка входа слоя.
// eslint-disable-next-line react-refresh/only-export-components
export function useTrial(): TrialValue {
  return useContext(TrialContext);
}
