import { useContext, useEffect, useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import type { EvaluationRequest, EvaluationResult } from '../../api/personnelBuilder';
import { serverState } from '../../api/personnelBuilder';
import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { createCalculationEngine, isComputed } from './calculations';
import type { CellResult, EvaluationContext } from './calculationTypes';
import type { DemoState, PersonnelTab, RecordRow } from './model';

const stateOf = (tabs: PersonnelTab[]): DemoState => ({
  version: 3,
  tabs,
  defaultTab: 'workspace',
});
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось выполнить расчёт';

export function useCalculationEngine(
  tab: PersonnelTab,
  tabs: PersonnelTab[],
  data: PersonnelData,
  context: EvaluationContext,
) {
  const env = useContext(BuilderEnvironmentContext);
  const [loaded, setLoaded] = useState<{
    key: string;
    data: PersonnelData;
    environment: typeof env;
    result: EvaluationResult;
    error?: string;
  } | null>(null);
  const serialized = JSON.stringify(serverState(stateOf(tabs)));
  const from = context.range?.from,
    to = context.range?.to;
  const key = JSON.stringify([serialized, tab.id, from, to]);
  const needsCalculation =
    tab.columns.some((column) => !column.archived && isComputed(column.rule)) ||
    (tab.tableOptions.table_format === 'calendar' && tab.rows.some((row) => isComputed(row.rule)));
  useEffect(() => {
    if (!env || !needsCalculation) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void env
        .evaluate(
          {
            state: JSON.parse(serialized) as DemoState,
            tabId: tab.id,
            ...(from && to ? { from, to } : {}),
          },
          controller.signal,
        )
        .then((result) => {
          if (!controller.signal.aborted) setLoaded({ key, data, environment: env, result });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setLoaded({ key, data, environment: env, result: {}, error: errorText(error) });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [env, serialized, tab.id, from, to, key, data, needsCalculation]);
  if (!env) return createCalculationEngine(tabs, data, context);
  const result = (axis: 'columns' | 'days', row: RecordRow, id: string): CellResult =>
    loaded?.key !== key || loaded.data !== data || loaded.environment !== env
      ? { value: null, pending: true }
      : loaded.error
        ? { value: null, error: loaded.error }
        : (loaded.result[axis]?.[row.id]?.[id] ?? {
            value: null,
            error: 'Результат расчёта не получен',
          });
  return {
    column: (_tab: PersonnelTab, row: RecordRow, id: string): CellResult =>
      isComputed(tab.columns.find((column) => column.id === id)?.rule)
        ? result('columns', row, id)
        : { value: row.values[id] ?? '' },
    day: (_tab: PersonnelTab, row: RecordRow, day: string): CellResult =>
      isComputed(row.rule) ? result('days', row, day) : { value: row.dayValues?.[day] ?? '' },
  };
}

export function useCalculationPreview() {
  const env = useContext(BuilderEnvironmentContext);
  return (
    tabs: PersonnelTab[],
    data: PersonnelData,
    target: { tabId: string; rowId: string; columnId?: string; day?: string },
    context: EvaluationContext = {},
  ): CellResult | Promise<CellResult> => {
    if (env) {
      const request: EvaluationRequest = {
        state: stateOf(tabs),
        ...target,
        ...(context.range ? { from: context.range.from, to: context.range.to } : {}),
      };
      return env
        .evaluate(request)
        .then((result) => result.cell ?? { value: null, error: 'Результат расчёта не получен' })
        .catch((error) => ({ value: null, error: errorText(error) }));
    }
    const tab = tabs.find((tab) => tab.id === target.tabId)!;
    const row = tab.rows.find((row) => row.id === target.rowId)!;
    const engine = createCalculationEngine(tabs, data, context);
    return target.columnId
      ? engine.column(tab, row, target.columnId)
      : engine.day(tab, row, target.day ?? data.today);
  };
}
