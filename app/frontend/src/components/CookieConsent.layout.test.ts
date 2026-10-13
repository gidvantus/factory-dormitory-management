import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { anonymousSession, mockFetch } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Страховка от возврата дефекта приёмки: фиксированная плашка согласия накрывала
 * нижний блок бокового меню кабинета — «Личные данные» и кнопку «Выйти», до
 * которых не доходили ни клик, ни Tab. Плашка сама измеряет свою высоту и отдаёт
 * её каркасу кабинета, а список разделов уступает место нижнему блоку.
 *
 * jsdom не считает CSS и геометрию, поэтому проверяются контракт стилей и сама
 * публикация переменной, а раскладка на низких окнах — слой приёмки (Playwright).
 */
const SRC = resolve(process.cwd(), 'src');
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8');
const WORKSPACE_CSS = readFileSync(join(SRC, 'workspace', 'Workspace.module.css'), 'utf8');

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

describe('плашка согласия не закрывает нижние элементы кабинета', () => {
  it('каркас кабинета оставляет под плашку её измеренную высоту', () => {
    const sidebarRules = ruleBodies(WORKSPACE_CSS, '.shell .sidebar').join('\n');
    expect(sidebarRules).toContain(
      'padding-bottom: calc(18px + var(--cookie-consent-height, 0px))',
    );
    // Магической константы с clamp-обрезкой, из-за которой дефект вернулся,
    // в запасе быть не должно.
    expect(sidebarRules).not.toContain('clamp');
  });

  it('список разделов уступает высоту нижнему блоку и прокручивается сам', () => {
    const nav = ruleBody(WORKSPACE_CSS, '.shell .sidebar > nav');
    expect(nav).toContain('flex: 1 1 auto');
    expect(nav).toContain('min-height: 0');
    expect(nav).toContain('overflow-y: auto');
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

  it('публикует измеренную высоту плашки и снимает её после принятия', async () => {
    mockFetch(() => anonymousSession());
    const user = userEvent.setup();
    renderApp('/');

    await screen.findByTestId('cookie-consent');
    // В jsdom высота равна нулю: важен сам факт публикации переменной.
    expect(document.documentElement.style.getPropertyValue('--cookie-consent-height')).toBe('0px');

    await user.click(screen.getByTestId('cookie-consent-accept'));

    expect(document.documentElement.style.getPropertyValue('--cookie-consent-height')).toBe('');
  });
});
