import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Страховка от возврата дефекта приёмки: после добавления шестого пункта меню
 * («Тарифы») шапка перестала помещаться в контейнер на 1024 и 900px — правый
 * блок с кнопками выдавливался за вьюпорт, появлялась горизонтальная прокрутка,
 * а подписи «Кому подходит» и «Как работает» ломались на две строки.
 *
 * Лечение — не переносить подписи, а уступать место отступами: `nowrap` у
 * пунктов и кнопок, несжимаемый логотип и кнопки, сжимаемое меню и медиа-блок
 * со сжатыми отступами. jsdom не считает CSS и геометрию, поэтому тест читает
 * `index.css` и проверяет тела правил — раскладку на ширинах проверяет слой
 * приёмки (Playwright). Образец — `components/CookieConsent.layout.test.ts`.
 */
const SRC = resolve(process.cwd(), 'src');
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8');

/** Тела всех правил с этим селектором; пустой список, если правил нет. */
function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  return [...css.matchAll(re)].map((match) => match[1]);
}

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  return ruleBodies(css, selector)[0] ?? '';
}

/** Тело медиа-блока по его условию; пустая строка, если блока нет. */
function mediaBody(css: string, condition: string): string {
  const start = css.indexOf(`@media ${condition}`);
  if (start === -1) {
    return '';
  }
  const open = css.indexOf('{', start);
  if (open === -1) {
    return '';
  }
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1;
    } else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  return '';
}

describe('шапка публичных страниц держит одну строку до 768px', () => {
  it('не переносит подписи пунктов меню и кнопок', () => {
    expect(ruleBody(INDEX_CSS, '.nav__links a')).toContain('white-space: nowrap');
    expect(ruleBody(INDEX_CSS, '.btn')).toContain('white-space: nowrap');
  });

  it('место уступает меню, а не логотип и кнопки', () => {
    expect(ruleBody(INDEX_CSS, '.logo')).toContain('flex: none');
    expect(ruleBody(INDEX_CSS, '.nav__links')).toContain('min-width: 0');
    expect(ruleBody(INDEX_CSS, '.btn')).toContain('flex: none');
    // Правый блок не ужимается: `min-width: 0` на `.nav__actions` позволял
    // кнопке вылезти из своего бокса и тянул прокрутку всей страницы на 769-900px.
    expect(ruleBody(INDEX_CSS, '.nav__actions')).not.toContain('min-width: 0');
  });

  it('с 1119px сжимает отступы шапки и разрешает прокрутку меню', () => {
    const block = mediaBody(INDEX_CSS, '(max-width: 1119px)');
    expect(block, 'нужен медиа-блок @media (max-width: 1119px)').not.toBe('');

    expect(ruleBody(block, '.nav')).toContain('gap: 1rem');
    const links = ruleBody(block, '.nav__links');
    expect(links).toContain('gap: 0.5rem');
    expect(links).toContain('overflow-x: auto');
    expect(ruleBody(block, '.nav__links a')).toContain('padding: 0.25rem 0.125rem');
  });

  it('идёт в блоке адаптива перед правилом 1024px, а не вразброс', () => {
    const compact = INDEX_CSS.indexOf('@media (max-width: 1119px)');
    const tablet = INDEX_CSS.indexOf('@media (max-width: 1024px)');
    const menusHidden = INDEX_CSS.indexOf('@media (max-width: 768px)');
    expect(compact).toBeGreaterThan(-1);
    expect(tablet).toBeGreaterThan(-1);
    expect(compact).toBeLessThan(tablet);
    expect(tablet).toBeLessThan(menusHidden);
  });

  it('ниже 768px меню по-прежнему скрыто целиком', () => {
    const block = mediaBody(INDEX_CSS, '(max-width: 768px)');
    expect(ruleBody(block, '.nav__links')).toContain('display: none');
  });
});
