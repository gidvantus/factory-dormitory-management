import { describe, expect, it } from 'vitest';

import { calculatePrice, calculateTopUp } from './pricing';

describe('Стоимость лицензии и дополнительных пользователей', () => {
  it.each([
    ['halfYear', 60_000, 5],
    ['year', 100_000, 10],
  ] as const)('лицензия %s без дополнительных мест', (term, total, totalUsers) => {
    expect(calculatePrice(0, term)).toMatchObject({ total, totalUsers, extraUsersTotal: 0 });
  });

  it.each([
    [1, 0, 2000, 1500],
    [2, 2, 1960, 1470],
    [10, 10, 1800, 1350],
    [20, 20, 1600, 1200],
    [49, 49, 1020, 765],
    [50, 50, 1000, 750],
    [51, 50, 1000, 750],
  ])('%i дополнительных мест по шкале скидок', (users, discount, halfYearPrice, yearPrice) => {
    expect(calculatePrice(users, 'halfYear')).toMatchObject({
      discount,
      unitPrice: halfYearPrice,
      extraUsersTotal: users * halfYearPrice,
      totalUsers: users + 5,
    });
    expect(calculatePrice(users, 'year')).toMatchObject({
      discount,
      unitPrice: yearPrice,
      extraUsersTotal: users * yearPrice,
      totalUsers: users + 10,
    });
  });

  it('общая стоимость растёт при добавлении каждого места, включая границу скидки', () => {
    for (let users = 0; users <= 50; users++) {
      expect(calculatePrice(users + 1, 'halfYear').total).toBeGreaterThan(
        calculatePrice(users, 'halfYear').total,
      );
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001])(
    'отклоняет недопустимое количество %s',
    (users) => {
      expect(() => calculatePrice(users, 'halfYear')).toThrow(RangeError);
    },
  );

  it.each([
    [1, 'halfYear', 3, 1000],
    [10, 'halfYear', 3, 9000],
    [50, 'year', 6, 18_750],
    [50, 'year', 3, 9375],
    [1, 'halfYear', 1, 333.33],
    [1, 'year', 0, 0],
  ] as const)(
    'докупка %i мест с лицензией %s и остатком %i месяцев',
    (users, term, remainingMonths, total) => {
      expect(calculateTopUp(users, term, remainingMonths).total).toBe(total);
    },
  );

  it.each([-1, 7, 1.5, Number.NaN])('отклоняет неверный остаток срока %s', (months) => {
    expect(() => calculateTopUp(1, 'halfYear', months)).toThrow(RangeError);
  });
});
