import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Счётчик Метрики проверяется на уровне модуля: jsdom не исполняет внешний
 * скрипт, поэтому доказывается то, что код действительно может гарантировать —
 * наличие ровно одного `<script>` и вызовы `ym` с нужными аргументами.
 * Реальные запросы к `mc.yandex.ru` и хиты в отчёте — слой приёмки на стенде.
 */
const COUNTER_SRC = 'https://mc.yandex.ru/metrika/tag.js?id=114310629';
const CONSENT_COOKIE = 'domovoy_cookie_consent';

function metrikaScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script[src*="mc.yandex.ru"]')];
}

function clearMetrika(): void {
  for (const script of metrikaScripts()) {
    script.remove();
  }
  delete window.ym;
}

/**
 * Свежий модуль на каждый тест: флаг «счётчик уже запущен» живёт в модуле,
 * и без перезагрузки модуля второй тест получил бы состояние первого.
 */
async function loadMetrika(): Promise<typeof import('./metrika')> {
  vi.resetModules();
  return import('./metrika');
}

beforeEach(() => {
  clearMetrika();
});

afterEach(() => {
  clearMetrika();
  // Тест с секретным адресом двигает `window.location`; вернуть его на место,
  // иначе следующий тест соберёт `hit` от чужого пути.
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('счётчик Метрики грузится только после согласия', () => {
  it('без согласия ничего не вставляет и не трогает window.ym', async () => {
    const metrika = await loadMetrika();

    expect(metrika.startMetrika()).toBe(false);
    expect(metrika.isMetrikaStarted()).toBe(false);
    expect(metrikaScripts()).toHaveLength(0);
    expect(document.head.querySelector(`script[src="${COUNTER_SRC}"]`)).toBeNull();
    expect(window.ym).toBeUndefined();
  });

  it('согласие версии v1 согласием не считается', async () => {
    document.cookie = `${CONSENT_COOKIE}=v1; path=/`;
    const metrika = await loadMetrika();

    expect(metrika.startMetrika()).toBe(false);
    expect(metrika.isMetrikaStarted()).toBe(false);
    expect(metrikaScripts()).toHaveLength(0);
  });

  it('после согласия вставляет ровно один script и вызывает init', async () => {
    document.cookie = `${CONSENT_COOKIE}=v2; path=/`;
    const metrika = await loadMetrika();

    expect(metrika.startMetrika()).toBe(true);
    expect(metrika.isMetrikaStarted()).toBe(true);

    const scripts = metrikaScripts();
    expect(scripts).toHaveLength(1);
    const [script] = scripts;
    expect(script?.getAttribute('src')).toBe(COUNTER_SRC);
    expect(script?.async).toBe(true);
    expect(script?.parentElement).toBe(document.head);
    // `<noscript><img src="…/watch/…">` из сниппета не добавляется: картинка
    // грузилась бы без согласия и гейтом не закрывается.
    expect(document.querySelector('img[src*="mc.yandex.ru"]')).toBeNull();

    const queue = window.ym?.a ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.[0]).toBe(metrika.METRIKA_COUNTER_ID);
    expect(queue[0]?.[1]).toBe('init');
    expect(queue[0]?.[2]).toMatchObject({
      ssr: true,
      clickmap: true,
      ecommerce: 'dataLayer',
      accurateTrackBounce: true,
      trackLinks: true,
    });
  });

  it('повторный вызов не вставляет второй script и не повторяет init', async () => {
    document.cookie = `${CONSENT_COOKIE}=v2; path=/`;
    const metrika = await loadMetrika();

    expect(metrika.startMetrika()).toBe(true);
    // Двойной эффект `StrictMode` и повторный рендер дают именно этот вызов.
    expect(metrika.startMetrika()).toBe(false);
    expect(metrika.startMetrika()).toBe(false);

    expect(metrikaScripts()).toHaveLength(1);
    const initCalls = (window.ym?.a ?? []).filter((call) => call[1] === 'init');
    expect(initCalls).toHaveLength(1);
  });
});

describe('просмотры страниц отправляются только запущенным счётчиком', () => {
  it('до согласия trackPageView молчит', async () => {
    const metrika = await loadMetrika();

    metrika.trackPageView('/pricing');

    expect(window.ym).toBeUndefined();
    expect(metrikaScripts()).toHaveLength(0);
  });

  it('после запуска шлёт hit с абсолютным адресом страницы', async () => {
    document.cookie = `${CONSENT_COOKIE}=v2; path=/`;
    const metrika = await loadMetrika();
    metrika.startMetrika();

    metrika.trackPageView('/pricing?tab=year');

    const queue = window.ym?.a ?? [];
    expect(queue.at(-1)).toEqual([
      metrika.METRIKA_COUNTER_ID,
      'hit',
      `${window.location.origin}/pricing?tab=year`,
    ]);
  });

  it('вырезает одноразовые секреты активации и входа из адреса просмотра', async () => {
    document.cookie = `${CONSENT_COOKIE}=v2; path=/`;
    const metrika = await loadMetrika();
    metrika.startMetrika();

    // `/activate/<token>` задаёт пароль аккаунта, `/su/<token>` — готовая
    // ссылка входа под пользователем; ни то, ни другое в отчёт попасть не должно.
    metrika.trackPageView('/activate/secret-token-activate');
    metrika.trackPageView('/su/secret-token-login?next=%2Fcabinet');
    metrika.trackPageView('/pricing?tab=year');

    const hits = (window.ym?.a ?? []).filter((call) => call[1] === 'hit').map((call) => call[2]);
    expect(hits).toEqual([
      `${window.location.origin}/activate/***`,
      `${window.location.origin}/su/***?next=%2Fcabinet`,
      `${window.location.origin}/pricing?tab=year`,
    ]);
    expect(JSON.stringify(hits)).not.toContain('secret-token');
  });

  it('не отправляет адрес со секретом и в init через url', async () => {
    window.history.pushState({}, '', '/activate/secret-token-activate');
    document.cookie = `${CONSENT_COOKIE}=v2; path=/`;
    const metrika = await loadMetrika();

    expect(metrika.startMetrika()).toBe(true);

    const [init] = (window.ym?.a ?? []).filter((call) => call[1] === 'init');
    expect((init?.[2] as { url?: string } | undefined)?.url).toBe(
      `${window.location.origin}/activate/***`,
    );
  });

  it('повторный просмотр того же адреса не шлёт второй hit', async () => {
    document.cookie = `${CONSENT_COOKIE}=v2; path=/`;
    const metrika = await loadMetrika();
    metrika.startMetrika();

    // Двойной эффект `StrictMode` в dev-сборке вызывает просмотр дважды.
    metrika.trackPageView('/pricing');
    metrika.trackPageView('/pricing');
    metrika.trackPageView('/pricing?tab=year');

    const hits = (window.ym?.a ?? []).filter((call) => call[1] === 'hit').map((call) => call[2]);
    expect(hits).toEqual([
      `${window.location.origin}/pricing`,
      `${window.location.origin}/pricing?tab=year`,
    ]);
  });
});
