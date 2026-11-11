import { describe, expect, it } from 'vitest';

import { location } from './test/nginxConfig';

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
 * Слэш на конце — отдельный случай: `=` сравнивает путь побайтово, поэтому у
 * `/metrics/` свой блок. Тест держит оба, иначе «наглухо» закрыт только
 * канонический путь (наблюдение тестировщика в отчёте №3).
 *
 * Тест текстовый, как `nginx-cache.test.ts`: nginx в jsdom не проверить, а
 * регресс иначе виден только на стенде или в бою. Чтение конфига и разбор
 * `location` — в `test/nginxConfig.ts`.
 */
describe('служебные пути: метрики не публикуются наружу', () => {
  it.each(['= /metrics', '= /metrics/'])('%s отвечает 404, а не SPA-страницей', (path) => {
    expect(location(path)).toContain('return 404');
  });

  it('служебный путь не проксируется в API и не раздаётся как статика', () => {
    for (const path of ['= /metrics', '= /metrics/']) {
      expect(location(path)).not.toContain('proxy_pass');
      expect(location(path)).not.toContain('try_files');
    }
  });
});
