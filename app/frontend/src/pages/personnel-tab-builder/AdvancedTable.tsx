import { InlineBuilderCell } from './InlineBuilderCell';
import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { WorkingTable } from '../../components/WorkingTable';
import { useContext, useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { addDays, dateLabel, personName } from '../../workspace/personnel/helpers';
import { RecordEditor } from './RecordEditor';
import { downloadCsv } from './csv';
import { monthRange, tableDays } from './model';
import type { Column, PersonnelTab, RecordRow } from './model';
import s from './Tabs.module.css';
import { dependents, displayFormula, isComputed, referenceTargets, rowTitle } from './calculations';
import type { CellResult } from './calculationTypes';
import { RowCalculationDialog } from './RowCalculationDialog';
import { useCalculationEngine } from './useCalculationEngine';
import { useBuilderDraft } from './useBuilderDraft';

function sum(values: string[]): string {
  const numbers = values
    .filter((value) => /^[+-]?\d+(?:[.,]\d+)?$/.test(value.trim()))
    .map((value) => Number(value.replace(',', '.')));
  return numbers.length
    ? new Intl.NumberFormat('ru', { maximumFractionDigits: 6 }).format(
        numbers.reduce((total, value) => total + value, 0),
      )
    : '—';
}

export function TableContent({
  tab,
  tabs = [tab],
  data,
  onChange,
  onPerson,
  onCopy,
}: {
  tab: PersonnelTab;
  tabs?: PersonnelTab[];
  data: PersonnelData;
  onChange: (tab: PersonnelTab) => void;
  onPerson: (id: string) => void;
  onCopy: () => void;
}): JSX.Element {
  const environment = useContext(BuilderEnvironmentContext);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [removed, setRemoved] = useState<RecordRow[]>([]);
  const [clearing, setClearing] = useState(false);
  const [calculationRow, setCalculationRow] = useState<RecordRow | null>(null);
  useBuilderDraft(!!editing || !!calculationRow || clearing);
  const [error, setError] = useState('');
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const [range, setRange] = useState({ from: data.today, to: addDays(data.today, 6) });
  const options = tab.tableOptions;
  const calendar = options.table_format === 'calendar';
  const period = options.period_mode === 'month' ? monthRange(month) : range;
  const invalidPeriod =
    period.from > period.to ||
    !period.from ||
    !period.to ||
    (Date.parse(period.to) - Date.parse(period.from)) / 86400000 > 365;
  const dates = calendar && !invalidPeriod ? tableDays(period.from, period.to) : [];
  const allColumns = tab.columns.filter((column) => !column.archived);
  const columns = allColumns.filter((column) => options.show_dates || column.kind !== 'date');
  const engine = useCalculationEngine(tab, tabs, data, {
    range: options.period_mode === 'none' ? null : period,
  });
  const text = (result: CellResult): string =>
    result.pending
      ? '…'
      : result.error
        ? `Ошибка: ${result.error}`
        : typeof result.value === 'number'
          ? new Intl.NumberFormat('ru', { maximumFractionDigits: 6 }).format(result.value)
          : String(result.value ?? '');
  const dayText = (row: RecordRow, day: string): string => text(engine.day(tab, row, day));
  const dayTotal = (items: RecordRow[], days: string[]): string => {
    const values = items.flatMap((row) => days.map((day) => engine.day(tab, row, day)));
    if (values.some((value) => value.pending)) return '…';
    return values.some((value) => value.error)
      ? 'Ошибка расчёта'
      : sum(values.map((value) => String(value.value ?? '')));
  };
  const label = (row: RecordRow, column: Column): string => {
    if (calendar && column.id === columns[0]?.id && row.name) return row.name;
    const result = engine.column(tab, row, column.id);
    if (result.error || result.pending) return text(result);
    return column.kind === 'employee'
      ? personName(
          data.employees.find(
            (person) =>
              person.id === result.value || person.member_ids.includes(String(result.value)),
          ),
        )
      : column.kind === 'checkbox'
        ? result.value
          ? 'Да'
          : 'Нет'
        : column.kind === 'date'
          ? dateLabel(String(result.value ?? ''), true)
          : text(result);
  };
  const inPeriod = tab.rows.filter(
    (row) =>
      calendar ||
      options.period_mode === 'none' ||
      (!invalidPeriod &&
        String(engine.column(tab, row, tab.dateColumnId ?? '').value ?? '') >= period.from &&
        String(engine.column(tab, row, tab.dateColumnId ?? '').value ?? '') <= period.to),
  );
  const rows = inPeriod.filter(
    (row) =>
      !tab.actions.search ||
      !query ||
      allColumns.some((column) =>
        label(row, column).toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')),
      ),
  );
  const rowName = (row: RecordRow): string => rowTitle(tab, row, data);
  const errors = [
    ...new Set(
      rows.flatMap((row) =>
        [
          ...columns.map((column) => engine.column(tab, row, column.id)),
          ...dates.map((day) => engine.day(tab, row, day)),
        ]
          .filter((result) => result.error)
          .map((result) => `${rowName(row)}: ${result.error}`),
      ),
    ),
  ];
  const totalRows = rows.filter((row) => row.includeInTotals !== false);
  const calculating = tab.rows.some(
    (row) =>
      allColumns.some((column) => engine.column(tab, row, column.id).pending) ||
      dates.some((day) => engine.day(tab, row, day).pending),
  );
  function removeRow(row: RecordRow): void {
    const users = dependents(tabs, tab.id, 'row', row.id);
    if (users.length) {
      setError(
        `Строка используется в расчётах: ${users.join(', ')}. Сначала измените зависимости.`,
      );
      return;
    }
    setError('');
    onChange({ ...tab, rows: tab.rows.filter((item) => item.id !== row.id) });
    setRemoved([row]);
  }
  function shiftMonth(step: number): void {
    const [year, number] = month.split('-').map(Number);
    setMonth(new Date(Date.UTC(year, number - 1 + step, 1)).toISOString().slice(0, 7));
  }
  function updateDay(row: RecordRow, day: string, value: string): void {
    onChange({
      ...tab,
      rows: tab.rows.map((item) =>
        item.id === row.id ? { ...item, dayValues: { ...item.dayValues, [day]: value } } : item,
      ),
    });
  }
  function moveRow(row: RecordRow, index: number, step: number): void {
    const target = rows[index + step];
    if (!target) return;
    const next = [...tab.rows],
      sourceIndex = next.findIndex((item) => item.id === row.id),
      targetIndex = next.findIndex((item) => item.id === target.id);
    [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
    onChange({ ...tab, rows: next });
  }
  return (
    <>
      {options.period_mode !== 'none' && (
        <div className={s.periodBar} aria-label="Период таблицы">
          {options.period_mode === 'month' ? (
            <div className={s.buttons}>
              <button
                className="btn btn--ghost btn--compact"
                aria-label="Предыдущий месяц"
                onClick={() => shiftMonth(-1)}
              >
                ←
              </button>
              <label>
                Месяц
                <input
                  type="month"
                  aria-label="Месяц таблицы"
                  value={month}
                  onChange={(event) => {
                    if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value);
                  }}
                />
              </label>
              <button
                className="btn btn--ghost btn--compact"
                aria-label="Следующий месяц"
                onClick={() => shiftMonth(1)}
              >
                →
              </button>
              <button
                className="btn btn--quiet btn--compact"
                onClick={() => setMonth(data.today.slice(0, 7))}
              >
                Текущий месяц
              </button>
            </div>
          ) : (
            <div className={s.buttons}>
              <label>
                С даты
                <input
                  type="date"
                  aria-label="Период с"
                  value={range.from}
                  onChange={(event) => setRange({ ...range, from: event.target.value })}
                />
              </label>
              <label>
                По дату
                <input
                  type="date"
                  aria-label="Период по"
                  value={range.to}
                  onChange={(event) => setRange({ ...range, to: event.target.value })}
                />
              </label>
            </div>
          )}
          <small>
            {calendar
              ? 'Дневные значения относятся к своей дате. Строки сохраняются между месяцами.'
              : `Отбор по столбцу «${allColumns.find((column) => column.id === tab.dateColumnId)?.name ?? 'Дата'}». Записи без даты в период не попадают.`}
          </small>
        </div>
      )}
      {options.period_mode !== 'none' && invalidPeriod && (
        <p role="alert" className={s.error}>
          Выберите период от 1 до 366 дней; начальная дата должна быть не позже конечной.
        </p>
      )}
      <div className={s.toolbar}>
        <span className={s.muted}>
          Записей: {rows.length}
          {rows.length !== tab.rows.length ? ` из ${tab.rows.length}` : ''}
        </span>
        <div className={s.buttons}>
          {tab.actions.search && (
            <input
              value={query}
              aria-label="Поиск по таблице"
              placeholder="Поиск по таблице"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {tab.actions.export && (
            <button
              className="btn btn--ghost btn--compact"
              disabled={calculating}
              onClick={() =>
                downloadCsv(
                  tab.name,
                  [
                    ...columns.map((column) => column.name),
                    ...(calendar
                      ? [...dates.map((day) => dateLabel(day, true)), 'Итого за период']
                      : []),
                  ],
                  rows.map((row) => [
                    ...columns.map((column) => label(row, column)),
                    ...(calendar
                      ? [...dates.map((day) => dayText(row, day)), dayTotal([row], dates)]
                      : []),
                  ]),
                )
              }
            >
              Скачать CSV
            </button>
          )}
          <button className="btn btn--ghost btn--compact" onClick={onCopy}>
            Скопировать структуру
          </button>
          {calendar && options.add_row && (
            <button
              className="btn btn--outline btn--compact"
              onClick={() => setCalculationRow({ id: '', values: {} })}
            >
              + Добавить расчётную строку
            </button>
          )}
          {options.clear_list && (
            <button
              className="btn btn--ghost btn--compact"
              disabled={!tab.rows.length}
              onClick={() => setClearing(true)}
            >
              Очистить список
            </button>
          )}
          {options.add_row && (
            <button
              className="btn btn--primary btn--compact"
              onClick={() =>
                setEditing({
                  id: '',
                  values:
                    options.period_mode !== 'none' &&
                    !calendar &&
                    tab.dateColumnId &&
                    !invalidPeriod
                      ? { [tab.dateColumnId]: period.from }
                      : {},
                })
              }
            >
              + Добавить запись
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {errors.length > 0 && (
        <details className={s.calculationErrors}>
          <summary>Ошибки расчётов ({errors.length})</summary>
          {errors.map((message) => (
            <p key={message} className={s.error}>
              {message}
            </p>
          ))}
        </details>
      )}
      {removed.length > 0 && (
        <div className={s.selection} role="status">
          <span>
            {removed.length === 1
              ? 'Запись удалена.'
              : `Список очищен. Удалено записей: ${removed.length}.`}
          </span>
          <button
            className="btn btn--quiet btn--compact"
            onClick={() => {
              onChange({
                ...tab,
                rows: [
                  ...tab.rows,
                  ...removed.filter((row) => !tab.rows.some((item) => item.id === row.id)),
                ],
              });
              setRemoved([]);
            }}
          >
            Вернуть {removed.length === 1 ? 'запись' : 'список'}
          </button>
        </div>
      )}
      <div className={s.tableScroll}>
        <WorkingTable
          pasteCells
          revisionKey={`${tab.columns.map((column) => `${column.id}:${column.archived}`).join('|')}:${environment?.structureRevision ?? ''}`}
          columns={[
            ...columns.map((column) => ({ id: column.id, label: column.name, kind: column.kind })),
            ...dates.map((day) => ({ id: day, label: day, compact: true })),
            ...(calendar ? [{ id: '$total', label: 'Итого' }] : []),
            { id: '$actions', label: 'Действия' },
          ]}
          viewKey={environment ? `personnel/table-views/${tab.id}` : undefined}
          className={`${s.table} ${calendar ? s.calendarTable : ''}`}
          aria-label={tab.name}
        >
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.id}>
                  {column.name}
                  {isComputed(column.rule) && (
                    <sup
                      className="table-rule-mark"
                      title={column.rule?.mode === 'formula' ? 'Формула' : 'Связь с таблицей'}
                    >
                      {column.rule?.mode === 'formula' ? 'ƒ' : '↗'}
                    </sup>
                  )}
                </th>
              ))}
              {dates.map((day) => (
                <th key={day} data-today={day === data.today}>
                  <span>{Number(day.slice(-2))}</span>
                  <small>
                    {new Intl.DateTimeFormat('ru', { weekday: 'short', timeZone: 'UTC' }).format(
                      new Date(`${day}T00:00:00Z`),
                    )}
                  </small>
                </th>
              ))}
              {calendar && <th>Итого</th>}
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    data-error={!!engine.column(tab, row, column.id).error}
                    data-computed={isComputed(column.rule)}
                  >
                    {calendar && column.id === columns[0]?.id && row.name ? (
                      <>
                        <strong>
                          {row.name}
                          {isComputed(row.rule) && (
                            <sup
                              className="table-rule-mark"
                              title={row.rule?.mode === 'formula' ? 'Формула' : 'Связь с таблицей'}
                            >
                              {row.rule?.mode === 'formula' ? 'ƒ' : '↗'}
                            </sup>
                          )}
                        </strong>
                      </>
                    ) : isComputed(column.rule) ? (
                      <span
                        title={
                          column.rule?.mode === 'formula'
                            ? displayFormula(column.rule, referenceTargets(tab, 'column', data))
                            : 'Результат связи с источником'
                        }
                      >
                        {label(row, column) || '—'}
                      </span>
                    ) : (
                      <InlineBuilderCell
                        column={column}
                        value={row.values[column.id]}
                        label={`${column.name}, строка ${index + 1}`}
                        data={data}
                        onCommit={(value) =>
                          onChange({
                            ...tab,
                            rows: tab.rows.map((item) =>
                              item.id === row.id
                                ? { ...item, values: { ...item.values, [column.id]: value } }
                                : item,
                            ),
                          })
                        }
                      >
                        {column.kind === 'employee' && row.values[column.id] ? (
                          <button
                            className="link-button"
                            onClick={() => onPerson(String(row.values[column.id]))}
                          >
                            {label(row, column)}
                          </button>
                        ) : column.kind === 'checkbox' ? (
                          <span className={s.boolean} data-checked={!!row.values[column.id]}>
                            {row.values[column.id] ? '✓ Да' : 'Нет'}
                          </span>
                        ) : column.kind === 'select' && row.values[column.id] ? (
                          <span className="tag tag--neutral">{label(row, column)}</span>
                        ) : (
                          label(row, column) || '—'
                        )}
                      </InlineBuilderCell>
                    )}
                  </td>
                ))}
                {dates.map((day) => (
                  <td
                    key={day}
                    data-today={day === data.today}
                    data-computed={isComputed(row.rule)}
                    data-error={!!engine.day(tab, row, day).error}
                  >
                    {isComputed(row.rule) ? (
                      <span
                        aria-label={`${rowName(row)}, ${day}`}
                        title={
                          engine.day(tab, row, day).error ??
                          (row.rule?.mode === 'formula'
                            ? displayFormula(row.rule, referenceTargets(tab, 'row', data))
                            : 'Результат связи с источником')
                        }
                      >
                        {dayText(row, day) || '—'}
                      </span>
                    ) : (
                      <input
                        aria-label={`${rowName(row)}, ${day}`}
                        value={row.dayValues?.[day] ?? ''}
                        maxLength={2000}
                        onChange={(event) => updateDay(row, day, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                      />
                    )}
                  </td>
                ))}
                {calendar && (
                  <td>
                    <strong>{dayTotal([row], dates)}</strong>
                  </td>
                )}
                <td>
                  <div className={s.buttons}>
                    <button
                      className="btn btn--quiet btn--compact"
                      aria-label={`Изменить запись ${tab.rows.indexOf(row) + 1}`}
                      onClick={() =>
                        isComputed(row.rule) ? setCalculationRow(row) : setEditing(row)
                      }
                    >
                      Изменить
                    </button>
                    {calendar && !isComputed(row.rule) && (
                      <button
                        className="btn btn--quiet btn--compact"
                        aria-label={`Настроить строку ${rowName(row)}`}
                        onClick={() => setCalculationRow(row)}
                      >
                        Правило и итоги
                      </button>
                    )}
                    {options.row_actions && (
                      <>
                        <button
                          className="btn btn--quiet btn--compact"
                          aria-label={`Поднять запись ${tab.rows.indexOf(row) + 1}`}
                          disabled={!index}
                          onClick={() => moveRow(row, index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="btn btn--quiet btn--compact"
                          aria-label={`Опустить запись ${tab.rows.indexOf(row) + 1}`}
                          disabled={index === rows.length - 1}
                          onClick={() => moveRow(row, index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="btn btn--quiet btn--compact"
                          aria-label={`Дублировать запись ${tab.rows.indexOf(row) + 1}`}
                          onClick={() =>
                            onChange({
                              ...tab,
                              rows: [
                                ...tab.rows,
                                {
                                  ...structuredClone(row),
                                  id: crypto.randomUUID(),
                                  ...(row.name ? { name: `${row.name} — копия` } : {}),
                                },
                              ],
                            })
                          }
                        >
                          Дублировать
                        </button>
                        <button
                          className="btn btn--quiet btn--compact"
                          aria-label={`Удалить запись ${tab.rows.indexOf(row) + 1}`}
                          onClick={() => removeRow(row)}
                        >
                          Удалить
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {calendar && rows.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((column, index) => (
                  <th key={column.id}>{!index ? 'Итого за день' : ''}</th>
                ))}
                {dates.map((day) => (
                  <td key={day}>{dayTotal(totalRows, [day])}</td>
                ))}
                <td>{dayTotal(totalRows, dates)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </WorkingTable>
        {!rows.length && (
          <div className={s.empty}>
            <strong>
              {tab.rows.length
                ? 'По выбранным условиям записей нет'
                : 'Таблица готова к заполнению'}
            </strong>
            <p>
              {tab.rows.length
                ? 'Измените поиск или период. Записи за другие даты сохранены.'
                : 'Столбцы уже настроены. Добавьте первую запись.'}
            </p>
          </div>
        )}
      </div>
      {calendar && (
        <p className={s.pageFoot}>
          Ручные ячейки принимают числа и текстовые отметки. Формулы и связи пересчитываются
          автоматически. В общий итог входят выбранные в настройках строки; текстовые отметки в
          ручных строках пропускаются.
        </p>
      )}
      {editing && (
        <RecordEditor
          key={editing.id || 'new'}
          row={editing}
          columns={allColumns.filter((column) => !isComputed(column.rule))}
          data={data}
          onClose={() => setEditing(null)}
          onSave={(row) => {
            onChange({
              ...tab,
              rows: editing.id
                ? tab.rows.map((item) =>
                    item.id === row.id
                      ? { ...item, ...row, ...(item.name && calendar ? { name: undefined } : {}) }
                      : item,
                  )
                : [...tab.rows, row],
            });
            setEditing(null);
          }}
        />
      )}
      {calculationRow && (
        <RowCalculationDialog
          tab={tab}
          tabs={tabs}
          row={calculationRow}
          data={data}
          onClose={() => setCalculationRow(null)}
          onSave={(row) => {
            onChange({
              ...tab,
              rows: calculationRow.id
                ? tab.rows.map((item) => (item.id === row.id ? row : item))
                : [...tab.rows, row],
            });
            setCalculationRow(null);
          }}
        />
      )}
      {clearing && (
        <Modal
          title="Очистить список?"
          testId="clear-personnel-table"
          onClose={() => setClearing(false)}
        >
          <p>
            Будут убраны все {tab.rows.length} записей таблицы «{tab.name}» за всё время, включая
            записи вне выбранного периода и поиска, вместе с дневными значениями. Столбцы и
            настройки сохранятся.
          </p>
          <div className="dialog-actions">
            <ModalCancelButton
              className="btn btn--ghost btn--compact"
              onClick={() => setClearing(false)}
            >
              Отмена
            </ModalCancelButton>
            <button
              className="btn btn--danger btn--compact"
              onClick={() => {
                const users = [
                  ...new Set(
                    tab.rows
                      .flatMap((row) => dependents(tabs, tab.id, 'row', row.id))
                      .filter((name) => !name.startsWith(`${tab.name} → `)),
                  ),
                ];
                if (users.length) {
                  setError(`Нельзя очистить список: строки используются в ${users.join(', ')}.`);
                  setClearing(false);
                  return;
                }
                setRemoved(structuredClone(tab.rows));
                onChange({ ...tab, rows: [] });
                setClearing(false);
              }}
            >
              Очистить весь список
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
