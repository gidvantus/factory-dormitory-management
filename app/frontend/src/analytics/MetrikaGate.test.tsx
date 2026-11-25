import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { METRIKA_COUNTER_ID } from './metrika';
import { anonymousSession, mockFetch } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

/**
 * Сквозная проверка гейта на настоящем `App`: включение счётчика по «Принять»
 * и ручной просмотр страницы на смене адреса.
 *
 * Один тест на сценарий, а не по тесту на шаг: флаг «счётчик запущен» живёт
 * в модуле и переживает `cleanup()`, поэтому второй тест в этом файле начинался
 * бы с уже запущенным счётчиком. Юнит-уровень (запуск, идемпотентность,
 * `trackPageView` до согласия) закрыт в `metrika.test.ts`.
 */
const COUNTER_SRC = 'https://mc.yandex.ru/metrika/tag.js?id=114310629';

function metrikaScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script[src*="mc.yandex.ru"]')];
}

function ymCalls(): unknown[][] {
  return window.ym?.a ?? [];
}

afterEach(() => {
  for (const script of metrikaScripts()) {
    script.remove();
  }
  delete window.ym;
  vi.unstubAllGlobals();
});

describe('счётчик Метрики на страницах приложения', () => {
  it('включается после «Принять» и шлёт hit на смене маршрута', async () => {
    mockFetch(() => anonymousSession());
    const user = userEvent.setup();
    renderApp('/');

    // 1. Согласия нет: плашка видна, Метрики в документе нет вовсе.
    expect(await screen.findByTestId('cookie-consent')).toBeInTheDocument();
    expect(await screen.findByTestId('landing')).toBeInTheDocument();
    expect(metrikaScripts()).toHaveLength(0);
    expect(window.ym).toBeUndefined();

    // 2. «Принять»: счётчик поднимается по событию согласия, без перезагрузки.
    await user.click(screen.getByTestId('cookie-consent-accept'));
    expect(screen.queryByTestId('cookie-consent')).not.toBeInTheDocument();
    expect(document.cookie).toContain('domovoy_cookie_consent=v2');

    await waitFor(() => expect(metrikaScripts()).toHaveLength(1));
    expect(metrikaScripts()[0]?.getAttribute('src')).toBe(COUNTER_SRC);
    expect(ymCalls().map((call) => call[1])).toEqual(['init', 'hit']);
    expect(ymCalls()[0]?.[0]).toBe(METRIKA_COUNTER_ID);
    expect(ymCalls()[1]).toEqual([METRIKA_COUNTER_ID, 'hit', `${window.location.origin}/`]);

    // 3. Смена адреса: просмотр уходит вручную, потому что `ssr: true`.
    //    Ссылка есть дважды — в шапке и в подвале; годится любая.
    const [pricingLink] = screen.getAllByRole('link', { name: 'Тарифы' });
    expect(pricingLink).toBeDefined();
    await user.click(pricingLink as HTMLElement);

    await waitFor(() => {
      expect(ymCalls().at(-1)).toEqual([
        METRIKA_COUNTER_ID,
        'hit',
        `${window.location.origin}/pricing`,
      ]);
    });
    // Переход внутри приложения не вставляет второй скрипт.
    expect(metrikaScripts()).toHaveLength(1);
    expect(ymCalls().filter((call) => call[1] === 'init')).toHaveLength(1);
  });
});
