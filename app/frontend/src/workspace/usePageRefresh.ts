import { useEffect, useState } from 'react';

/** Период фонового обновления ревизии страницы и рамки поверхности. */
export const FRAME_REFRESH_MS = 60_000;

export type PageRefreshOptions = {
  /**
   * Обновляться по таймеру, а не только по действию. По умолчанию включено:
   * остальные экраны (дашборд, статистика, история, готовность отчёта) ждут тика.
   * Персонал выключает его и тикает отдельной ревизией рамки (#251).
   */
  timer?: boolean;
};

/**
 * Обновление по действию: возврат на вкладку и фокус окна, плюс таймер по умолчанию.
 *
 * Персонал отключает таймер (`{ timer: false }`): раньше эта же ревизия каждую минуту
 * перезапрашивала страницу сотрудников вместе с рамкой, и открытая вкладка без действий
 * стоила полной сборки карточек — шесть запросов там, где клиент сделал три. У него
 * тикает только `useFrameRefresh`.
 */
export function usePageRefresh({ timer = true }: PageRefreshOptions = {}): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = timer ? window.setInterval(refresh, FRAME_REFRESH_MS) : undefined;
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [timer]);
  return revision;
}

/**
 * Обновление поверхности по таймеру — только рамка, без карточек списка (#251).
 *
 * Рамка запрашивается как `GET /api/personnel?employees=none`: в ней общежития,
 * настройки, сводка `counts` и превью блоков, но нет массива сотрудников. Страница
 * сотрудников и её счётчики на этот тик не перезапрашиваются — они обновляются по
 * фокусу и после сохранений.
 */
export function useFrameRefresh(intervalMs = FRAME_REFRESH_MS): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return revision;
}
