import { useEffect, useRef, useState } from 'react';
import { personnelApi } from '../../api/personnel';
import type { EmployeeListQuery, EmployeePage, Filter } from '../../api/personnel';
import type { ListCriteria } from './employeeListFilters';
import { message } from './helpers';

/** Размер страницы сотрудников: столько же, сколько запрашивает сервер по умолчанию. */
export const PAGE_SIZE = 20;

/** Условия страницы в том виде, в каком их понимает `GET /api/personnel/employees`. */
export const employeePageQuery = (criteria: ListCriteria, page: number): EmployeeListQuery => ({
  filter: criteria.filter,
  dormitory: criteria.dormitory,
  scope: criteria.scope,
  days: criteria.days,
  query: criteria.query.trim(),
  ...(criteria.column_filters?.length ? { column_filters: criteria.column_filters } : {}),
  page: page + 1,
  per_page: PAGE_SIZE,
});

const criteriaKey = (criteria: ListCriteria): string =>
  JSON.stringify([
    criteria.filter,
    criteria.dormitory,
    criteria.scope,
    criteria.days,
    criteria.query.trim(),
    criteria.column_filters ?? [],
  ]);

export type EmployeeListState = {
  result: EmployeePage | null;
  loading: boolean;
  error: string;
  reload: () => void;
};

/**
 * Страница сотрудников с серверной фильтрацией (#247).
 *
 * `result` относится только к текущим условиям: пока новая страница не пришла,
 * прежние строки не показываются — иначе под новым фильтром мелькал бы старый
 * список. `revision` перезапрашивает страницу по кнопке и при обновлении данных.
 */
export function useEmployeeList(
  criteria: ListCriteria,
  page: number,
  enabled: boolean,
  revision = 0,
): EmployeeListState {
  const key = criteriaKey(criteria);
  const [state, setState] = useState<{ key: string; result: EmployeePage | null }>({
    key: '',
    result: null,
  });
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void personnelApi
      .employees(employeePageQuery(criteria, page), controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({ key, result });
        setLoading(false);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(message(caught));
        setLoading(false);
      });
    return () => controller.abort();
    // Условия приходят одной строкой: так объект criteria не запускает запрос на каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, enabled, revision, attempt]);
  return {
    result: state.key === key ? state.result : null,
    loading,
    error,
    reload: () => setAttempt((value) => value + 1),
  };
}

export type EmployeeCounts = Partial<Record<Filter, number>>;

/**
 * Счётчики списка по тем же условиям (#247).
 *
 * Раньше числа считались по всему массиву карточек в браузере; теперь за каждым
 * числом стоит страница из одной записи — сервер сам отдаёт `total`.
 */
export function useEmployeeCounts(
  criteria: ListCriteria,
  filters: Filter[],
  enabled: boolean,
  revision = 0,
): EmployeeCounts {
  const key = criteriaKey(criteria);
  const wanted = filters.join(',');
  const [counts, setCounts] = useState<EmployeeCounts>({});
  useEffect(() => {
    if (!enabled || !filters.length) return;
    const controller = new AbortController();
    void Promise.all(
      filters.map((filter) =>
        personnelApi
          .employees(employeePageQuery({ ...criteria, filter }, 0), controller.signal)
          .then((page) => [filter, page.total] as const)
          .catch(() => null),
      ),
    ).then((values) => {
      if (controller.signal.aborted) return;
      setCounts(Object.fromEntries(values.filter((value) => value !== null)) as EmployeeCounts);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, enabled, revision]);
  return counts;
}

/**
 * Одно число по произвольным условиям — для диалогов, где пользователь меняет
 * критерии вручную. Запрос идёт с задержкой, чтобы не дёргать сервер на каждый ввод.
 */
export function useEmployeeCount(
  criteria: ListCriteria,
  enabled = true,
  delay = 300,
): number | null {
  const key = criteriaKey(criteria);
  const latest = useRef(criteria);
  latest.current = criteria;
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) {
      setCount(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void personnelApi
        .employees(employeePageQuery(latest.current, 0), controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) setCount(page.total);
        })
        .catch(() => {
          if (!controller.signal.aborted) setCount(null);
        });
    }, delay);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, delay]);
  return count;
}
