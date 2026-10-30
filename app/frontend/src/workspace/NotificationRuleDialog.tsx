import { useEffect, useState } from 'react';

import { api, ApiError } from '../api/client';
import type {
  NotificationRule,
  NotificationRuleCatalog,
  NotificationRuleCatalogTable,
  NotificationRuleCondition,
  NotificationRuleInput,
  NotificationRulePreview,
  RuleOperator,
  TableColumn,
  TableKey,
} from '../api/client';
import { Modal } from '../components/Modal';
import { NO_VALUE_OPERATORS, operatorLabel, rowsText } from './notificationRulesText';
import styles from './Workspace.module.css';

/** Потолок условий правила: больше четырёх человек не читает в списке. */
export const MAX_RULE_CONDITIONS = 4;

/** Потолок названия: название — это и есть текст сообщения в Telegram. */
export const MAX_RULE_NAME_LENGTH = 80;

/** Общий текст ошибки сохранения: технические подробности пользователю не нужны. */
export const RULE_SAVE_ERROR_TEXT = 'Не удалось сохранить правило. Проверьте соединение.';
export const RULE_PREVIEW_ERROR_TEXT = 'Не удалось проверить правило. Проверьте соединение.';

/** Подпись удалённой таблицы в селекторе: в каталоге её уже нет, а правило есть. */
export const DELETED_TABLE_LABEL = 'Таблица удалена';

/** Редактируемое условие: значение ещё не приведено к типу столбца сервером. */
interface DraftCondition {
  columnId: number;
  operator: RuleOperator;
  value: string | boolean;
}

function blankCondition(column?: { kind: string; operators: RuleOperator[] }): DraftCondition {
  return {
    columnId: 0,
    operator: column?.operators[0] ?? 'equals',
    value: column?.kind === 'checkbox' ? false : '',
  };
}

/** Сохранённое условие в черновик: чекбокс остаётся `bool`, остальное — строкой. */
function draftConditions(rule: NotificationRule | null): DraftCondition[] {
  if (!rule) return [];
  return rule.conditions.map((condition) => ({
    columnId: condition.column_id,
    operator: condition.operator,
    value: typeof condition.value === 'boolean' ? condition.value : String(condition.value ?? ''),
  }));
}

/**
 * Диалог правила: название → таблица → условия → предпросмотр сообщения.
 *
 * Сообщение собирает только сервер, поэтому превью — это ровно `text` из ответа
 * `POST .../preview`, показанный как есть; клиент его не склеивает и не
 * дополняет. Тексты отказов (`422`) берутся из `detail` дословно: по ним человек
 * правит условие, а не догадывается, что не так.
 *
 * Варианты списка условию нужны идентификаторами, а каталог отдаёт столбцы без
 * вариантов, поэтому подписи вариантов берутся из уже существующей ручки
 * столбцов таблицы. Она вспомогательная: если не ответила, значение вводится
 * текстом, а окончательную проверку всё равно делает сервер.
 */
