import { createContext, useContext } from 'react';

import type { Operator } from '../api/client';

/**
 * Логин оператора, под которым открыт кабинет.
 *
 * Сервер отдаёт только его, других данных у кабинета нет. Значение кладёт
 * `RequireOperator` после `GET /api/auth/me`, читают экраны под ним (шапка
 * «Выйти» показывает логин рядом с кнопкой).
 */
export const OperatorContext = createContext<Operator | null>(null);

export function useOperator(): Operator {
  const operator = useContext(OperatorContext);
  if (operator === null) {
    throw new Error('useOperator вызван вне RequireOperator');
  }
  return operator;
}
