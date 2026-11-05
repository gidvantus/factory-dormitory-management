export const MAX_USERS = 10_000;

export const LICENSES = {
  halfYear: { label: '6 месяцев', months: 6, price: 60_000, includedUsers: 5, userPrice: 2000 },
  year: { label: '1 год', months: 12, price: 100_000, includedUsers: 10, userPrice: 1500 },
} as const;

export type LicenseTerm = keyof typeof LICENSES;

/** Скидка действует на весь набор дополнительных мест. Одно место стоит базовую цену. */
export function getUserPrice(extraUsers: number, term: LicenseTerm) {
  const discount = extraUsers < 2 ? 0 : Math.min(extraUsers, 50);
  return { discount, unitPrice: (LICENSES[term].userPrice * (100 - discount)) / 100 };
}

export const ADDONS = [
  {
    id: 'telegram',
    name: 'Telegram-оповещения',
    description: 'Уведомления по вашим правилам в личный Telegram сотрудников.',
    detail: 'Каждый сотрудник подключает свой Telegram в кабинете.',
  },
  {
    id: 'journal',
    name: 'Журнал действий',
    description: 'Кто, когда и что изменил: история действий сотрудников в системе.',
    detail: 'Просмотр журнала доступен владельцу организации.',
  },
] as const;

export type AddonId = (typeof ADDONS)[number]['id'];

/** При оформлении дополнительные места доступны на полный срок лицензии. */
export function calculatePrice(extraUsers: number, term: LicenseTerm) {
  if (!Number.isInteger(extraUsers) || extraUsers < 0 || extraUsers > MAX_USERS) {
    throw new RangeError(
      `Количество дополнительных пользователей должно быть от 0 до ${MAX_USERS}`,
    );
  }

  const license = LICENSES[term];
  const { discount, unitPrice } = getUserPrice(extraUsers, term);
  const extraUsersTotal = extraUsers * unitPrice;

  return {
    license,
    totalUsers: license.includedUsers + extraUsers,
    discount,
    unitPrice,
    extraUsersTotal,
    total: license.price + extraUsersTotal,
    saving: extraUsers * license.userPrice - extraUsersTotal,
  };
}

/** Для макета магазина остаток срока задаётся в месяцах. */
export function calculateTopUp(extraUsers: number, term: LicenseTerm, remainingMonths: number) {
  const quote = calculatePrice(extraUsers, term);
  if (
    !Number.isInteger(remainingMonths) ||
    remainingMonths < 0 ||
    remainingMonths > quote.license.months
  ) {
    throw new RangeError('Остаток срока должен быть в пределах действующей лицензии');
  }
  const remainingShare = remainingMonths / quote.license.months;
  const unitPrice = Math.round(quote.unitPrice * remainingShare * 100) / 100;
  const total = Math.round(quote.extraUsersTotal * remainingShare * 100) / 100;
  return { ...quote, remainingShare, fullTermUnitPrice: quote.unitPrice, unitPrice, total };
}

export function userLabel(users: number): string {
  const lastTwo = users % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'пользователей';
  const last = users % 10;
  return last === 1 ? 'пользователь' : last >= 2 && last <= 4 ? 'пользователя' : 'пользователей';
}
