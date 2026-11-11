import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Служебные пути, которых у фронта быть не должно.
 *
 * `/metrics` — вход Prometheus, он живёт только внутри сети compose
 * (`api:8000/metrics`, #213). Наружу путь не публикуется, и приёмка проверяет
 * это кодом ответа: `curl -o /dev/null -w '%{http_code}' https://<домен>/metrics`
 * обязан дать `404`. Пока правила не было, срабатывал SPA-фолбэк из
 * `location /` и отдавал `index.html` со статусом `200` — метрик в теле нет, но
 * закрытый путь становился неотличим от открытого (тестировщик поймал ровно
 * это, T12/Ф1).
 *
 * Тест текстовый, как `nginx-cache.test.ts`: nginx в jsdom не проверить, а
 * регресс иначе виден только на стенде или в бою.
 */
const CONFIG = readFileSync(resolve(process.cwd(), 'nginx.conf'), 'utf8').replace(/#[^\n]*/g, '');

/** Тело `location` по точному пути-образцу; пустая строка, если блока нет. */
function location(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(CONFIG);
  return match ? match[1] : '';
}

describe('служебные пути: метрики не публикуются наружу', () => {
  it('/metrics отвечает 404, а не SPA-страницей', () => {
    expect(location('= /metrics')).toContain('return 404');
  });

  it('/metrics не проксируется в API и не раздаётся как статика', () => {
    const metrics = location('= /metrics');
    expect(metrics).not.toContain('proxy_pass');
    expect(metrics).not.toContain('try_files');
  });
});
