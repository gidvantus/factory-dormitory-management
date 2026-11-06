/**
 * Деньги на экране: сервер присылает суммы строками (`Numeric` → «67500.00»), а
 * не числами, поэтому копейки считаются целыми, а не плавающей точкой.
 *
 * Готовые подписи цен (`price_label`, `amount_label`) по-прежнему собирает
 * сервер — этот модуль нужен только там, где экран показывает произведение
 * «цена места × количество» до покупки: сумму счёта всё равно считает сервер,
 * и клиентское число остаётся подсказкой, а не источником истины.
 */

/** Разделитель разрядов — неразрывный пробел, как в подписях сервера. */
const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** Сумма из копеек: `6750000` → «67 500 ₽». */
export function formatKopecks(kopecks: number): string {
  return `${RUB.format(kopecks / 100)}\u00a0₽`;
}

/** Сумма строкой из ответа сервера: «67500.00» → `6750000` копеек. */
export function toKopecks(amount: string | null | undefined): number {
  if (!amount) return 0;
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}
