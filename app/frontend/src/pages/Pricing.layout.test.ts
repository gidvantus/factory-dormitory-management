import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Верх публичного прайса: воздух под шапкой сайта считался общим шагом секции
 * (`--section-y`, 56–112px) и вырастал до 188px до плашки «Тарифы». Правка
 * страницы, а не общего ритма сайта: `--section-y` остаётся нетронутым, а
 * первая секция страницы берёт свой, сжатый верх через `.section--first`.
 *
 * jsdom не считает CSS и геометрию, поэтому тест читает `index.css` и тело
 * правила — сами отступы на ширинах проверяет слой приёмки (Playwright).
 * Образец — `components/SiteHeader.layout.test.ts`.
 */
const SRC = resolve(process.cwd(), 'src');
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8');
const PRICING_TSX = readFileSync(join(SRC, 'pages', 'Pricing.tsx'), 'utf8');

/** Токен из `:root`; пустая строка, если токена нет. */
function rootToken(css: string, name: string): string {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!root) {
    return '';
  }
  const declared = root[1].match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return declared ? declared[1].trim() : '';
}

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(re)][0]?.[1] ?? '';
}

describe('верх публичного прайса: свой шаг вместо общего шага секции', () => {
  it('объявляет токен первой секции в :root, а не в модуле', () => {
    // Токен обязан жить в `:root` (`src/design-system.test.ts` запрещает токены
    // в `*.module.css`), и значение 32–40px — это и есть исправленный отступ.
    expect(rootToken(INDEX_CSS, 'section-y-first')).toBe('clamp(2rem, 1.25rem + 2vw, 2.5rem)');
  });

  it('не трогает общий шаг секции сайта', () => {
    expect(rootToken(INDEX_CSS, 'section-y')).toBe('clamp(3.5rem, 2rem + 6vw, 7rem)');
  });

  it('сжимает только верх первой секции, а не весь блок отступа', () => {
    const body = ruleBody(INDEX_CSS, '.section--first');
    expect(body).toContain('padding-block-start: var(--section-y-first)');
    // Низ секции остаётся на общем шаге: `padding-block` здесь перебил бы его.
    expect(body).not.toContain('padding-block:');
  });

  it('объявляет первую секцию прайса классом `section--first`', () => {
    expect(PRICING_TSX).toContain('className="section section--first"');
  });
});
