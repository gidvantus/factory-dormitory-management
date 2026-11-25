import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { CONSENT_CHANGED_EVENT } from '../consent/storage';
import { startMetrika, trackPageView } from './metrika';

/**
 * Гейт счётчика Метрики: компонент без разметки, `return null`.
 *
 * Он ничего не решает про согласие сам — только пересказывает модулю
 * `metrika` два повода запуститься (монтирование и событие согласия) и один
 * повод отправить просмотр (смена адреса). Само решение «можно ли грузить
 * счётчик» принимает `startMetrika()` по cookie, поэтому гейт стоит рядом с
 * маршрутами, а не внутри отдельного экрана.
 *
 * Эффект монтирования намеренно с пустыми зависимостями: `startMetrika()`
 * идемпотентен (флаг в модуле), поэтому двойной вызов из `StrictMode` даёт
 * один `<script>`, а не два.
 */
export function MetrikaGate(): null {
  const { pathname, search } = useLocation();

  // Перезагрузка с уже принятым согласием: счётчик поднимается на монтировании.
  useEffect(() => {
    startMetrika();
  }, []);

  /*
   * «Принять» на текущей странице. Счётчик включается по событию плашки, а не
   * по знанию плашки о Метрике: `consent/storage.ts` про аналитику ничего не
   * знает и знать не должен.
   *
   * Просмотр страницы, на которой нажали «Принять», отправляется здесь же:
   * до согласия `trackPageView` молчал, а эффект смены адреса не повторится —
   * без этого вызова первый визит после согласия в отчёт не попал бы. `hit`
   * шлётся только когда `startMetrika()` действительно запустил счётчик,
   * поэтому повторное событие согласия дубля не даст.
   */
  useEffect(() => {
    const handleConsentChanged = (): void => {
      if (startMetrika()) {
        trackPageView(pathname + search);
      }
    };
    document.addEventListener(CONSENT_CHANGED_EVENT, handleConsentChanged);
    return () => {
      document.removeEventListener(CONSENT_CHANGED_EVENT, handleConsentChanged);
    };
  }, [pathname, search]);

  // Смена адреса: `ssr: true` отключил автоматический просмотр, шлём руками.
  useEffect(() => {
    trackPageView(pathname + search);
  }, [pathname, search]);

  return null;
}
