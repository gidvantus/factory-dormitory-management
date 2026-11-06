import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Контракт раздачи статики. Выкатка меняет хеши в именах файлов сборки, но
 * `index.html` остаётся тем же адресом: без явного `Cache-Control` браузер
 * держит его в эвристическом кеше и после пересборки показывает старую страницу
 * со старым JS. Именно так удалённая в #177 строка «всё ещё выводилась» на
 * стенде — правка была в `develop-m`, а браузер исполнял прошлую сборку.
 *
 * Тест текстовый (как `design-system.test.ts`): nginx в jsdom не проверить, а
 * регресс здесь виден только человеку в браузере — то есть слишком поздно.
 */
const CONFIG = readFileSync(resolve(process.cwd(), 'nginx.conf'), 'utf8').replace(/#[^\n]*/g, '');

/** Тело `location` по точному пути-образцу; пустая строка, если блока нет. */
function location(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(CONFIG);
  return match ? match[1] : '';
}

describe('раздача статики: кеш не прячет новую сборку', () => {
  it('index.html перепроверяется, а не кешируется', () => {
    expect(location('= /index.html')).toContain('add_header Cache-Control "no-cache"');
  });

  it('файлы сборки с хешем в имени кешируются надолго', () => {
    const assets = location('/assets/');
    expect(assets).toContain('max-age=31536000');
    expect(assets).toContain('immutable');
  });

  it('SPA-фолбэк на index.html сохранён: кабинет открывается по прямому адресу', () => {
    expect(CONFIG).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
  });
});
