import type { NavigateFunction } from 'react-router-dom';

/**
 * Пробный период как отдельный повод для перехода: модуль общий для
 * `client.ts` (замечает 403 с рабочей ручки) и оболочки кабинета (закрывает
 * разделы). Ни один из них не знает про разметку экрана.
 */

/** Обзор — единственный раздел, который остаётся рабочим у закрытого кабинета. */
export const CABINET_ROUTE = '/cabinet';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Рабочий запрос ответил 403 «пробный период закончился». Разделы закрываются
 * и пользователь возвращается на обзор — там его ждёт ссылка на тарифы.
 */
export function notifyTrialExpired(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Подписка на такой 403. Возвращает функцию отписки. */
export function subscribeToTrialExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Вернуть пользователя на обзор, не оставляя закрытый адрес в истории. */
export function openCabinet(navigate: NavigateFunction): void {
  navigate(CABINET_ROUTE, { replace: true });
}
