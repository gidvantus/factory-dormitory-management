export const normalizeMetric = (name: string): string =>
  name.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim().replace(/\s+/g, ' ');

export const SUMMARY_AGGREGATES = {
  sum: 'Сумма за период',
  average: 'Среднее за день',
  last: 'На последнюю дату',
};
