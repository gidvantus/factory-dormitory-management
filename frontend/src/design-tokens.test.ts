import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Текстовые токены проверяются на контраст по WCAG 2.1 AA (1.4.3): приёмка
 * ловила регрессию, когда приглушённый текст красился примитивом `--ink-300`
 * (#7b8794) и давал 3,4–3,7:1 вместо 4,5:1. Порог считается прямо здесь, из
 * файла со стилями, чтобы токен нельзя было поменять на нечитаемый молча.
 */
const CSS = readFileSync(resolve(process.cwd(), 'src', 'index.css'), 'utf8');

/** Фоны, на которых стоит текст интерфейса. */
const BACKGROUNDS: Record<string, string> = {
  'cream-50': '#fffdf9',
  'cream-100': '#fbf6ec',
  surface: '#ffffff',
  'peach-100': '#fbe0d2',
};

const CASES: Array<{ token: string; backgrounds: string[] }> = [
  { token: '--color-text', backgrounds: ['cream-50', 'cream-100', 'surface'] },
  { token: '--color-text-body', backgrounds: ['cream-50', 'cream-100', 'surface'] },
  { token: '--color-text-muted', backgrounds: ['cream-50', 'cream-100', 'surface'] },
  { token: '--color-danger', backgrounds: ['surface', 'peach-100'] },
];

const DECLARATION = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;

/** Объявления токенов из файла: первое значение каждого имени. */
function tokenValues(): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of CSS.matchAll(DECLARATION)) {
    if (!values.has(match[1])) {
      values.set(match[1], match[2].trim());
    }
  }
  return values;
}

const TOKENS = tokenValues();

/** Приводит токен к шестнадцатеричному цвету, разворачивая ссылки вида var(--x). */
function colorOf(name: string): string {
  let value: string | undefined = TOKENS.get(name);
  for (let hop = 0; hop < 5; hop += 1) {
    if (value === undefined) {
      throw new Error(`В index.css нет токена ${name}`);
    }
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (alias === null) {
      break;
    }
    value = TOKENS.get(alias[1]);
  }
  const hex = value === undefined ? null : /#[0-9a-fA-F]{6}/.exec(value);
  if (hex === null) {
    throw new Error(`Токен ${name} не сводится к шестнадцатеричному цвету`);
  }
  return hex[0].toLowerCase();
}

function channelLuminance(hex: string): number[] {
  return [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}

function luminance(hex: string): number {
  const [red, green, blue] = channelLuminance(hex);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('контраст текстовых токенов', () => {
  for (const { token, backgrounds } of CASES) {
    it(`${token} даёт не меньше 4.5:1`, () => {
      const color = colorOf(token);
      for (const name of backgrounds) {
        const ratio = contrast(color, BACKGROUNDS[name]);
        expect(
          ratio,
          `${token} (${color}) на фоне ${name} (${BACKGROUNDS[name]}): ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