export function NotificationRuleDialog({
  dormitoryId,
  dormitoryName,
  catalog,
  initial,
  onClose,
  onSaved,
}: {
  dormitoryId: number;
  dormitoryName: string;
  catalog: NotificationRuleCatalog;
  initial: NotificationRule | null;
  onClose: () => void;
  onSaved: (rule: NotificationRule) => void;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [tableKey, setTableKey] = useState<TableKey>(
    initial?.table_key ?? catalog.tables[0]?.key ?? ('' as TableKey),
  );
  const [conditions, setConditions] = useState<DraftCondition[]>(() => draftConditions(initial));
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [preview, setPreview] = useState<NotificationRulePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const table: NotificationRuleCatalogTable | undefined = catalog.tables.find(
    (item) => item.key === tableKey,
  );
  const tableTitle = table?.title ?? '';

  // Варианты списка для значения условия. Каталог их не отдаёт, поэтому читаем
  // столбцы таблицы; ошибка не закрывает диалог — сервер проверит значение сам.
  useEffect(() => {
    if (!tableKey) {
      setColumns([]);
      return undefined;
    }
    const controller = new AbortController();
    void api
      .tableColumns(String(dormitoryId), tableKey, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setColumns(items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setColumns([]);
      });
    return () => controller.abort();
  }, [dormitoryId, tableKey]);

  function change(next: {
    name?: string;
    tableKey?: TableKey;
    conditions?: DraftCondition[];
  }): void {
    if (next.name !== undefined) setName(next.name);
    if (next.tableKey !== undefined) setTableKey(next.tableKey);
    if (next.conditions !== undefined) setConditions(next.conditions);
    // Любая правка делает прежнее превью неправдой: проверять надо заново.
    setPreview(null);
    setError('');
  }

  function changeTable(key: string): void {
    // Условия другой таблицы ссылаются на её столбцы — переносить их нельзя.
    change({ tableKey: key as TableKey, conditions: [] });
  }

  function addCondition(): void {
    if (conditions.length >= MAX_RULE_CONDITIONS) return;
    change({ conditions: [...conditions, blankCondition()] });
  }

  function removeCondition(index: number): void {
    change({ conditions: conditions.filter((_, item) => item !== index) });
  }

  function changeColumn(index: number, columnId: number): void {
    const column = table?.columns.find((item) => item.id === columnId);
    change({
      conditions: conditions.map((condition, item) =>
        item === index
          ? {
              columnId,
              operator: column?.operators[0] ?? 'equals',
              value: column?.kind === 'checkbox' ? false : '',
            }
          : condition,
      ),
    });
  }

  function changeCondition(index: number, patch: Partial<DraftCondition>): void {
    change({
      conditions: conditions.map((condition, item) =>
        item === index ? { ...condition, ...patch } : condition,
      ),
    });
  }

  /** Условия в теле запроса: строка без выбранного столбца не уходит вовсе. */
  function payloadConditions(): NotificationRuleCondition[] {
    return conditions
      .filter((condition) => condition.columnId > 0)
      .map((condition) => ({
        column_id: condition.columnId,
        operator: condition.operator,
        value: NO_VALUE_OPERATORS.includes(condition.operator) ? null : condition.value,
      }));
  }

  function failureText(caught: unknown, fallback: string): string {
    return caught instanceof ApiError ? caught.message : fallback;
  }

  async function runPreview(): Promise<void> {
    if (previewing || saving) return;
    setError('');
    setPreviewing(true);
    try {
      setPreview(
        await api.previewNotificationRule(dormitoryId, {
          name,
          table_key: tableKey,
          conditions: payloadConditions(),
        }),
      );
    } catch (caught: unknown) {
      setPreview(null);
      setError(failureText(caught, RULE_PREVIEW_ERROR_TEXT));
    } finally {
      setPreviewing(false);
    }
  }

  async function save(): Promise<void> {
    if (saving) return;
    setError('');
    setSaving(true);
    const input: NotificationRuleInput = {
      name,
      table_key: tableKey,
      // PUT переписывает правило целиком, поэтому включённость переносим как была.
      is_enabled: initial?.is_enabled ?? true,
      conditions: payloadConditions(),
    };
    try {
      const saved = initial
        ? await api.updateNotificationRule(dormitoryId, initial.id, input)
        : await api.createNotificationRule(dormitoryId, input);
      onSaved(saved);
    } catch (caught: unknown) {
      setError(failureText(caught, RULE_SAVE_ERROR_TEXT));
    } finally {
      setSaving(false);
    }
  }

  const previewPlaceholder =
    preview === null
      ? 'Нажмите «Проверить», чтобы увидеть сообщение.'
      : 'Ни одна строка под правило не подходит.';

  return (
    <Modal
      title={initial ? `Правило «${initial.name}»` : 'Новое правило'}
      testId="telegram-rule-dialog"
      onClose={onClose}
      closeDisabled={saving}
      panelClassName={styles['rule-dialog-panel']}
    >
      <div className={styles['rule-dialog']}>
        <p className={styles['rule-dialog-subtitle']}>
          {dormitoryName}
          {tableTitle ? ` · ${tableTitle}` : ''}
        </p>

        <div className={styles['rule-dialog-body']}>
          <div className={styles['rule-dialog-form']}>
            <div className={styles['rule-dialog-grid']}>
              <label className={styles['rule-field']}>
                <span className={styles['rule-field-label']}>
                  Название правила
                  <span className={styles['rule-counter']}>
                    {name.length} из {MAX_RULE_NAME_LENGTH}
                  </span>
                </span>
                <input
                  className={styles['rule-control']}
                  type="text"
                  maxLength={MAX_RULE_NAME_LENGTH}
                  value={name}
                  data-testid="telegram-rule-name"
                  onChange={(event) => change({ name: event.target.value })}
                />
              </label>

              <label className={styles['rule-field']}>
                <span className={styles['rule-field-label']}>Таблица</span>
                <select
                  className={styles['rule-control']}
                  value={tableKey}
                  data-testid="telegram-rule-table"
                  onChange={(event) => changeTable(event.target.value)}
                >
                  {/* Удалённой таблицы в каталоге нет: без своего `option`
                      селектор выглядел бы пустым у сломанного правила, которое
                      человек как раз и пришёл починить. */}
                  {table === undefined && tableKey && (
                    <option value={tableKey}>{DELETED_TABLE_LABEL}</option>
                  )}
                  {catalog.tables.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <section aria-labelledby="rule-conditions-title">
              <div className={styles['rule-section-head']}>
                <h3 id="rule-conditions-title">Условия</h3>
                <span className={styles['rule-counter']} data-testid="telegram-rule-conditions">
                  {conditions.length} из {MAX_RULE_CONDITIONS}
                </span>
              </div>

              {conditions.map((condition, index) => {
                const column = table?.columns.find((item) => item.id === condition.columnId);
                const missing = condition.columnId > 0 && column === undefined;
                const operators = column?.operators ?? (['equals'] as RuleOperator[]);
                const operatorOptions = operators.includes(condition.operator)
                  ? operators
                  : [condition.operator, ...operators];
                const selectOptions =
                  column?.kind === 'select'
                    ? (columns.find((item) => item.id === column.id)?.options ?? [])
                    : [];
                return (
                  <div className={styles['rule-condition']} key={index}>
                    <select
                      className={`${styles['rule-control']} ${styles['rule-condition-column']}`}
                      value={condition.columnId || ''}
                      aria-label={`Столбец условия ${index + 1}`}
                      aria-invalid={missing ? true : undefined}
                      data-testid={`telegram-rule-condition-${index}-column`}
                      onChange={(event) => changeColumn(index, Number(event.target.value))}
                    >
                      <option value="">Выберите столбец</option>
                      {missing && <option value={condition.columnId}>Столбец удалён</option>}
                      {table?.columns.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>

                    <select
                      className={`${styles['rule-control']} ${styles['rule-condition-operator']}`}
                      value={condition.operator}
                      aria-label={`Оператор условия ${index + 1}`}
                      data-testid={`telegram-rule-condition-${index}-operator`}
                      onChange={(event) =>
                        changeCondition(index, { operator: event.target.value as RuleOperator })
                      }
                    >
                      {operatorOptions.map((operator) => (
                        <option key={operator} value={operator}>
                          {operatorLabel(operator)}
                        </option>
                      ))}
                    </select>

                    {!NO_VALUE_OPERATORS.includes(condition.operator) && (
                      <ConditionValue
                        index={index}
                        column={column}
                        selectOptions={selectOptions}
                        value={condition.value}
                        onChange={(value) => changeCondition(index, { value })}
                      />
                    )}

                    <button
                      className={styles['rule-condition-remove']}
                      type="button"
                      aria-label={`Удалить условие ${index + 1}`}
                      data-testid={`telegram-rule-condition-${index}-remove`}
                      onClick={() => removeCondition(index)}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

              <div className={styles['rule-condition-actions']}>
                <button
                  className="btn btn--ghost btn--compact"
                  type="button"
                  data-testid="telegram-rule-condition-add"
                  disabled={conditions.length >= MAX_RULE_CONDITIONS}
                  onClick={addCondition}
                >
                  Добавить условие
                </button>
                <span className={styles['rule-hint']}>
                  Условий не больше четырёх. Правило срабатывает, когда верны все условия сразу.
                </span>
              </div>
            </section>

            {error && (
              <p
                className={`alert alert--error ${styles['rule-hint']}`}
                role="alert"
                data-testid="telegram-rule-error"
              >
                {error}
              </p>
            )}
          </div>

          <aside className={styles['rule-preview']} aria-label="Превью сообщения">
            <div className={styles['rule-section-head']}>
              <h3>Сообщение в Telegram</h3>
            </div>

            {preview?.text ? (
              <div
                className={styles['rule-preview-message']}
                data-testid="telegram-rule-preview-text"
              >
                <p>{preview.text}</p>
              </div>
            ) : (
              <p className={styles['rule-preview-empty']} data-testid="telegram-rule-preview-text">
                {previewPlaceholder}
              </p>
            )}

            {preview && (
              <p className={styles['rule-hint']} role="status">
                {preview.text
                  ? `Под правило подходит ${rowsText(preview.matched)}.`
                  : 'Под правило не подходит ни одна строка.'}
              </p>
            )}
            <p className={styles['rule-hint']}>
              В сообщении только название правила — данные проживающих, даты и суммы в текст не
              подставляются. Собирает его сервер, поэтому здесь он ровно такой, каким придёт в
              Telegram.
            </p>
          </aside>
        </div>

        <div className={styles['rule-dialog-actions']}>
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            onClick={onClose}
            disabled={saving}
          >
            Отмена
          </button>
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            data-testid="telegram-rule-preview-button"
            aria-busy={previewing}
            disabled={previewing || saving}
            onClick={() => void runPreview()}
          >
            Проверить
          </button>
          <button
            className="btn btn--primary btn--compact"
            type="button"
            data-testid="telegram-rule-save"
            aria-busy={saving}
            disabled={saving}
            onClick={() => void save()}
          >
            Сохранить правило
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Контрол значения условия: вид зависит от типа столбца. */
function ConditionValue({
  index,
  column,
  selectOptions,
  value,
  onChange,
}: {
  index: number;
  column: NotificationRuleCatalogTable['columns'][number] | undefined;
  selectOptions: TableColumn['options'];
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}): JSX.Element | null {
  const testId = `telegram-rule-condition-${index}-value`;
  const className = `${styles['rule-control']} ${styles['rule-condition-value']}`;
  // Столбец ещё не выбран: показывать поле значения не для чего.
  if (!column) return null;
  if (column.kind === 'checkbox') {
    return (
      <select
        className={className}
        value={value === true || value === 'true' ? 'true' : 'false'}
        aria-label={`Значение условия ${index + 1}`}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value === 'true')}
      >
        <option value="true">Да</option>
        <option value="false">Нет</option>
      </select>
    );
  }
  if (column.kind === 'select' && selectOptions.length > 0) {
    return (
      <select
        className={className}
        value={String(value)}
        aria-label={`Значение условия ${index + 1}`}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Выберите значение</option>
        {selectOptions.map((option) => (
          <option key={option.id} value={option.id ?? ''}>
            {option.label}
            {option.archived ? ' (в архиве)' : ''}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className={className}
      type={column.kind === 'date' ? 'date' : column.kind === 'number' ? 'number' : 'text'}
      step={column.kind === 'number' ? 'any' : undefined}
      value={String(value)}
      aria-label={`Значение условия ${index + 1}`}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
