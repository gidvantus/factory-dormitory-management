import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Конфиг фронта как данные для текстовых тестов.
 *
 * nginx в jsdom не проверить, поэтому его поведение держат разбором текста, а
 * регресс иначе виден только на стенде или в бою. Модуль общий для
 * `nginx-cache.test.ts` и `nginx-service-paths.test.ts`: два экземпляра
 * `CONFIG`/`location()` — «близнецы, которые обязаны меняться вместе», и второй
 * однажды тихо отстал бы (замечание ревью №3 к #213).
 */
export const NGINX_CONFIG = readFileSync(resolve(process.cwd(), 'nginx.conf'), 'utf8').replace(
  /#[^\n]*/g,
  '',
);

/** Тело `location` по точному пути-образцу; пустая строка, если блока нет. */
export function location(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(NGINX_CONFIG);
  return match ? match[1] : '';
}
