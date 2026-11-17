import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type {
  CellValue,
  ReportLink,
  HostelLink,
  HostelTableLink,
  ReportRow,
  TableColumn,
  TableKey,
  CustomTab,
  OutflowFields,
} from '../../api/client';
import { OutflowReasonInput } from './OutflowReasonInput';
import styles from './ReportTable.module.css';
import { customChain, customLabel, standardChain } from './tabStructure';
import { PlaceLinkEditor } from './PlaceLinkEditor';
import { EditorSection } from '../../components/EditorSection';

interface Source {
  key: string;
  name: string;
  tables: { key: TableKey; name: string }[];
  empty?: boolean;
}
const builtInSources: Source[] = [
  { key: 'arrival_plan', name: 'План заездов', tables: [] },
  { key: 'places', name: 'Размещение персонала', tables: [] },
  { key: 'residents', name: 'Проживающие', tables: [{ key: 'residents', name: 'Проживающие' }] },
  {
    key: 'movement',
    name: 'Движение персонала',
    tables: [
      { key: 'inflow', name: 'Приток' },
      { key: 'outflow', name: 'Отток' },
    ],
  },
  {
    key: 'payments',
    name: 'Выплаты',
    tables: [
      { key: 'advance', name: 'На аванс' },
      { key: 'settlement', name: 'На расчёт' },
    ],
  },
  { key: 'archive', name: 'Архив', tables: [{ key: 'archive', name: 'Архив' }] },
];

