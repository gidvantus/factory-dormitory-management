import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import type { PersonnelTab } from './model';
import type { CalculationRule, CellResult, LinkRule, ReferenceTarget } from './calculationTypes';
import { operations } from './calculationTypes';
import { bindFormula, calculationSources, displayFormula } from './calculations';
import { personName } from '../../workspace/personnel/helpers';
import s from './Tabs.module.css';
import { BuilderEnvironmentContext } from './BuilderEnvironment';

export function CalculationFields({
  rule,
  targets,
  currentId,
  tab,
  tabs,
  data,
  axis,
  onChange,
  onPreview,
}: {
  rule: CalculationRule;
  targets: ReferenceTarget[];
  currentId: string;
  tab: PersonnelTab;
  tabs: PersonnelTab[];
  data: PersonnelData;
  axis: 'column' | 'row';
  onChange: (rule: CalculationRule) => void;
  onPreview: () => CellResult | Promise<CellResult>;
}): JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pendingCursor = useRef<number | null>(null);
  const [preview, setPreview] = useState<CellResult | null>(null);
  const [checking, setChecking] = useState(false);
  const requestId = useRef(0);
  const environment = useContext(BuilderEnvironmentContext);
  const sources = calculationSources(tabs, data, environment?.sources).filter(
    (source) => source.id !== `tab:${tab.id}`,
  );
  const source = sources.find((source) => source.id === rule.link?.sourceId);
  const expression = displayFormula(rule, targets);
  useLayoutEffect(() => {
    if (pendingCursor.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = null;
  }, [expression]);
  const change = (value: CalculationRule): void => {
    requestId.current++;
    setChecking(false);
    setPreview(null);
    onChange(value);
  };
  const linkPatch = (value: Partial<LinkRule>): void => {
    if (rule.link) change({ ...rule, link: { ...rule.link, ...value } });
  };
  function selectSource(id: string): void {
    const selected = sources.find((source) => source.id === id);
    const field = selected?.fields.find((field) => field.kind === 'number');
    change({
      ...rule,
      mode: 'link',
      link: {
        sourceId: id,
        operation: field ? 'sum' : 'count',
        valueField: field?.id ?? '',
        sourceRowId: selected?.rows?.[0]?.id ?? null,
        match: null,
        filters: [],
        dateField: selected?.fields.find((field) => field.kind === 'date')?.id ?? null,
        empty: 'zero',
      },
    });
  }
  function insert(text: string): void {
    const start = selection.current?.start ?? expression.length;
    const end = selection.current?.end ?? start;
    const next = expression.slice(0, start) + text + expression.slice(end);
    pendingCursor.current = start + text.length;
    selection.current = { start: start + text.length, end: start + text.length };
    change({ ...rule, expression: next, refs: bindFormula(next, targets) });
  }
  return (
    <div className={s.calculationFields}>
      <label>
        Получение значения
        <select
          value={rule.mode}
          onChange={(event) =>
            change({ ...rule, mode: event.target.value as CalculationRule['mode'] })
          }
        >
          <option value="manual">Ручной ввод</option>
          <option value="formula">Формула</option>
          <option value="link">Связь с данными</option>
        </select>
      </label>
      {rule.mode === 'manual' && (
        <small className={s.muted}>Значения заполняются в таблице вручную.</small>
      )}
      {rule.mode === 'formula' && (
        <>
          <label>
            Формула
            <textarea
              ref={input}
              rows={3}
              maxLength={1000}
              value={expression}
              placeholder="=([Часы]*[Ставка])+[Доплата]"
              onSelect={(event) => {
                selection.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
              }}
              onChange={(event) =>
                change({
                  ...rule,
                  expression: event.target.value,
                  refs: bindFormula(event.target.value, targets),
                })
              }
            />
          </label>
          <div className={s.buttons} aria-label="Вставить действие">
            {['+', '−', '×', '÷', '(', ')'].map((symbol, index) => (
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                key={symbol}
                onClick={() => insert(['+', '-', '*', '/', '(', ')'][index])}
              >
                {symbol}
              </button>
            ))}
          </div>
          <div className={s.buttons} aria-label="Вставить ссылку">
            {targets
              .filter((target) => target.id !== currentId)
              .map((target) => (
                <button
                  type="button"
                  key={target.id}
                  className="btn btn--outline btn--compact"
                  onClick={() => insert(`[${target.name}]`)}
                >
                  {target.name || 'Без названия'}
                </button>
              ))}
          </div>
          <small className={s.muted}>
            Начните с =. Можно использовать несколько действий и скобки. Ссылки на{' '}
            {axis === 'column'
              ? 'столбцы берут значения этой записи'
              : 'строки берут значения за тот же день'}
            . Пустое значение считается нулём, текстовая отметка вызывает ошибку.
          </small>
        </>
      )}
      {rule.mode === 'link' && (
        <>
          <label>
            Источник данных
            <select
              value={rule.link?.sourceId ?? ''}
              onChange={(event) => selectSource(event.target.value)}
            >
              <option value="">Выберите источник</option>
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {source && rule.link && (
            <>
              {source.rows && (
                <label>
                  Строка источника
                  <select
                    value={rule.link.sourceRowId ?? ''}
                    onChange={(event) => linkPatch({ sourceRowId: event.target.value })}
                  >
                    <option value="">Выберите строку</option>
                    {source.rows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className={s.twoFields}>
                <label>
                  Как получить значение
                  <select
                    value={rule.link.operation}
                    onChange={(event) =>
                      linkPatch({ operation: event.target.value as LinkRule['operation'] })
                    }
                  >
                    {Object.entries(operations).map(([value, name]) => (
                      <option key={value} value={value}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {rule.link.operation !== 'count' && (
                  <label>
                    Столбец источника
                    <select
                      value={rule.link.valueField}
                      onChange={(event) => linkPatch({ valueField: event.target.value })}
                    >
                      <option value="">Выберите столбец</option>
                      {source.fields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {axis === 'column' && (
                <>
                  <label className={s.check}>
                    <input
                      type="checkbox"
                      checked={!!rule.link.match}
                      onChange={(event) =>
                        linkPatch({
                          match: event.target.checked
                            ? {
                                localColumnId:
                                  tab.columns.find((column) => column.kind === 'employee')?.id ??
                                  targets.find((target) => target.id !== currentId)?.id ??
                                  '',
                                sourceField:
                                  source.fields.find((field) => field.kind === 'employee')?.id ??
                                  source.fields[0]?.id ??
                                  '',
                              }
                            : null,
                        })
                      }
                    />
                    Сопоставлять с текущей записью
                  </label>
                  {rule.link.match && (
                    <div className={s.twoFields}>
                      <label>
                        Столбец этой записи
                        <select
                          value={rule.link.match.localColumnId}
                          onChange={(event) =>
                            linkPatch({
                              match: { ...rule.link!.match!, localColumnId: event.target.value },
                            })
                          }
                        >
                          <option value="">Выберите столбец</option>
                          {targets
                            .filter((target) => target.id !== currentId)
                            .map((target) => (
                              <option key={target.id} value={target.id}>
                                {target.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Совпадает со столбцом источника
                        <select
                          value={rule.link.match.sourceField}
                          onChange={(event) =>
                            linkPatch({
                              match: { ...rule.link!.match!, sourceField: event.target.value },
                            })
                          }
                        >
                          {source.fields.map((field) => (
                            <option key={field.id} value={field.id}>
                              {field.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </>
              )}
              <fieldset className={s.column}>
                <legend>Условия отбора</legend>
                <small className={s.muted}>
                  Все условия применяются одновременно. Без условий используются все записи
                  источника.
                </small>
                {rule.link.filters.map((filter, index) => {
                  const field = source.fields.find((field) => field.id === filter.field);
                  const patchFilter = (value: Partial<typeof filter>): void =>
                    linkPatch({
                      filters: rule.link!.filters.map((item, i) =>
                        i === index ? { ...item, ...value } : item,
                      ),
                    });
                  return (
                    <div key={index} className={s.filterRule}>
                      <label>
                        Поле условия {index + 1}
                        <select
                          value={filter.field}
                          onChange={(event) =>
                            patchFilter({ field: event.target.value, value: '' })
                          }
                        >
                          {source.fields.map((field) => (
                            <option value={field.id} key={field.id}>
                              {field.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Условие {index + 1}
                        <select
                          value={filter.operator}
                          onChange={(event) =>
                            patchFilter({ operator: event.target.value as typeof filter.operator })
                          }
                        >
                          <option value="equals">Равно</option>
                          <option value="contains">Содержит</option>
                          <option value="not_empty">Заполнено</option>
                          <option value="empty">Не заполнено</option>
                          <option value="from">Не меньше / с даты</option>
                          <option value="to">Не больше / по дату</option>
                        </select>
                      </label>
                      {!['empty', 'not_empty'].includes(filter.operator) && (
                        <label>
                          Значение условия {index + 1}
                          {field?.kind === 'employee' ? (
                            <select
                              value={filter.value}
                              onChange={(event) => patchFilter({ value: event.target.value })}
                            >
                              <option value="">Выберите сотрудника</option>
                              {data.employees.map((person) => (
                                <option key={person.id} value={person.id}>
                                  {personName(person)}
                                </option>
                              ))}
                            </select>
                          ) : field?.options?.length || field?.kind === 'checkbox' ? (
                            <select
                              value={filter.value}
                              onChange={(event) => patchFilter({ value: event.target.value })}
                            >
                              <option value="">Выберите значение</option>
                              {(field.options?.length ? field.options : ['true', 'false']).map(
                                (value) => (
                                  <option key={value} value={value}>
                                    {value === 'true' ? 'Да' : value === 'false' ? 'Нет' : value}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : (
                            <input
                              type={
                                field?.kind === 'date'
                                  ? 'date'
                                  : field?.kind === 'number'
                                    ? 'number'
                                    : 'text'
                              }
                              step="any"
                              value={filter.value}
                              onChange={(event) => patchFilter({ value: event.target.value })}
                            />
                          )}
                        </label>
                      )}
                      <button
                        type="button"
                        className="btn btn--quiet btn--compact"
                        aria-label={`Удалить условие ${index + 1}`}
                        onClick={() =>
                          linkPatch({ filters: rule.link!.filters.filter((_, i) => i !== index) })
                        }
                      >
                        Убрать
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="btn btn--outline btn--compact"
                  disabled={rule.link.filters.length >= 10}
                  onClick={() =>
                    linkPatch({
                      filters: [
                        ...rule.link!.filters,
                        { field: source.fields[0]?.id ?? '', operator: 'equals', value: '' },
                      ],
                    })
                  }
                >
                  + Добавить условие
                </button>
              </fieldset>
              <div className={s.twoFields}>
                <label>
                  Отбор по дате
                  <select
                    value={rule.link.dateField ?? ''}
                    onChange={(event) => linkPatch({ dateField: event.target.value || null })}
                  >
                    <option value="">Без отбора по дате</option>
                    {source.fields
                      .filter((field) => field.kind === 'date')
                      .map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Если данных нет
                  <select
                    value={rule.link.empty}
                    onChange={(event) =>
                      linkPatch({ empty: event.target.value as LinkRule['empty'] })
                    }
                  >
                    <option value="zero">Показать 0</option>
                    <option value="blank">Оставить пустым</option>
                    <option value="error">Показать ошибку</option>
                  </select>
                </label>
              </div>
              <small className={s.muted}>
                {axis === 'row'
                  ? 'Дата источника сопоставляется с днём ячейки.'
                  : 'Дата источника ограничивается выбранным периодом таблицы.'}{' '}
                Количество записей при отсутствии данных равно 0. Для «Одно значение» должна найтись
                ровно одна запись.
              </small>
            </>
          )}
        </>
      )}
      {rule.mode !== 'manual' && (
        <div className={s.previewCalculation}>
          <button
            type="button"
            className="btn btn--outline btn--compact"
            disabled={checking}
            onClick={async () => {
              const id = ++requestId.current;
              setChecking(true);
              try {
                const result = await onPreview();
                if (id === requestId.current) setPreview(result);
              } catch (error) {
                if (id === requestId.current)
                  setPreview({
                    value: null,
                    error: error instanceof Error ? error.message : 'Не удалось проверить расчёт',
                  });
              } finally {
                if (id === requestId.current) setChecking(false);
              }
            }}
          >
            Проверить расчёт
          </button>
          {preview && (
            <output
              role={preview.error ? 'alert' : 'status'}
              className={preview.error ? s.error : s.result}
            >
              {preview.error ?? `Результат: ${String(preview.value ?? 'пусто')}`}
            </output>
          )}
        </div>
      )}
    </div>
  );
}
