export const MAX_USERS = 10_000;
export const BASE_PRICE = 990;

export const PRICE_BANDS = [
  { from: 1, to: 5, price: 990, label: 'Первые 5 мест' },
  { from: 6, to: 10, price: 890, label: 'С 6-го по 10-е' },
  { from: 11, to: 20, price: 790, label: 'С 11-го по 20-е' },
  { from: 21, to: MAX_USERS, price: 690, label: 'С 21-го места' },
] as const;

export type PaymentPeriod = 'month' | 'year';

export const ADDONS = [
  {
    id: 'telegram',
    name: 'Telegram-оповещения',
    monthlyPrice: 500,
    description: 'Уведомления о выселении проживающих в личный Telegram сотрудников.',
    detail: 'Каждый сотрудник подключает свой Telegram в кабинете.',
  },
  {
    id: 'journal',
    name: 'Журнал действий',
    monthlyPrice: 990,
    description: 'Кто, когда и что изменил: история действий сотрудников в системе.',
    detail: 'Просмотр журнала доступен владельцу организации.',
  },
] as const;

export type AddonId = (typeof ADDONS)[number]['id'];

/** Год рабочих мест стоит десять месяцев; услуги оплачиваются за все 12 месяцев. */
export function calculatePrice(
  users: number,
  period: PaymentPeriod,
  selectedAddonIds: readonly AddonId[] = [],
) {
  if (!Number.isInteger(users) || users < 1 || users > MAX_USERS) {
    throw new RangeError(`Количество пользователей должно быть от 1 до ${MAX_USERS}`);
  }

  const breakdown = PRICE_BANDS.map((band) => {
    const quantity = Math.max(0, Math.min(users, band.to) - band.from + 1);
    return { ...band, quantity, subtotal: quantity * band.price };
  });
  const monthlyTotal = breakdown.reduce((total, band) => total + band.subtotal, 0);
  const months = period === 'year' ? 12 : 1;
  const addons = ADDONS.filter((addon) => selectedAddonIds.includes(addon.id)).map((addon) => ({
    ...addon,
    total: addon.monthlyPrice * months,
  }));
  const addonsTotal = addons.reduce((total, addon) => total + addon.total, 0);
  const workplacesTotal = monthlyTotal * (period === 'year' ? 10 : 1);
  const baseline = users * BASE_PRICE * months + addonsTotal;
  const volumeSaving = (users * BASE_PRICE - monthlyTotal) * months;
  const annualSaving = period === 'year' ? monthlyTotal * 2 : 0;
  const total = workplacesTotal + addonsTotal;

  return {
    breakdown,
    monthlyTotal,
    workplacesTotal,
    addons,
    addonsTotal,
    baseline,
    volumeSaving,
    annualSaving,
    total,
    saving: baseline - total,
    perUserMonthly: workplacesTotal / months / users,
  };
}

export function userLabel(users: number): string {
  const lastTwo = users % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'пользователей';
  const last = users % 10;
  return last === 1 ? 'пользователь' : last >= 2 && last <= 4 ? 'пользователя' : 'пользователей';
}
