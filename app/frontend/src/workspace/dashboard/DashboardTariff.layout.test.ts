import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Срок тарифа в ленте обзора не должен вылезать за экран.
 *
 * С #99 в ленте стоит «Оплачен до <дата> / осталось N дней» вместо цены. Дата —
 * одно неразрывное слово, а сам блок на узких ширинах сжимается
 * (`flex: 1` + `min-width: 0` в медиазапросе): тестировщик поймал на 320–414 px
 * горизонтальную прокрутку страницы (на 375 — `scrollWidth` 402 при `clientWidth`
 * 375), потому что содержимое блока шириной ~96 px рисовалось за его краем.
 *
 * jsdom не считает CSS и геометрию, поэтому тест читает модуль стилей и тело
 * правил — сами ширины проверяет слой приёмки (Playwright). Образец —
 * `components/SiteHeader.layout.test.ts` и `pages/Pricing.layout.test.ts`.
 */
const SRC = resolve(process.cwd(), 'src');
const CSS = readFileSync(join(SRC, 'workspace', 'dashboard', 'DashboardTariff.module.css'), 'utf8');
const TSX = readFileSync(join(SRC, 'workspace', 'dashboard', 'DashboardTariff.tsx'), 'utf8');

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(re)][0]?.[1] ?? '';
}

describe('срок тарифа в ленте обзора: переносится, а не вылезает за карточку', () => {
  it('разрешает перенос внутри блока срока', () => {
    // Правило одно на оба ребёнка: `strong` с датой и `span` с остатком дней.
    const body = ruleBody(CSS, '.term > strong,\n.term > span');
    expect(body).toContain('min-width: 0');
    expect(body).toContain('overflow-wrap: anywhere');
  });

  it('уводит срок отдельной строкой на всю ширину ленты на узких экранах', () => {
    // В медиазапросе `max-width: 1100px` лента переносится, и сроку рядом с
    // кнопкой остаётся 19–58 px — этого не хватало ни дате, ни цене.
    const body = ruleBody(CSS, '.ribbon .term');
    expect(body).toContain('flex: 1 1 100%');
    expect(body).toContain('min-width: 0');
  });

  it('держит срок в ленте панелью со своей строкой, а не отдельным блоком страницы', () => {
    // Порядок в разметке — подсказка тем, кто будет править ленту: срок стоит
    // между текстом и кнопкой, поэтому перенос делается его правилом.
    expect(TSX).toContain('data-testid="dashboard-tariff-ends"');
    expect(TSX).toContain('styles.term');
  });
});
