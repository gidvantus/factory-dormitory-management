import type { NavigateFunction } from 'react-router-dom';

/**
 * Активация кабинета как отдельный экран: модуль общий для `RequireAuth`
 * (уводит неактивного из кабинета) и `SessionProvider` (реагирует на 403
 * с рабочих ручек). Ни один из них не знает про разметку экрана.
 */

/** Адрес экрана активации: с токеном из письма и без него. */
export const ACTIVATION_ROUTE = '/activate';

/** Текст 403 с рабочих ручек: он же — сигнал «нужна активация». */
export const ACTIVATION_REQUIRED_DETAIL = 'Активируйте личный кабинет';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Рабочий запрос ответил 403 «активируйте личный кабинет». Экран активации
 * важнее, чем «не удалось загрузить» на конкретной странице.
 */
export function notifyActivationRequired(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Подписка на такой 403. Возвращает функцию отписки. */
export function subscribeToActivationRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Увести пользователя на экран активации, не оставляя текущий адрес в истории. */
export function openActivation(navigate: NavigateFunction): void {
  navigate(ACTIVATION_ROUTE, { replace: true });
}
