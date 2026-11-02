import type {
  NotificationRule,
  NotificationRuleCatalog,
  NotificationRuleCatalogColumn,
  NotificationRuleCondition,
  RuleOperator,
  TableColumn,
} from '../api/client';

/**
 * Подписи операторов условия.
 *
 * Коды операторов — часть контракта (`app/notification_rules.py`), подписи —
 * только для чтения. Набор допустимых операторов приходит каталогом по типу
 * столбца: клиент его не выводит и не сужает.
 */
export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: 'равно',
  not_equals: 'не равно',
  greater: 'больше',
  less: 'меньше',
  not_empty: 'заполнено',
  is_empty: 'не заполнено',
};

/** Операторы, у которых нет значения: в условии остаются столбец и оператор. */
export const NO_VALUE_OPERATORS: readonly RuleOperator[] = ['not_empty', 'is_empty'];

/** Подпись оператора. Незнакомый код показывается как есть, а не исчезает. */
export function operatorLabel(operator: string): string {
  return OPERATOR_LABELS[operator as RuleOperator] ?? operator;
}

/** `YYYY-MM-DD` → `ДД.ММ.ГГГГ`: так дату читает человек в макете. */
export function formatRuleDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

/**
 * Значение условия в читаемом виде.
 *
 * Условие хранит то, что принимает сервер: вариант списка — идентификатором,
 * чекбокс — `bool`, дата — ISO-строкой. Человеку нужны подпись варианта,
 * «Да/Нет» и дата в его формате.
 */
export function formatRuleValue(
  condition: NotificationRuleCondition,
  column: NotificationRuleCatalogColumn | undefined,
  tableColumns: TableColumn[] | undefined,
): string {
  const value = condition.value;
  if (value === null || value === undefined || value === '') return '';
  if (column?.kind === 'checkbox') return value === true || value === 'true' ? 'Да' : 'Нет';
  if (column?.kind === 'date' && typeof value === 'string') return formatRuleDate(value);
  if (column?.kind === 'select') {
    const option = tableColumns
      ?.find((item) => item.id === column.id)
      ?.options.find((item) => item.id === String(value));
    return option?.label ?? String(value);
  }
  return String(value);
}

/** Одно условие фразой: «Конец вахты меньше 01.12.2026», «Дата заселения заполнено». */
export function conditionText(
  condition: NotificationRuleCondition,
  column: NotificationRuleCatalogColumn | undefined,
  tableColumns: TableColumn[] | undefined,
): string {
  const name = column?.name ?? 'Столбец недоступен';
  const label = operatorLabel(condition.operator);
  if (NO_VALUE_OPERATORS.includes(condition.operator)) return `${name} ${label}`;
  const value = formatRuleValue(condition, column, tableColumns);
  return value ? `${name} ${label} ${value}` : `${name} ${label}`;
}

/**
 * Условия правила одной строкой через « · » — так их читает список правил.
 *
 * Таблицу и столбцы берём из каталога этого общежития: каталог уже загружен для
 * селектора, и второй запрос за именами не нужен. Столбец удалённого или
 * архивного вида в каталог не попадает — тогда остаётся «Столбец недоступен»,
 * а саму поломку показывает пометка `broken`.
 */
export function ruleConditionsText(
  rule: NotificationRule,
  catalog: NotificationRuleCatalog | null,
  columnsByTable: Record<string, TableColumn[]>,
): string {
  const table = catalog?.tables.find((item) => item.key === rule.table_key);
  const tableColumns = columnsByTable[rule.table_key];
  return rule.conditions
    .map((condition) =>
      conditionText(
        condition,
        table?.columns.find((column) => column.id === condition.column_id),
        tableColumns,
      ),
    )
    .join(' · ');
}

/** «1 строка», «2 строки», «12 строк»: число подходящих строк в превью. */
export function rowsText(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} строка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} строки`;
  return `${count} строк`;
}
