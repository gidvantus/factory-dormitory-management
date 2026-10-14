import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../api/client';
import type { Solution } from '../api/client';

export interface SolutionsValue {
  /** Состояние загрузки каталога решений. */
  status: 'loading' | 'ready' | 'error';
  /** Видимые строки каталога: пустой список и при загрузке, и при ошибке. */
  items: Solution[];
  /** Коды решений с действующим правом организации: по ним включаются разделы. */
  ownedCodes: Set<string>;
  /** Перечитать каталог: кнопка «Повторить» и обновление после покупки. */
  reload: () => void;
}

/**
 * Состояние до загрузки: ничего не известно. Пустые списки — не «права нет», а
 * «ещё не знаем»: пункт меню платной функции появится, как только каталог
 * ответит. Ошибиться в другую сторону нельзя — показать раздел, который сервер
 * всё равно закроет 403, хуже, чем показать его на мгновение позже.
 */
const EMPTY: SolutionsValue = {
  status: 'loading',
  items: [],
  ownedCodes: new Set<string>(),
  reload: () => undefined,
};

const SolutionsContext = createContext<SolutionsValue>(EMPTY);

/**
 * Права организации на решения магазина нужны оболочке кабинета (какие пункты
 * меню показывать) и экранам магазина и уведомлений. Состояние читается один раз
 * здесь, а не в каждом экране: у закрытого пробного кабинета каталог отвечает
 * 404, и лишние запросы только шумят.
 *
 * Провайдер **не бросает исключение наружу**: неизвестный адрес `/api/solutions`
 * (например, в тестах другого экрана, который его не мокает) обязан остаться
 * просто `status = 'error'`, иначе упал бы весь кабинет. По той же причине
 * наружу не уходит и ошибка сети.
 */
export function SolutionsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<SolutionsValue['status']>('loading');
  const [items, setItems] = useState<Solution[]>([]);
  const [ownedCodes, setOwnedCodes] = useState<Set<string>>(() => new Set<string>());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .solutions(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        // Ответ без `items` не должен ронять оболочку: сервер обещает список, но
        // разметка экрана важнее доверия к одному полю.
        const list = Array.isArray(value?.items) ? value.items : [];
        setItems(list);
        setOwnedCodes(new Set(list.filter((item) => item.is_owned).map((item) => item.code)));
        setStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setItems([]);
        setOwnedCodes(new Set<string>());
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  const value = useMemo<SolutionsValue>(
    () => ({ status, items, ownedCodes, reload }),
    [status, items, ownedCodes, reload],
  );

  return <SolutionsContext.Provider value={value}>{children}</SolutionsContext.Provider>;
}

// Провайдер и хук живут в одном модуле: это одна публичная точка входа слоя.
// eslint-disable-next-line react-refresh/only-export-components
export function useSolutions(): SolutionsValue {
  return useContext(SolutionsContext);
}
