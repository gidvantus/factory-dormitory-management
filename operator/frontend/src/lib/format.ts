/**
 * Форматирование значений для экранов кабинета.
 *
 * Даты разбираются вручную, без `toLocaleDateString`: кабинет показывает
 * календарную дату, которую прислал сервер, а локаль и часовой пояс машины
 * тестировщика не должны менять то, что видно на экране (тесты герметичны).
 */

/** Название организации у пустой заготовки: `name` в API бывает `null`. */
export const NO_NAME = 'Без названия';

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/**
 * Форма слова по числу: `plural(3, ['общежитие', 'общежития', 'общежитий'])`.
 *
 * Русское правило: 11..14 — всегда третья форма, иначе по последней цифре.
 */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const mod100 = Math.abs(count) % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = mod100 % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/**
 * `2026-03-14T10:00:00` → `{ day: 14, monthIndex: 2, year: 2026 }`.
 *
 * Разбор по строкам формата ISO, а не через `Date`: у даты без часового пояса
 * браузер считает её локальной, у даты с поясом — пересчитывает, и один и тот
 * же момент показался бы разными числами на разных машинах.
 */
function parts(value: string): { day: string; monthIndex: number; year: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return null;
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return null;
  return { day: match[3], monthIndex: month, year: match[1] };
}

/** Дата строкой в списке: `14.03.2026`. Неразобранное значение — как пришло. */
export function formatDay(value: string): string {
  const parsed = parts(value);
  if (parsed === null) return value;
  return `${parsed.day}.${String(parsed.monthIndex + 1).padStart(2, '0')}.${parsed.year}`;
}

/** Дата словами в карточке: `14 марта 2026`. */
export function formatDayLong(value: string): string {
  const parsed = parts(value);
  if (parsed === null) return value;
  return `${Number(parsed.day)} ${MONTHS_GENITIVE[parsed.monthIndex]} ${parsed.year}`;
}
