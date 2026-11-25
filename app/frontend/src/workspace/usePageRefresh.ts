import { useEffect, useState } from 'react';

/** Период фонового обновления рамки поверхности. */
export const FRAME_REFRESH_MS = 60_000;

/**
 * Обновление по действию: возврат на вкладку и фокус окна.
 *
 * Таймера здесь больше нет (#251): раньше эта же ревизия каждую минуту
 * перезапрашивала страницу сотрудников вместе с рамкой, и открытая вкладка без
 * действий стоила полной сборки карточек — шесть запросов там, где клиент сделал три.
 */
export function usePageRefresh(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
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
