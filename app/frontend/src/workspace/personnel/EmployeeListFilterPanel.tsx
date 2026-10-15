import type { EmployeeColumnFilter, PersonnelData } from '../../api/personnel';
import type { EmployeeListField, ListCriteria } from './employeeListFilters';
import { employeeFieldOptions } from './employeeListFilters';
import styles from './EmployeeList.module.css';

const operatorNames = {
  contains: 'Содержит',
  equals: 'Равно',
  empty: 'Не заполнено',
  filled: 'Заполнено',
  from: 'Не меньше',
  to: 'Не больше',
};
export function EmployeeListFilters({
  data,
  criteria,
  fields,
  onChange,
}: {
  data: PersonnelData;
  criteria: ListCriteria;
  fields: EmployeeListField[];
  onChange: (rules: EmployeeColumnFilter[]) => void;
}): JSX.Element {
  const rules = criteria.column_filters ?? [];
  function change(index: number, next: EmployeeColumnFilter): void {
    onChange(rules.map((rule, i) => (i === index ? next : rule)));
  }
  return (
    <section className={styles.filters} aria-label="Фильтры по столбцам">
      <div className={styles.filterHeading}>
        <strong>Фильтры по столбцам</strong>
        <button
          type="button"
          disabled={rules.length >= 10}
          onClick={() =>
            onChange([...rules, { field: 'residence_status', operator: 'equals', value: '' }])
          }
        >
          + Добавить фильтр
        </button>
        {!!rules.length && (
          <button type="button" onClick={() => onChange([])}>
            Сбросить условия
          </button>
        )}
      </div>
      {rules.map((rule, index) => {
        const field = fields.find((item) => item.id === rule.field);
        const categorical = field?.kind === 'select' || field?.kind === 'checkbox';
        const operators =
          field?.kind === 'date' || field?.kind === 'number'
            ? (['equals', 'from', 'to', 'empty', 'filled'] as const)
            : categorical
              ? (['equals', 'empty', 'filled'] as const)
              : (['contains', 'equals', 'empty', 'filled'] as const);
        const options = field ? employeeFieldOptions(field, data, criteria) : [];
        const noValue = rule.operator === 'empty' || rule.operator === 'filled';
        return (
          <div className={styles.filterRow} key={index}>
            <label>
              Столбец
              <select
                aria-label={`Столбец фильтра ${index + 1}`}
                value={rule.field}
                onChange={(event) => {
                  const nextField = fields.find((item) => item.id === event.target.value)!;
                  change(index, {
                    field: nextField.id,
                    operator: nextField.kind === 'text' ? 'contains' : 'equals',
                    value: '',
                  });
                }}
              >
                {!field && <option value={rule.field}>Столбец недоступен — выберите другой</option>}
                <optgroup label="Список сотрудников">
                  {fields
                    .filter((item) => !item.table)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Столбцы таблиц общежитий">
                  {fields
                    .filter((item) => item.table)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <label>
              Условие
              <select
                aria-label={`Условие фильтра ${index + 1}`}
                value={rule.operator}
                onChange={(event) =>
                  change(index, {
                    ...rule,
                    operator: event.target.value as EmployeeColumnFilter['operator'],
                  })
                }
              >
                {operators.map((operator) => (
                  <option key={operator} value={operator}>
                    {field?.kind === 'date' && operator === 'from'
                      ? 'Не раньше'
                      : field?.kind === 'date' && operator === 'to'
                        ? 'Не позже'
                        : operatorNames[operator]}
                  </option>
                ))}
              </select>
            </label>
            {!noValue && (
              <label>
                Значение
                {categorical ? (
                  <select
                    aria-label={`Значение фильтра ${index + 1}`}
                    value={rule.value}
                    onChange={(event) => change(index, { ...rule, value: event.target.value })}
                  >
                    <option value="">Выберите значение</option>
                    {!!rule.value && !options.includes(rule.value) && (
                      <option value={rule.value}>{rule.value}</option>
                    )}
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      aria-label={`Значение фильтра ${index + 1}`}
                      type={
                        field?.kind === 'date'
                          ? 'date'
                          : field?.kind === 'number'
                            ? 'number'
                            : 'text'
                      }
                      step={field?.kind === 'number' ? 'any' : undefined}
                      maxLength={255}
                      list={field?.kind === 'text' ? `employee-filter-values-${index}` : undefined}
                      value={rule.value}
                      onChange={(event) => change(index, { ...rule, value: event.target.value })}
                    />
                    {field?.kind === 'text' && (
                      <datalist id={`employee-filter-values-${index}`}>
                        {options.slice(0, 100).map((option) => (
                          <option key={option} value={option} />
                        ))}
                      </datalist>
                    )}
                  </>
                )}
              </label>
            )}
            <button
              type="button"
              className={styles.remove}
              aria-label={`Удалить фильтр ${index + 1}`}
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        );
      })}
      {!!rules.length && (
        <p className={styles.hint}>
          Все условия действуют одновременно. Столбцы таблиц учитывают записи выбранных общежитий;
          условия одной таблицы проверяются в одной записи сотрудника.
        </p>
      )}
    </section>
  );
}
