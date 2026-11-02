import { describe, expect, it } from 'vitest';

import { calculatePrice } from './pricing';

describe('Расчёт стоимости рабочих мест', () => {
  it.each([
    [1, 990],
    [3, 2970],
    [5, 4950],
    [6, 5840],
    [7, 6730],
    [10, 9400],
    [11, 10190],
    [20, 17300],
    [21, 17990],
    [30, 24200],
  ])('%i пользователей стоят %i рублей в месяц', (users, expected) => {
    expect(calculatePrice(users, 'month').total).toBe(expected);
  });

  it('за год складывает скидки без повторного вычитания экономии', () => {
    const quote = calculatePrice(10, 'year');
    expect(quote.total).toBe(94_000);
    expect(quote.baseline).toBe(118_800);
    expect(quote.volumeSaving).toBe(6000);
    expect(quote.annualSaving).toBe(18_800);
    expect(quote.saving).toBe(24_800);
    expect(quote.baseline - quote.volumeSaving - quote.annualSaving).toBe(quote.total);
  });

  it('добавление места на границе скидки всегда увеличивает платёж', () => {
    for (const users of [5, 10, 20]) {
      for (const period of ['month', 'year'] as const) {
        expect(calculatePrice(users + 1, period).total).toBeGreaterThan(
          calculatePrice(users, period).total,
        );
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001])(
    'не рассчитывает счёт для недопустимого количества %s',
    (users) => {
      expect(() => calculatePrice(users, 'month')).toThrow(RangeError);
    },
  );

  it.each([
    ['month', ['telegram'], 9900, 500],
    ['month', ['journal'], 10_390, 990],
    ['month', ['telegram', 'journal'], 10_890, 1490],
    ['year', ['telegram'], 100_000, 6000],
    ['year', ['journal'], 105_880, 11_880],
    ['year', ['telegram', 'journal'], 111_880, 17_880],
  ] as const)('услуги за компанию: %s, %s', (period, addons, total, addonsTotal) => {
    const quote = calculatePrice(10, period, addons);
    expect(quote.total).toBe(total);
    expect(quote.addonsTotal).toBe(addonsTotal);
    expect(quote.baseline - quote.volumeSaving - quote.annualSaving).toBe(total);
  });

  it('число сотрудников не меняет стоимость услуг и не даёт скидку на них', () => {
    for (const period of ['month', 'year'] as const) {
      const small = calculatePrice(1, period, ['telegram', 'journal']);
      const large = calculatePrice(30, period, ['telegram', 'journal']);
      expect(small.addonsTotal).toBe(large.addonsTotal);
      expect(large.saving).toBe(calculatePrice(30, period).saving);
      expect(large.perUserMonthly).toBe(calculatePrice(30, period).perUserMonthly);
    }
  });

  it('одна услуга считается только один раз на организацию', () => {
    expect(calculatePrice(10, 'month', ['telegram', 'telegram']).addonsTotal).toBe(500);
  });
});
