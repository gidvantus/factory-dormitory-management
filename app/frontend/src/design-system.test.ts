import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Страж дизайн-системы. Контракт живёт в `src/DESIGN.md`, значения — в `:root`
 * `src/index.css`, а модули рабочего пространства только потребляют их. Тест
 * текстовый (как `design-tokens.test.ts`) и читает файлы через `readFileSync`,
 * потому что jsdom не считает CSS и молча пропустил бы вторую палитру.
 */
const SRC = resolve(process.cwd(), 'src');

/** Все CSS-модули проекта: правило действует на каждый из них. */
function moduleCssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return moduleCssFiles(path);
    }
    return path.endsWith('.module.css') ? [path] : [];
  });
}

const FILES = moduleCssFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1).replace(/\\/g, '/'),
  css: readFileSync(path, 'utf8'),
}));

interface Rule {
  selector: string;
  body: string;
}

/** Правила файла: комментарии выброшены, селектор и тело разделены первой `{`. */
function rules(css: string): Rule[] {
  const found: Rule[] = [];
  for (const chunk of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const open = chunk.indexOf('{');
    if (open === -1) continue;
    found.push({ selector: chunk.slice(0, open).trim(), body: chunk.slice(open + 1) });
  }
  return found;
}

/** Последний компаунд селектора без псевдоклассов и атрибутов. */
function lastCompound(selector: string): string {
  const parts = selector.split(/[\s>+~]+/);
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/\[[^\]]*\]/g, '').replace(/::?[a-z-]+(?:\([^)]*\))?/gi, '');
}

/**
 * Известные исключения: кнопки, которым локальная геометрия нужна по смыслу —
 * иконочные стрелки порядка строк, текстовая кнопка-название строки отчёта,
 * чипы-ссылки на ячейки формулы и кнопка внутри плашки ошибки организации.
 * Это не «ослабление» правила, а явный список: всё остальное обязано брать
 * вид у глобального `.btn`.
 *
 * Кнопки-иконки каркаса (`.shell .logout`, `.shell .menu-toggle`,
 * `.shell .modal__close`) тоже остаются локальными, но под проверку не
 * попадают: их селекторы оканчиваются классом, а не элементом `button`.
 */
const BUTTON_RULE_EXCEPTIONS = [
  '.rowName button',
  '.rowMove button',
  '.references button',
  '.shell .organization-error button',
  // Обводка фокуса — сквозное правило доступности для кнопок и ссылок каркаса,
  // а не вид кнопки: она берёт `--focus-outline-width` и одинакова везде.
  '.shell button:focus-visible',
];

const BUTTON_PROPERTIES = ['border-radius', 'background', 'border', 'outline'];

const FORBIDDEN_LITERALS = ['white', '#fff', '#ffffff', '#fffdf9', '#fbf6ec', '#f4ebdc', '#e8dcc7'];

/**
 * Литералы, оставшиеся вне задачи #25: они не участвуют в сведении второй
 * палитры и перечислены явно, чтобы появление нового значения всё равно
 * ловилось.
 */
const FROZEN_LITERALS = [
  '#7a5c0d',
  '#97431f',
  '#c34d4d',
  'var(--color-status-neutral)',
  'var(--color-status-ok)',
  'var(--color-status-missing)',
  'rgb(255 255 255 / 94%)',
];

const TOKEN_PREFIXES = [
  '--color-',
  '--text-',
  '--font-',
  '--radius-',
  '--shadow-',
  '--space-',
  '--gap-',
  '--control-',
];

describe('контракт дизайн-системы', () => {
  it('находит CSS-модули', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('не объявляет токены вне index.css', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of file.css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
        if (TOKEN_PREFIXES.some((prefix) => match[1].startsWith(prefix))) {
          offenders.push(`${file.path}: ${match[1]}`);
        }
      }
    }
    expect(offenders, `Токены объявляет только index.css:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('не красит кнопки в модулях', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const rule of rules(file.css)) {
        for (const selector of rule.selector.split(',')) {
          const text = selector.trim();
          if (lastCompound(text).toLowerCase() !== 'button') continue;
          if (BUTTON_RULE_EXCEPTIONS.includes(text)) continue;
          for (const property of BUTTON_PROPERTIES) {
            if (new RegExp(`(?:^|[\\s;{])${property}\\s*:`, 'i').test(rule.body)) {
              offenders.push(`${file.path}: ${text} { ${property} }`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `Вид кнопок задаёт глобальный слой в index.css:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('не зашивает кремовые фоны литералами', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const declarations =
        /(?:^|[\s;{])(background(?:-color)?|border(?:-[a-z]+)?-color)\s*:\s*([^;]+);/gim;
      for (const match of file.css.matchAll(declarations)) {
        const value = match[2].trim().toLowerCase();
        if (FROZEN_LITERALS.some((frozen) => value.includes(frozen))) continue;
        for (const literal of FORBIDDEN_LITERALS) {
          if (new RegExp(`(?:^|[\\s(,])${literal}(?:$|[\\s),;])`).test(value)) {
            offenders.push(`${file.path}: ${match[0].trim()}`);
            break;
          }
        }
      }
    }
    expect(offenders, `Фоны и границы берутся из токенов:\n${offenders.join('\n')}`).toEqual([]);
  });
});