export function ReportLinkEditor({
  dormitoryId,
  disabled,
  ...props
}: {
  dormitoryId: string;
  disabled: boolean;
} & (
  | { hostel: true; initial: HostelLink | null; onChange: (link: HostelLink | null) => void }
  | { hostel?: false; initial: ReportLink | null; onChange: (link: ReportLink | null) => void }
)): JSX.Element {
  const initial = useRef(props.initial).current;
  const change = useRef(props.onChange);
  change.current = props.onChange;
  const sourceChanged = useRef(false);
  const hostel = props.hostel === true;
  const legacy = initial?.table_key === 'resident_occupancy' ? initial : null;
  const initialTable = initial && 'column_id' in initial ? initial : null;
  const initialHostel = initialTable as HostelTableLink | null;
  const [section, setSection] = useState(() =>
    legacy
      ? 'residents'
      : initial && !initialTable
        ? initial.table_key
        : initialTable?.table_key.startsWith('custom_')
          ? initialTable.table_key
          : (builtInSources.find((source) =>
              source.tables.some((table) => table.key === initialTable?.table_key),
            )?.key ?? ''),
  );
  const [table, setTable] = useState<TableKey | ''>(
    legacy ? 'residents' : (initialTable?.table_key ?? ''),
  );
  const [countMode, setCountMode] = useState(
    legacy ? 'snapshot' : (initialHostel?.count_mode ?? 'daily'),
  );
  const [scope, setScope] = useState<'dormitory' | 'hostel'>(
    legacy ? 'hostel' : (initialHostel?.scope ?? 'dormitory'),
  );
  const [reportRows, setReportRows] = useState<Pick<ReportRow, 'id' | 'name'>[]>([]);
  const [reportRowId, setReportRowId] = useState(
    initial?.table_key === 'report' ? initial.row_id : 0,
  );
  const [reportError, setReportError] = useState('');
  const [reportAttempt, setReportAttempt] = useState(0);
  const snapshot = hostel && table === 'residents' && countMode === 'snapshot';
  const [legacyFilter, setLegacyFilter] = useState(legacy?.gender ?? null);

  const onChange = useCallback(
    (next: ReportLink | HostelLink | null): void => {
      const handle = change.current;
      if (hostel) {
        (handle as (link: HostelLink | null) => void)(next?.table_key === 'places' ? null : next);
      } else if (next?.table_key !== 'report' && next?.table_key !== 'resident_occupancy') {
        (handle as (link: ReportLink | null) => void)(next);
      }
    },
    [hostel],
  );

  useEffect(() => {
    if (!hostel || section !== 'report') return;
    const controller = new AbortController();
    setReportError('');
    void api
      .hostelReportSources(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReportRows(result);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setReportError(
            caught instanceof ApiError
              ? caught.message
              : 'Не удалось загрузить строки общего отчёта.',
          );
        }
      });
    return () => controller.abort();
  }, [section, hostel, dormitoryId, reportAttempt]);
  const [tabs, setTabs] = useState<CustomTab[]>([]);
  const [tabsLoading, setTabsLoading] = useState(true);
  const [tabsError, setTabsError] = useState('');
  const [tabsAttempt, setTabsAttempt] = useState(0);
  const [sectionStates, setSectionStates] = useState<Record<string, string>>({});

  const [sourceParents, setSourceParents] = useState<Record<string, string | null>>({
    inflow: 'movement',
    outflow: 'movement',
    advance: 'payments',
    settlement: 'payments',
  });
  function customSourceKey(tab: CustomTab, tree: CustomTab[] = tabs): string {
    const chain = customChain(tab, tree);
    const section = chain[0].parent_section;
    if (section) {
      const root = standardChain(section, sourceParents)[0];
      return root === 'places' || root === 'report' ? tab.table_key : root;
    }
    return chain[0].table_key;
  }
  const standards = [
    ...builtInSources,
    ...builtInSources.flatMap((source) =>
      source.tables
        .filter((item) => !sourceParents[item.key])
        .map((item) => ({ key: item.key, name: item.name, tables: [item] })),
    ),
  ];
  const uniqueStandards = [
    ...standards,
    ...(hostel ? [{ key: 'report', name: 'Общий отчёт', tables: [] }] : []),
  ].filter((source, index) => standards.findIndex((entry) => entry.key === source.key) === index);
  const sources: Source[] = uniqueStandards
    .filter(
      (source) => sectionStates[source.key] !== 'deleted' && (!hostel || source.key !== 'places'),
    )
    .map((source) => ({
      ...source,
      name: sectionStates[source.key] === 'hidden' ? source.name + ' (скрыта)' : source.name,
      tables: [
        ...source.tables.filter(
          (item) =>
            sectionStates[item.key] !== 'deleted' &&
            standardChain(item.key, sourceParents)[0] === source.key,
        ),
        ...tabs
          .filter((tab) => tab.table_created && customSourceKey(tab) === source.key)
          .map((tab) => ({
            key: tab.table_key,
            name: customLabel(tab, tabs) + (tab.is_active ? '' : ' (скрыта)'),
          })),
      ],
    }));
  const customKeys = new Set(
    tabs.map((tab) => customSourceKey(tab)).filter((key) => key.startsWith('custom_')),
  );
  for (const key of customKeys) {
    const source = tabs.find((tab) => tab.table_key === key);
    if (!source) continue;
    const tables = tabs
      .filter((tab) => tab.table_created && customSourceKey(tab) === key)
      .map((tab) => ({
        key: tab.table_key,
        name: customLabel(tab, tabs) + (tab.is_active ? '' : ' (скрыта)'),
      }));
    sources.push({
      key,
      name:
        (source.parent_section ? customLabel(source, tabs) : source.name) +
        (source.is_active ? '' : ' (скрыта)'),
      tables,
      empty: !tables.length,
    });
  }
  const initialCustom = tabs.find((tab) => tab.table_key === initialTable?.table_key);
  const initialSourceKey = initialCustom
    ? customSourceKey(initialCustom)
    : initialTable?.table_key
      ? standardChain(initialTable.table_key, sourceParents)[0]
      : null;
  useEffect(() => {
    if (initialSourceKey && !sourceChanged.current) setSection(initialSourceKey);
  }, [initialSourceKey]);
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [outflowFields, setOutflowFields] = useState<OutflowFields | null>(null);
  const [columnId, setColumnId] = useState(initialTable?.column_id ?? 0);
  const [operator, setOperator] = useState<'equals' | 'not_empty'>(
    initialTable?.operator ?? 'equals',
  );
  const [value, setValue] = useState<CellValue>(
    initialTable?.value ?? (legacy?.gender !== 'all' ? (legacy?.gender ?? '') : ''),
  );
  const [dateId, setDateId] = useState<number | null>(initialTable?.date_column_id ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTabs([]);
    setTabsLoading(true);
    setTabsError('');
    void api
      .standardSections(dormitoryId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setSectionStates(Object.fromEntries(items.map((item) => [item.key, item.status])));
          setSourceParents(Object.fromEntries(items.map((item) => [item.key, item.parent_key])));
        }
      })
      .catch(() => {
        /* Existing source validation still handles unavailable sections. */
      });
    void api
      .customTabs(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setTabs(result);
          setTabsLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setTabsLoading(false);
          setTabsError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить вкладки.',
          );
        }
      });
    return () => controller.abort();
  }, [dormitoryId, tabsAttempt, initialTable?.table_key]);
  useEffect(() => {
    setColumns([]);
    setOutflowFields(null);
    setError('');
    if (!table) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      api.tableColumns(dormitoryId, table, controller.signal),
      table === 'outflow'
        ? api.outflowFields(dormitoryId, controller.signal)
        : Promise.resolve(null),
    ])
      .then(([result, outflow]) => {
        if (!controller.signal.aborted) {
          setColumns(result.filter((col) => !col.archived));
          setOutflowFields(outflow);
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить столбцы.');
          setLoading(false);
          change.current(null);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, table, attempt]);
  const source = sources.find((item) => item.key === section);
  const selectedColumnId =
    legacyFilter && legacyFilter !== 'all'
      ? (columns.find((item) => item.builtin_key === 'gender')?.id ?? 0)
      : columnId;
  const column = columns.find((item) => item.id === selectedColumnId);
  const dateColumn = columns.find((item) => item.id === dateId);
  function emit(
    nextColumn: number,
    nextValue: CellValue,
    nextDate: number | null,
    nextOperator: 'equals' | 'not_empty' = operator,
    nextMode = countMode,
    nextScope = scope,
  ): void {
    onChange(
      table &&
        nextColumn &&
        (nextOperator === 'not_empty' || (nextValue !== '' && nextValue !== null))
        ? {
            table_key: table,
            column_id: nextColumn,
            operator: nextOperator,
            value: nextOperator === 'not_empty' ? null : nextValue,
            date_column_id: nextMode === 'snapshot' ? null : nextDate,
            ...(hostel
              ? { count_mode: nextMode, scope: nextMode === 'snapshot' ? 'hostel' : nextScope }
              : {}),
          }
        : null,
    );
  }
  function selectTable(next: TableKey | ''): void {
    sourceChanged.current = true;
    setTable(next);
    setLegacyFilter(null);
    setCountMode(hostel && next === 'residents' ? 'snapshot' : 'daily');
    setScope(hostel && next === 'residents' ? 'hostel' : 'dormitory');
    setColumnId(0);
    setOperator('equals');
    setValue('');
    setDateId(null);
    onChange(null);
  }
  const readableValue =
    column?.kind === 'select'
      ? column.options.find((option) => option.id === value)?.label
      : typeof value === 'boolean'
        ? value
          ? 'Да'
          : 'Нет'
        : String(value ?? '');
  return (
    <fieldset disabled={disabled} className={styles.linkFields}>
      <legend>Связь с таблицей</legend>
      <EditorSection
        title="Источник записей"
        description="Раздел и, при необходимости, конкретная подвкладка."
      >
        <label className={styles.field}>
          {hostel ? 'Таблица-источник' : 'Раздел'}
          <select
            value={section}
            onChange={(event) => {
              const next = sources.find((item) => item.key === event.target.value);
              setSection(next?.key ?? '');
              selectTable(
                next?.tables.length === 1
                  ? next.tables[0].key
                  : hostel && next?.tables.some((item) => item.key === next.key)
                    ? (next.key as TableKey)
                    : '',
              );
              setReportRowId(0);
              if (next?.key === 'arrival_plan') onChange({ table_key: 'arrival_plan' });
            }}
          >
            <option value="">Выберите раздел</option>
            {!hostel && (
              <option value="report" disabled>
                Общий отчёт — связь через формулу
              </option>
            )}
            {sources.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name}
                {item.empty ? ' (таблица не создана)' : ''}
              </option>
            ))}
          </select>
        </label>
        {tabsLoading && <p role="status">Загружаем пользовательские вкладки…</p>}
        {tabsError && (
          <p role="alert" className={styles.formError}>
            {tabsError}{' '}
            <button
              className="link-button"
              type="button"
              onClick={() => setTabsAttempt((n) => n + 1)}
            >
              Повторить загрузку вкладок
            </button>
          </p>
        )}
        {source?.empty && <p>Сначала создайте таблицу во вкладке «{source.name}».</p>}
        {section === 'arrival_plan' && (
          <p className={styles.linkSummary}>
            Брать количество приезжающих из «Плана заездов» этого общежития за каждую дату отчёта.
            ФИО на расчёт не влияют.
          </p>
        )}
        {hostel && section === 'report' && (
          <label className={styles.field}>
            Строка общего отчёта
            <select
              value={reportRowId || ''}
              onChange={(event) => {
                const rowId = Number(event.target.value);
                setReportRowId(rowId);
                onChange(rowId ? { table_key: 'report', row_id: rowId } : null);
              }}
            >
              <option value="">Выберите строку</option>
              {reportRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {hostel && section === 'report' && reportError && (
          <p role="alert" className={styles.formError}>
            {reportError}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => setReportAttempt((n) => n + 1)}
            >
              Повторить
            </button>
          </p>
        )}
        {section === 'places' && (
          <PlaceLinkEditor
            dormitoryId={dormitoryId}
            initial={initial?.table_key === 'places' ? initial : null}
            onChange={onChange}
          />
        )}
        {source && source.tables.length > 1 && (
          <label className={styles.field}>
            Подвкладка
            <select
              value={table}
              onChange={(event) => selectTable(event.target.value as TableKey | '')}
            >
              <option value="">Выберите подвкладку</option>
              {source.tables.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {loading && <p role="status">Загружаем столбцы…</p>}
        {error && (
          <p role="alert" className={styles.formError}>
            {error}{' '}
            <button className="link-button" type="button" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </button>
          </p>
        )}
      </EditorSection>
      {table && !loading && !error && (
        <>
          {hostel && table === 'residents' && (
            <>
              <label className={styles.field}>
                Что считать за день
                <select
                  value={countMode}
                  onChange={(event) => {
                    const next = event.target.value as 'snapshot' | 'daily';
                    setCountMode(next);
                    setLegacyFilter(null);
                    setColumnId(selectedColumnId);
                    emit(selectedColumnId, value, dateId, operator, next);
                  }}
                >
                  <option value="snapshot">Состав на дату</option>
                  <option value="daily">Записи за день</option>
                </select>
              </label>
              {snapshot ? (
                <p className={styles.formulaHelp}>
                  Текущий хостел. Сегодня — текущий состав, за прошедшие дни — состав на конец дня.
                </p>
              ) : (
                <label className={styles.field}>
                  Где считать
                  <select
                    value={scope}
                    onChange={(event) => {
                      const next = event.target.value as 'dormitory' | 'hostel';
                      setScope(next);
                      emit(selectedColumnId, value, dateId, operator, countMode, next);
                    }}
                  >
                    <option value="hostel">Текущий хостел</option>
                    <option value="dormitory">Всё общежитие</option>
                  </select>
                </label>
              )}
            </>
          )}
          <EditorSection
            title="Какие записи учитывать"
            description="Выберите столбец и условие. Подходящая запись добавляет 1 к результату."
          >
            <label className={styles.field}>
              Столбец
              <select
                value={legacyFilter === 'all' ? 'all' : selectedColumnId || ''}
                onChange={(event) => {
                  if (event.target.value === 'all') {
                    setLegacyFilter('all');
                    onChange({ table_key: 'resident_occupancy', gender: 'all' });
                    return;
                  }
                  setLegacyFilter(null);
                  const next = Number(event.target.value);
                  const isDate = columns.find((item) => item.id === next)?.kind === 'date';
                  const nextOperator = isDate ? 'not_empty' : 'equals';
                  const nextDate = isDate ? next : null;
                  setColumnId(next);
                  setOperator(nextOperator);
                  setValue('');
                  setDateId(nextDate);
                  emit(next, '', nextDate, nextOperator);
                }}
              >
                <option value="">Выберите столбец</option>
                {snapshot && <option value="all">Все проживающие в хостеле</option>}
                {columns
                  .filter((col) => !['action', 'hostel'].includes(col.kind))
                  .map((col) => (
                    <option value={col.id} key={col.id}>
                      {col.name}
                    </option>
                  ))}
              </select>
            </label>
            {column && (
              <>
                <label className={styles.field}>
                  Условие подсчёта
                  <select
                    value={operator}
                    onChange={(event) => {
                      const next = event.target.value as 'equals' | 'not_empty';
                      const nextDate =
                        next === 'not_empty' && column.kind === 'date' ? selectedColumnId : dateId;
                      setOperator(next);
                      setDateId(nextDate);
                      emit(selectedColumnId, value, nextDate, next);
                    }}
                  >
                    <option value="equals">Равно выбранному значению</option>
                    <option value="not_empty">Заполнено — любое значение</option>
                  </select>
                </label>
                {operator === 'equals' && (
                  <label className={styles.field}>
                    Значение для подсчёта
                    {column.kind === 'text' && column.id === outflowFields?.reason_column?.id ? (
                      <OutflowReasonInput
                        label="Значение для подсчёта"
                        value={String(value ?? '')}
                        choices={outflowFields.reasons}
                        allowCustom
                        onChange={(next) => {
                          setValue(next);
                          emit(selectedColumnId, next, dateId);
                        }}
                      />
                    ) : column.kind === 'select' || column.kind === 'checkbox' ? (
                      <select
                        value={String(value)}
                        onChange={(event) => {
                          const next =
                            column.kind === 'checkbox' && event.target.value !== ''
                              ? event.target.value === 'true'
                              : event.target.value;
                          setValue(next);
                          emit(selectedColumnId, next, dateId);
                        }}
                      >
                        <option value="">Выберите значение</option>
                        {column.kind === 'checkbox' ? (
                          <>
                            <option value="true">Да — отмечено</option>
                            <option value="false">Нет — снято</option>
                          </>
                        ) : (
                          column.options
                            .filter((option) => !hostel || !option.archived || option.id === value)
                            .map((option) => (
                              <option key={option.id} value={option.id ?? ''}>
                                {option.label}
                                {option.archived ? ' (в архиве)' : ''}
                              </option>
                            ))
                        )}
                      </select>
                    ) : (
                      <input
                        value={String(value)}
                        type={
                          column.kind === 'date'
                            ? 'date'
                            : column.kind === 'number'
                              ? 'number'
                              : 'text'
                        }
                        step="any"
                        maxLength={5000}
                        onChange={(event) => {
                          setValue(event.target.value);
                          emit(selectedColumnId, event.target.value, dateId);
                        }}
                      />
                    )}
                  </label>
                )}
              </>
            )}
          </EditorSection>
          {column && !snapshot && (
            <EditorSection
              title="По какой дате считать"
              description="Выберите дату события или используйте дату создания записи."
            >
              <label className={styles.field}>
                Распределять по дате
                <select
                  value={dateId ?? ''}
                  onChange={(event) => {
                    const next = event.target.value ? Number(event.target.value) : null;
                    setDateId(next);
                    emit(selectedColumnId, value, next);
                  }}
                >
                  <option value="">Дата создания записи (Москва)</option>
                  {columns
                    .filter((col) => col.kind === 'date')
                    .map((col) => (
                      <option value={col.id} key={col.id}>
                        {col.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className={styles.formulaHelp}>
                Расчёт: количество записей. Одна подходящая запись добавляет 1 к своей дате. Записи
                без выбранной даты не учитываются.
              </p>
              {(operator === 'not_empty' || value !== '') && (
                <p className={styles.linkSummary}>
                  Считать записи: {source?.name}
                  {source && source.tables.length > 1
                    ? ` → ${source.tables.find((item) => item.key === table)?.name}`
                    : ''}
                  , где «{column.name}»
                  {operator === 'not_empty' ? ' заполнено' : ` = «${readableValue}»`}. По дате:{' '}
                  {dateColumn?.name ?? 'создания записи'}.
                </p>
              )}
            </EditorSection>
          )}
          {columns.every((col) => ['action', 'hostel'].includes(col.kind)) && (
            <p>Сначала добавьте столбец в выбранную таблицу.</p>
          )}
        </>
      )}
    </fieldset>
  );
}
