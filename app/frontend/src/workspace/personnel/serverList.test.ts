import { describe, expect, it } from 'vitest';
import { employeePageQuery, PAGE_SIZE } from './serverList';

const criteria = {
  filter: 'current' as const,
  dormitory: 3,
  scope: [1, 2],
  days: 14,
  query: '  Иванов  ',
  column_filters: [{ field: 'phone', operator: 'contains' as const, value: '+7' }],
};

describe('Условия страницы сотрудников', () => {
  it('переводит фильтры страницы в параметры запроса и не отправляет пустое', () => {
    const query = employeePageQuery(criteria, 2);
    expect(query).toEqual({
      filter: 'current',
      dormitory: 3,
      scope: [1, 2],
      days: 14,
      query: 'Иванов',
      column_filters: [{ field: 'phone', operator: 'contains', value: '+7' }],
      page: 3,
      per_page: PAGE_SIZE,
    });
    expect(PAGE_SIZE).toBe(20);
  });
  it('не отправляет фильтр общежития, когда выбраны все общежития', () => {
    const query = employeePageQuery({ ...criteria, dormitory: null, column_filters: [] }, 0);
    expect(query.dormitory).toBeNull();
    expect(query.column_filters).toBeUndefined();
    expect(query.page).toBe(1);
  });
});
