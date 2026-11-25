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

/** Последний отправленный просмотр: глушит двойной `hit` из `StrictMode` в dev. */
let lastTrackedPath: string | null = null;

/**
 * Одноразовые секреты живут прямо в адресе страницы: `/activate/<token>` — по
 * нему задают пароль аккаунта, `/su/<token>` — готовая ссылка входа под чужим
 * пользователем. В Метрику такие адреса уходить не должны: у отчёта есть
 * читатели, а попавший туда токен уже не отозвать. Поэтому сегмент после
 * `/activate` или `/su` заменяется на `***` — и в `hit`, и в `url` из `init`,
 * иначе полный адрес уходит вторым каналом.
 */
const SECRET_PATH = /^\/(activate|su)\/[^/?#]*/;

/** Адрес страницы без одноразовых секретов: `/activate/<token>` → `/activate/***`. */
function safePath(path: string): string {
  return path.replace(SECRET_PATH, '/$1/***');
}

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
   *
   * `url` — второй канал того же адреса, поэтому он собирается тем же
   * `safePath`: иначе токен активации утёк бы в обход `hit`.
   */
  const initialPath = window.location.pathname + window.location.search;
  ym(METRIKA_COUNTER_ID, 'init', {
    ssr: true,
    clickmap: true,
    ecommerce: 'dataLayer',
    referrer: document.referrer,
    url: window.location.origin + safePath(initialPath),
    accurateTrackBounce: true,
    trackLinks: true,
  });
  return true;
}

/**
 * Отправляет просмотр страницы. До согласия (и до запуска счётчика) молчит:
 * вызывающая сторона не обязана знать про согласие. Из адреса вырезаются
 * одноразовые секреты (`/activate/<token>`, `/su/<token>`), а повторный вызов
 * с тем же адресом не шлёт второй `hit` — так двойной эффект `StrictMode`
 * в dev-сборке не портит отчёт.
 */
export function trackPageView(path: string): void {
  if (!started) {
    return;
  }
  const safe = safePath(path);
  if (safe === lastTrackedPath) {
    return;
  }
  const ym = window.ym;
  if (typeof ym !== 'function') {
    return;
  }
  lastTrackedPath = safe;
  ym(METRIKA_COUNTER_ID, 'hit', window.location.origin + safe);
}

/** Запущен ли счётчик — нужно тестам, чтобы различать «не начали» и «уже был». */
export function isMetrikaStarted(): boolean {
  return started;
}
