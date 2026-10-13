import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Страховка от возврата дефекта приёмки: высокая фиксированная плашка согласия
 * накрывала нижний блок бокового меню кабинета — «Личные данные» и кнопку
 * «Выйти», до которых не доходили ни клик, ни Tab (замер `elementFromPoint`
 * возвращал саму плашку).
 *
 * jsdom не считает CSS и геометрию, поэтому контракт проверяется по файлам
 * стилей: плашка обязана быть низкой, а каркас кабинета — резервировать под неё
 * место у нижнего края, пока согласие не принято.
 */
const SRC = resolve(process.cwd(), 'src');
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8');
const WORKSPACE_CSS = readFileSync(join(SRC, 'workspace', 'Workspace.module.css'), 'utf8');

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1] : '';
}

describe('плашка согласия не закрывает нижние элементы кабинета', () => {
  it('каркас кабинета резервирует место под плашку и снимает запас без неё', () => {
    // Запас ограничен свободной высотой экрана: боковое меню занимает весь
    // вьюпорт, и жёсткий отступ вытолкнул бы его низ за экран на низких окнах.
    expect(WORKSPACE_CSS).toContain(
      'padding-bottom: calc(18px + clamp(0px, 100dvh - 712px, var(--cookie-consent-reserve, 0px)))',
    );

    // Запас включается только пока плашка есть в DOM: `:has()` гаснет вместе
    // с ней, и после принятия согласия боковое меню возвращается к обычному виду.
    const reserveRule = ruleBody(INDEX_CSS, ':root:has(.cookie-consent)');
    expect(reserveRule).toContain('--cookie-consent-reserve: var(--cookie-consent-space)');
  });

  it('оставляет под плашку полосу не меньше пятидесяти пикселей', () => {
    const reserve = /--cookie-consent-space:\s*(\d+)px/.exec(INDEX_CSS);
    expect(reserve, 'в index.css нет --cookie-consent-space').not.toBeNull();
    const pixels = Number(reserve?.[1]);
    // Ниже 50px цельный блок «Личные данные + Выйти» перестаёт помещаться.
    expect(pixels).toBeGreaterThanOrEqual(50);
  });

  it('держит плашку низкой: компактные отступы и без потолка по ширине текста', () => {
    const banner = ruleBody(INDEX_CSS, '.cookie-consent');
    expect(banner).toContain('padding: var(--space-3) var(--gutter)');
    expect(banner).not.toContain('var(--space-5)');

    // Ограничение по `ch` заставляло текст переноситься на лишние строки,
    // и плашка вырастала вдвое — именно на неё жаловался человек.
    const text = ruleBody(INDEX_CSS, '.cookie-consent__text');
    expect(text).toContain('max-width: none');
    expect(text).not.toContain('max-width: 60ch');
  });
});
