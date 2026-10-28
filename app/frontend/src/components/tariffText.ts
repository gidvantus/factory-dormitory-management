/**
 * Подписи срока тарифа: дата и слово «день».
 *
 * Обе функции — только форматирование того, что посчитал сервер. Дни
 * (`days_left`) и момент окончания (`ends_at`) приходят готовыми: клиент не
 * вычитает дни из даты и не держит вторую копию правила «за 14 дней
 * предупредить» — оно живёт в `app/subscription.py`.
 */

/**
 * Дата вида ДД.ММ.ГГГГ: сервер отдаёт ISO, человеку нужен привычный формат.
 *
 * Пустая строка вместо мусора: битую дату лучше не показать вовсе, чем
 * показать «Invalid Date». Часовой пояс Москвы — тот же, в котором работает
 * кабинет (`DashboardTariff` показывал так конец пробного периода).
 */
export function formatTariffDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(date);
}

/** «5 дней»: без согласования числа текст читается как машинный. */
export function daysWord(days: number): string {
  const tail = days % 100;
  if (tail >= 11 && tail <= 14) return 'дней';
  switch (days % 10) {
    case 1:
      return 'день';
    case 2:
    case 3:
    case 4:
      return 'дня';
    default:
      return 'дней';
  }
}

/** «через 5 дней» / «через 1 день» — число и слово из одного места. */
export function daysPhrase(days: number): string {
  return `${days} ${daysWord(days)}`;
}
