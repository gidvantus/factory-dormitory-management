import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Карточка тарифа в панели не должна создавать горизонтальную прокрутку.
 *
 * Название тарифа («Годовой без ограничения срока») и дата «02.12.2026» — одно
 * неразрывное слово каждое, а карточка живёт в панели шириной 212 px, на 1100 px
 * — 196 px. Ровно на этом ловили прокрутку в ленте обзора до #124 (тест #99,
 * `DashboardTariff.layout.test.ts`): содержимое шириной ~96 px рисовалось за
 * краем блока. Защита переехала сюда вместе с карточкой.
 *
 * jsdom не считает CSS и геометрию, поэтому тест читает модуль стилей и тело
 * правил — сами ширины проверяет слой приёмки (Playwright). Образец —
 * `components/SiteHeader.layout.test.ts` и `pages/Pricing.layout.test.ts`.
 */
const SRC = resolve(process.cwd(), 'src');
const CSS = readFileSync(join(SRC, 'workspace', 'Workspace.module.css'), 'utf8');
const TSX = readFileSync(join(SRC, 'workspace', 'SidebarTariff.tsx'), 'utf8');

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(re)][0]?.[1] ?? '';
}

describe('карточка тарифа в панели: содержимое переносится, а не вылезает за край', () => {
  it('не задаёт карточке своей ширины и разрешает сжатие', () => {
    // Ширину карточке даёт панель (248/220 px). Своя ширина или `flex: none`
    // вернули бы её за край панели на узких ширинах.
    const body = ruleBody(CSS, '.shell .sidebar-tariff');
    expect(body).toContain('min-width: 0');
    expect(body).not.toMatch(/(?:^|\s)width\s*:/);
  });

  it('переносит название тарифа', () => {
    const body = ruleBody(CSS, '.shell .sidebar-tariff-name');
    expect(body).toContain('min-width: 0');
    expect(body).toContain('overflow-wrap: anywhere');
  });

  it('переносит срок: и дату, и остаток дней', () => {
    const date = ruleBody(CSS, '.shell .sidebar-tariff-date');
    expect(date).toContain('min-width: 0');
    expect(date).toContain('overflow-wrap: anywhere');

    const rest = ruleBody(CSS, '.shell .sidebar-tariff-rest');
    expect(rest).toContain('min-width: 0');
    expect(rest).toContain('overflow-wrap: anywhere');

    const term = ruleBody(CSS, '.shell .sidebar-tariff-term');
    expect(term).toContain('min-width: 0');
  });

  it('держит высоту только у загрузки, чтобы панель не прыгала', () => {
    // Остальные состояния живут по содержимому: на 720 px по высоте карточка не
    // должна занимать место у списка разделов зря.
    const loading = ruleBody(CSS, ".shell .sidebar-tariff[data-state='loading']");
    expect(loading).toContain('min-height: 142px');
    expect(ruleBody(CSS, '.shell .sidebar-tariff')).not.toMatch(/(?:^|\s)min-height\s*:/);
  });

  it('показывает срок в карточке, а не где-то ещё: разметка и стили сходятся', () => {
    // Порядок в разметке — подсказка тем, кто будет править карточку: срок стоит
    // между текстом о тарифе и кнопкой, поэтому перенос делается его правилом.
    expect(TSX).toContain('data-testid="sidebar-tariff-ends"');
    expect(TSX).toContain("styles['sidebar-tariff-date']");
  });
});
