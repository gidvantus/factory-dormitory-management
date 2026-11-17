/**
 * Счётчик Яндекс.Метрики, загружаемый только после согласия на cookie.
 *
 * Согласие проверяется здесь, а не в компоненте: точка входа у счётчика одна,
 * и никакой другой код не должен уметь его запустить в обход `isConsentGiven()`.
 * Пока плашку не приняли, в документе нет ни `<script>` Метрики, ни запросов
 * к `mc.yandex.ru` — ни при первом визите, ни после перезагрузки со старым
 * значением cookie (`v1` согласием не считается).
 *
 * Состояние запуска — флаг модуля, а не компонента: React `StrictMode` в
 * `main.tsx` дважды вызывает эффекты на монтировании, и флаг компонента не
 * пережил бы двойного вызова — в `<head>` оказались бы два `<script>`.
 */

import { isConsentGiven } from '../consent/storage';

/** Номер счётчика — константа: через env и ARG он намеренно не настраивается. */
export const METRIKA_COUNTER_ID = 114310629;

const TAG_URL = `https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_COUNTER_ID}`;

/** Очередь вызовов до загрузки `tag.js`; после загрузки её разбирает сам счётчик. */
type MetrikaQueue = unknown[][];

/** `ym` до загрузки `tag.js` — функция-заглушка, копящая вызовы в `ym.a`. */
export interface MetrikaFunction {
  (...args: unknown[]): void;
  a?: MetrikaQueue;
}

declare global {
  interface Window {
    ym?: MetrikaFunction;
  }
}

/** Запущен ли счётчик в этом документе. Переживает повторные рендеры и эффекты. */
let started = false;

/**
 * Заглушка `ym`. Без неё вызов `ym(…, 'init', …)` в браузере, где `tag.js`
 * ещё не догрузился, падает: сам счётчик заменяет заглушку на настоящую
 * функцию и разбирает накопленную очередь `ym.a`.
 */
function ensureYmStub(): MetrikaFunction {
  const existing = window.ym;
  if (typeof existing === 'function') {
    return existing;
  }
  const ym: MetrikaFunction = (...args: unknown[]): void => {
    (ym.a = ym.a ?? []).push(args);
  };
  window.ym = ym;
  return ym;
}

/**
 * Запускает счётчик, если согласие дано. Возвращает `true` только тому вызову,
 * который действительно вставил скрипт: повторный вызов в том же документе
 * ничего не делает и возвращает `false`.
 *
 * `<noscript><img src="https://mc.yandex.ru/watch/…"></noscript>` из сниппета
 * Метрики сознательно не добавляется: картинка грузилась бы без согласия и
 * гейтом не закрывается.
 */
export function startMetrika(): boolean {
  if (!isConsentGiven()) {
    return false;
  }
  if (started) {
    return false;
  }
  started = true;

  const ym = ensureYmStub();
  const script = document.createElement('script');
  script.async = true;
  script.src = TAG_URL;
  document.head.appendChild(script);

  /*
   * `ssr: true` — просмотры отправляются вручную (`trackPageView`), сам счётчик
   * первый `hit` не шлёт: иначе на каждой навигации их было бы два.
   */
  ym(METRIKA_COUNTER_ID, 'init', {
    ssr: true,
    clickmap: true,
    ecommerce: 'dataLayer',
    referrer: document.referrer,
    url: window.location.href,
    accurateTrackBounce: true,
    trackLinks: true,
  });
  return true;
}

/**
 * Отправляет просмотр страницы. До согласия (и до запуска счётчика) молчит:
 * вызывающая сторона не обязана знать про согласие.
 */
export function trackPageView(path: string): void {
  if (!started) {
    return;
  }
  const ym = window.ym;
  if (typeof ym !== 'function') {
    return;
  }
  ym(METRIKA_COUNTER_ID, 'hit', window.location.origin + path);
}

/** Запущен ли счётчик — нужно тестам, чтобы различать «не начали» и «уже был». */
export function isMetrikaStarted(): boolean {
  return started;
}
