import { describe, expect, it } from 'vitest';

import { NGINX_CONFIG, location } from './test/nginxConfig';

/**
 * Контракт раздачи статики. Выкатка меняет хеши в именах файлов сборки, но
 * `index.html` остаётся тем же адресом: без явного `Cache-Control` браузер
 * держит его в эвристическом кеше и после пересборки показывает старую страницу
 * со старым JS. Именно так удалённая в #177 строка «всё ещё выводилась» на
 * стенде — правка была в `develop-m`, а браузер исполнял прошлую сборку.
 *
 * Тест текстовый (как `design-system.test.ts`): nginx в jsdom не проверить, а
 * регресс здесь виден только человеку в браузере — то есть слишком поздно.
 * Чтение конфига и разбор `location` живут в `test/nginxConfig.ts`.
 */
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
    expect(NGINX_CONFIG).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
  });
});
