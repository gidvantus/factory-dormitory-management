import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { CellValue, PlaceMetric, TableColumn, TableKey } from '../../api/client';
import type {
  CatalogDormitory,
  CatalogSource,
  DashboardLayout,
  WidgetConfig,
  WidgetDefinition,
  WidgetResult,
  WidgetSource,
} from '../../api/dashboardBlocks';
import { Modal } from '../../components/Modal';
import type { DateRange } from './dates';
import { formatCount } from './data';
import { WidgetChart } from './WidgetChart';
import styles from './WidgetDialog.module.css';

const METRICS: { key: PlaceMetric; name: string }[] = [
  { key: 'paid_total', name: 'Оплачено мест — всего' },
  { key: 'paid_m', name: 'Оплачено мест М' },
  { key: 'paid_f', name: 'Оплачено мест Ж' },
  { key: 'residents_total', name: 'Проживает — всего' },
  { key: 'residents_m', name: 'Проживает М' },
  { key: 'residents_f', name: 'Проживает Ж' },
  { key: 'free_total', name: 'Свободно мест — всего' },
  { key: 'free_m', name: 'Свободно мест М' },
  { key: 'free_f', name: 'Свободно мест Ж' },
];
const EMPTY: WidgetConfig = {
  name: '',
  display: 'number',
  source_kind: 'report',
  operation: 'sum',
  period: 'snapshot',
  grouping: 'dormitory',
  all_dormitories: true,
  excluded_dormitory_ids: [],
  sources: [],
};
const normalized = (text: string): string =>
  text.toLocaleLowerCase('ru').replaceAll('ё', 'е').replaceAll(' (скрыта)', '').trim();
function unique<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}
function blankSource(dorm: CatalogDormitory, kind: WidgetSource['kind']): WidgetSource {
  if (kind === 'report') return { kind, dormitory_id: dorm.id, row_id: 0 };
  if (kind === 'places')
    return { kind, dormitory_id: dorm.id, metric: 'paid_total', hostel_id: null };
  return {
    kind,
    dormitory_id: dorm.id,
    table_key: (dorm.sources.find((item) => item.kind === 'table')?.key ?? '') as TableKey,
    value_column_id: null,
    date_column_id: null,
    group_column_id: null,
    filter: null,
  };
}
function sourceMetadata(dorm: CatalogDormitory, source: WidgetSource): CatalogSource | undefined {
  return dorm.sources.find(
    (item) => item.key === (source.kind === 'table' ? source.table_key : source.kind),
  );
}
function validSource(
  dorm: CatalogDormitory,
  source: WidgetSource | undefined,
  config: WidgetConfig,
): boolean {
  if (!source) return false;
  const metadata = sourceMetadata(dorm, source);
  if (!metadata) return false;
  if (source.kind === 'report') return metadata.rows.some((row) => row.id === source.row_id);
  if (source.kind === 'places')
    return (
      source.hostel_id === null || metadata.hostels.some((item) => item.id === source.hostel_id)
    );
  const has = (id: number | null, kind?: string): boolean =>
    metadata.columns.some((col) => col.id === id && (!kind || col.kind === kind));
  if (config.operation === 'sum' && !has(source.value_column_id, 'number')) return false;
  if (source.date_column_id !== null && !has(source.date_column_id, 'date')) return false;
  if (config.grouping === 'value' && !has(source.group_column_id)) return false;
  if (source.filter) {
    const filter = source.filter,
      col = metadata.columns.find((item) => item.id === filter.column_id);
    if (!col) return false;
    if (filter.operator === 'equals' && (filter.value === null || filter.value === ''))
      return false;
    if (
      filter.operator === 'equals' &&
      col.kind === 'select' &&
      !col.options.some((item) => item.id === filter.value)
    )
      return false;
  }
  return true;
}

export function WidgetDialog({
  initial,
  revision,
  range,
  onClose,
  onSaved,
  onRefresh,
}: {
  initial: WidgetDefinition | null;
  revision: number;
  range: DateRange;
  onClose: () => void;
  onSaved: (layout: DashboardLayout) => void;
  onRefresh?: () => void;
}): JSX.Element {
  const [config, setConfig] = useState<WidgetConfig>(() =>
    structuredClone(initial?.config ?? EMPTY),
  );
  const [catalog, setCatalog] = useState<CatalogDormitory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<WidgetResult | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void api
      .dashboardSources(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setCatalog(items);
        setLoading(false);
        setConfig((current) => ({
          ...current,
          sources: [
            ...current.sources,
            ...items
              .filter(
                (dorm) =>
                  current.all_dormitories &&
                  !current.excluded_dormitory_ids.includes(dorm.id) &&
                  !current.sources.some((source) => source.dormitory_id === dorm.id),
              )
              .map((dorm) => blankSource(dorm, current.source_kind)),
          ],
        }));
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить источники.',
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [attempt]);
  function change(next: WidgetConfig): void {
    setConfig(next);
    setError('');
    setPreview(null);
  }
  function setSource(next: WidgetSource): void {
    change({
      ...config,
      sources: [
        ...config.sources.filter((source) => source.dormitory_id !== next.dormitory_id),
        next,
      ].sort((a, b) => a.dormitory_id - b.dormitory_id),
    });
  }
  const included = (id: number): boolean =>
    config.all_dormitories
      ? !config.excluded_dormitory_ids.includes(id)
      : config.sources.some((source) => source.dormitory_id === id);
  function include(dorm: CatalogDormitory, checked: boolean): void {
    change({
      ...config,
      excluded_dormitory_ids: checked
        ? config.excluded_dormitory_ids.filter((id) => id !== dorm.id)
        : [...config.excluded_dormitory_ids, dorm.id],
      sources: checked
        ? [...config.sources, blankSource(dorm, config.source_kind)]
        : config.sources.filter((source) => source.dormitory_id !== dorm.id),
    });
  }
  function copyFirst(): void {
    const first = catalog.find((dorm) => included(dorm.id));
    const base = config.sources.find((source) => source.dormitory_id === first?.id);
    if (!first || !base || !validSource(first, base, config)) {
      setError('Сначала настройте источник первого выбранного общежития.');
      return;
    }
    const baseMetadata = sourceMetadata(first, base)!;
    const sources = config.sources.map((source) => {
      const dorm = catalog.find((item) => item.id === source.dormitory_id);
      if (!dorm || dorm.id === first.id) return source;
      const metadata = unique(
        dorm.sources.filter(
          (item) =>
            item.kind === base.kind &&
            (base.kind !== 'table' ||
              (baseMetadata.key.startsWith('custom_')
                ? normalized(item.name) === normalized(baseMetadata.name)
                : item.key === baseMetadata.key)),
        ),
      );
      if (!metadata) return blankSource(dorm, base.kind);
      if (base.kind === 'report')
        return {
          ...base,
          dormitory_id: dorm.id,
          row_id:
            unique(
              metadata.rows.filter(
                (row) =>
                  normalized(row.name) ===
                  normalized(baseMetadata.rows.find((item) => item.id === base.row_id)?.name ?? ''),
              ),
            )?.id ?? 0,
        };
      if (base.kind === 'places')
        return {
          ...base,
          dormitory_id: dorm.id,
          hostel_id:
            base.hostel_id === null
              ? null
              : (unique(
                  metadata.hostels.filter(
                    (item) =>
                      normalized(item.name) ===
                      normalized(
                        baseMetadata.hostels.find((hostel) => hostel.id === base.hostel_id)?.name ??
                          '',
                      ),
                  ),
                )?.id ?? -1),
        };
      const column = (id: number | null): TableColumn | undefined => {
        const old = baseMetadata.columns.find((item) => item.id === id);
        return old
          ? unique(
              metadata.columns.filter(
                (item) => item.kind === old.kind && normalized(item.name) === normalized(old.name),
              ),
            )
          : undefined;
      };
      let filter = base.filter
        ? { ...base.filter, column_id: column(base.filter.column_id)?.id ?? 0 }
        : null;
      const oldFilter = baseMetadata.columns.find((item) => item.id === base.filter?.column_id);
      if (filter && oldFilter?.kind === 'select') {
        const label = oldFilter.options.find((item) => item.id === filter?.value)?.label;
        filter = {
          ...filter,
          value:
            unique(
              (column(oldFilter.id)?.options ?? []).filter(
                (item) => normalized(item.label) === normalized(label ?? ''),
              ),
            )?.id ?? null,
        };
      }
      return {
        ...base,
        dormitory_id: dorm.id,
        table_key: metadata.key as TableKey,
        value_column_id: column(base.value_column_id)?.id ?? null,
        date_column_id:
          base.date_column_id === null ? null : (column(base.date_column_id)?.id ?? 0),
        group_column_id: column(base.group_column_id)?.id ?? null,
        filter,
      };
    });
    change({ ...config, sources });
  }
  async function submit(event?: FormEvent<HTMLFormElement>, onlyPreview = false): Promise<void> {
    event?.preventDefault();
    const missing = catalog.filter(
      (dorm) =>
        included(dorm.id) &&
        !validSource(
          dorm,
          config.sources.find((source) => source.dormitory_id === dorm.id),
          config,
        ),
    );
    if (!config.name.trim()) {
      setError('Укажите название блока.');
      return;
    }
    if (!config.sources.length) {
      setError('Выберите хотя бы одно общежитие.');
      return;
    }
    if (missing.length) {
      setError('Настройте источники: ' + missing.map((dorm) => dorm.name).join(', '));
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (onlyPreview) setPreview(await api.previewDashboardBlock(config, range.from, range.to));
      else onSaved(await api.saveDashboardBlock(revision, config, initial?.id));
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить блок.');
      if (caught instanceof ApiError && caught.status === 409) onRefresh?.();
    } finally {
      setBusy(false);
    }
  }
  function filterInput(
    source: Extract<WidgetSource, { kind: 'table' }>,
    metadata: CatalogSource,
  ): JSX.Element | null {
    const filter = source.filter;
    if (!filter || filter.operator !== 'equals') return null;
    const column = metadata.columns.find((item) => item.id === filter.column_id);
    const update = (value: CellValue): void =>
      setSource({ ...source, filter: { ...filter, value } });
    if (column?.kind === 'checkbox')
      return (
        <label className={styles.field}>
          Значение
          <select
            value={String(filter.value ?? '')}
            onChange={(event) => update(event.target.value === 'true')}
          >
            <option value="">Выберите</option>
            <option value="true">Да</option>
            <option value="false">Нет</option>
          </select>
        </label>
      );
    if (column?.kind === 'select')
      return (
        <label className={styles.field}>
          Значение
          <select
            value={String(filter.value ?? '')}
            onChange={(event) => update(event.target.value || null)}
          >
            <option value="">Выберите</option>
            {column.options.map((item) => (
              <option key={item.id} value={item.id ?? ''}>
                {item.label}
                {item.archived ? ' (архив)' : ''}
              </option>
            ))}
          </select>
        </label>
      );
    return (
      <label className={styles.field}>
        Значение
        <input
          type={column?.kind === 'date' ? 'date' : 'text'}
          inputMode={column?.kind === 'number' ? 'decimal' : undefined}
          value={String(filter.value ?? '')}
          onChange={(event) => update(event.target.value)}
        />
      </label>
    );
  }
  return (
    <Modal
      title={initial ? 'Настроить блок' : 'Добавить блок статистики'}
      testId="dashboard-widget-dialog"
      onClose={onClose}
      closeDisabled={busy}
      panelClassName={styles.panel}
      containerClassName={styles.overlay}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className={styles.fields}>
          <div className={styles.grid}>
            <label className={styles.field}>
              Название блока
              <input
                maxLength={120}
                value={config.name}
                onChange={(event) => change({ ...config, name: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              Отображение
              <select
                value={config.display}
                onChange={(event) =>
                  change({
                    ...config,
                    display: event.target.value as WidgetConfig['display'],
                    period: event.target.value === 'chart' ? 'range' : config.period,
                    grouping: 'dormitory',
                  })
                }
              >
                <option value="number">Одна цифра</option>
                <option value="list">Список</option>
                <option value="chart">График</option>
              </select>
            </label>
            {config.display === 'chart' && (
              <label className={styles.field}>
                Линии на графике
                <select
                  value={config.chart_mode ?? 'total'}
                  onChange={(event) =>
                    change({
                      ...config,
                      chart_mode: event.target.value as WidgetConfig['chart_mode'],
                    })
                  }
                >
                  <option value="total">Общий показатель</option>
                  <option value="dormitories">Отдельная линия для каждого общежития</option>
                </select>
              </label>
            )}
            <label className={styles.field}>
              Источник данных
              <select
                value={config.source_kind}
                onChange={(event) => {
                  const kind = event.target.value as WidgetSource['kind'];
                  change({
                    ...config,
                    source_kind: kind,
                    operation: kind === 'table' ? 'count' : 'sum',
                    grouping: 'dormitory',
                    sources: catalog
                      .filter((dorm) => included(dorm.id))
                      .map((dorm) => blankSource(dorm, kind)),
                  });
                }}
              >
                <option value="report">Большой отчёт</option>
                <option value="places">Места</option>
                <option value="table">Таблица / пользовательская вкладка</option>
              </select>
            </label>
            {(config.display !== 'chart' || config.source_kind === 'table') && (
              <label className={styles.field}>
                Период расчёта
                <select
                  value={config.period}
                  onChange={(event) =>
                    change({ ...config, period: event.target.value as WidgetConfig['period'] })
                  }
                >
                  <option value="snapshot">
                    {config.display === 'chart'
                      ? 'Накопительно на каждую дату'
                      : 'На дату среза дашборда'}
                  </option>
                  <option value="range">
                    {config.display === 'chart' ? 'Отдельно за каждый день' : 'За выбранный период'}
                  </option>
                </select>
              </label>
            )}
            {config.source_kind === 'table' && (
              <label className={styles.field}>
                Что считать
                <select
                  value={config.operation}
                  onChange={(event) =>
                    change({
                      ...config,
                      operation: event.target.value as WidgetConfig['operation'],
                    })
                  }
                >
                  <option value="count">Количество строк</option>
                  <option value="sum">Сумма числового столбца</option>
                </select>
              </label>
            )}
            {config.display === 'list' && config.source_kind === 'table' && (
              <label className={styles.field}>
                Группировка списка
                <select
                  value={config.grouping}
                  onChange={(event) =>
                    change({ ...config, grouping: event.target.value as WidgetConfig['grouping'] })
                  }
                >
                  <option value="dormitory">По общежитиям</option>
                  <option value="value">По значениям столбца</option>
                </select>
              </label>
            )}
          </div>
          <p className={styles.hint}>
            {config.display === 'chart'
              ? config.source_kind === 'table'
                ? 'График показывает текущие строки таблиц по выбранной дате. Можно считать отдельно за день или накопительно. Строки без выбранной даты не учитываются.'
                : 'График показывает значение выбранного показателя за каждую дату периода дашборда. Пропуски и ошибки данных разрывают линию.'
              : config.source_kind === 'table'
                ? 'Считаются текущие строки таблиц. За период — по выбранной дате; на дату среза — все строки с датой не позже среза. Строки без выбранной даты не учитываются.'
                : 'На дату среза берётся один день. За период суммируются дневные значения — для численности обычно нужен срез.'}
          </p>
          <div className={styles.sourceHeading}>
            <h3>Общежития и источники</h3>
            <button type="button" disabled={loading || !!loadError} onClick={copyFirst}>
              Подобрать по первому общежитию
            </button>
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={config.all_dormitories}
              onChange={(event) =>
                change({
                  ...config,
                  all_dormitories: event.target.checked,
                  sources: event.target.checked
                    ? catalog
                        .filter((dorm) => !config.excluded_dormitory_ids.includes(dorm.id))
                        .map(
                          (dorm) =>
                            config.sources.find((source) => source.dormitory_id === dorm.id) ??
                            blankSource(dorm, config.source_kind),
                        )
                    : config.sources,
                })
              }
            />
            Учитывать все общежития, включая новые
          </label>
          <p className={styles.hint}>
            Для новых общежитий потребуется выбрать источник. Подбор сопоставляет названия и типы;
            проверьте результат. Скрытые вкладки доступны для расчётов.
          </p>
          {loading && <p role="status">Загружаем источники…</p>}
          {loadError && (
            <p role="alert">
              {loadError}{' '}
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Повторить загрузку
              </button>
            </p>
          )}
          {!loading && !loadError && catalog.length === 0 && <p>Сначала создайте общежитие.</p>}
          {!loading &&
            !loadError &&
            catalog.map((dorm, index) => {
              const source = config.sources.find((item) => item.dormitory_id === dorm.id),
                metadata = source ? sourceMetadata(dorm, source) : undefined;
              const selected = included(dorm.id),
                valid = validSource(dorm, source, config);
              return (
                <section key={dorm.id} className={styles.sourceCard}>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => include(dorm, event.target.checked)}
                    />
                    {dorm.name}
                    {dorm.is_archived ? ' (Архив)' : ''}
                  </label>
                  {selected && source && (
                    <details open={index === 0}>
                      <summary>{valid ? 'Источник выбран' : 'Настроить источник'}</summary>
                      <div className={styles.grid}>
                        {source.kind === 'report' && (
                          <label className={styles.field}>
                            Строка отчёта — {dorm.name}
                            <select
                              value={source.row_id}
                              onChange={(event) =>
                                setSource({ ...source, row_id: Number(event.target.value) })
                              }
                            >
                              <option value={0}>Выберите строку</option>
                              {metadata?.rows.map((row) => (
                                <option key={row.id} value={row.id}>
                                  {row.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {source.kind === 'places' && (
                          <>
                            <label className={styles.field}>
                              Показатель — {dorm.name}
                              <select
                                value={source.metric}
                                onChange={(event) =>
                                  setSource({
                                    ...source,
                                    metric: event.target.value as PlaceMetric,
                                  })
                                }
                              >
                                {METRICS.map((item) => (
                                  <option key={item.key} value={item.key}>
                                    {item.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className={styles.field}>
                              Хостел — {dorm.name}
                              <select
                                value={source.hostel_id ?? ''}
                                onChange={(event) =>
                                  setSource({
                                    ...source,
                                    hostel_id: event.target.value
                                      ? Number(event.target.value)
                                      : null,
                                  })
                                }
                              >
                                <option value="">Все хостелы</option>
                                {metadata?.hostels.map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </>
                        )}
                        {source.kind === 'table' && (
                          <>
                            <label className={styles.field}>
                              Таблица — {dorm.name}
                              <select
                                value={source.table_key}
                                onChange={(event) =>
                                  setSource({
                                    ...blankSource(dorm, 'table'),
                                    table_key: event.target.value as TableKey,
                                  } as WidgetSource)
                                }
                              >
                                <option value="">Выберите таблицу</option>
                                {dorm.sources
                                  .filter((item) => item.kind === 'table')
                                  .map((item) => (
                                    <option key={item.key} value={item.key}>
                                      {item.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            {config.operation === 'sum' && (
                              <label className={styles.field}>
                                Числовой столбец — {dorm.name}
                                <select
                                  value={source.value_column_id ?? ''}
                                  onChange={(event) =>
                                    setSource({
                                      ...source,
                                      value_column_id: Number(event.target.value) || null,
                                    })
                                  }
                                >
                                  <option value="">Выберите столбец</option>
                                  {metadata?.columns
                                    .filter((col) => col.kind === 'number')
                                    .map((col) => (
                                      <option key={col.id} value={col.id}>
                                        {col.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            )}
                            <label className={styles.field}>
                              Дата для расчёта — {dorm.name}
                              <select
                                value={source.date_column_id ?? ''}
                                onChange={(event) =>
                                  setSource({
                                    ...source,
                                    date_column_id: Number(event.target.value) || null,
                                  })
                                }
                              >
                                <option value="">Дата создания записи</option>
                                {metadata?.columns
                                  .filter((col) => col.kind === 'date')
                                  .map((col) => (
                                    <option key={col.id} value={col.id}>
                                      {col.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            {config.grouping === 'value' && (
                              <label className={styles.field}>
                                Столбец группировки — {dorm.name}
                                <select
                                  value={source.group_column_id ?? ''}
                                  onChange={(event) =>
                                    setSource({
                                      ...source,
                                      group_column_id: Number(event.target.value) || null,
                                    })
                                  }
                                >
                                  <option value="">Выберите столбец</option>
                                  {metadata?.columns.map((col) => (
                                    <option key={col.id} value={col.id}>
                                      {col.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                            <label className={styles.check}>
                              <input
                                type="checkbox"
                                checked={!!source.filter}
                                onChange={(event) =>
                                  setSource({
                                    ...source,
                                    filter: event.target.checked
                                      ? {
                                          column_id: metadata?.columns[0]?.id ?? 0,
                                          operator: 'equals',
                                          value: null,
                                        }
                                      : null,
                                  })
                                }
                              />
                              Условие отбора — {dorm.name}
                            </label>
                            {source.filter && metadata && (
                              <>
                                <label className={styles.field}>
                                  Столбец условия — {dorm.name}
                                  <select
                                    value={source.filter.column_id}
                                    onChange={(event) =>
                                      setSource({
                                        ...source,
                                        filter: {
                                          column_id: Number(event.target.value),
                                          operator: 'equals',
                                          value: null,
                                        },
                                      })
                                    }
                                  >
                                    {metadata.columns.map((col) => (
                                      <option key={col.id} value={col.id}>
                                        {col.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className={styles.field}>
                                  Условие — {dorm.name}
                                  <select
                                    value={source.filter.operator}
                                    onChange={(event) =>
                                      setSource({
                                        ...source,
                                        filter: {
                                          ...source.filter!,
                                          operator: event.target.value as 'equals' | 'not_empty',
                                        },
                                      })
                                    }
                                  >
                                    <option value="equals">Равно</option>
                                    <option value="not_empty">Заполнено</option>
                                  </select>
                                </label>
                                {filterInput(source, metadata)}
                              </>
                            )}
                          </>
                        )}
                        {!metadata && (
                          <p className={styles.error}>Этот источник отсутствует в общежитии.</p>
                        )}
                      </div>
                    </details>
                  )}
                </section>
              );
            })}
        </fieldset>
        {preview && (
          <div className={styles.preview}>
            <strong>
              {config.display === 'chart'
                ? 'Предпросмотр графика'
                : 'Предпросмотр: ' + formatCount(preview.value)}
            </strong>
            {config.display === 'chart' && (
              <WidgetChart result={preview} range={range} name={config.name} />
            )}
            {config.display === 'list' &&
              preview.items.map((item) => (
                <p key={item.label}>
                  {item.label}: {formatCount(item.value)}
                </p>
              ))}
            {preview.errors.map((message) => (
              <p key={message} className={styles.error}>
                {message}
              </p>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            disabled={busy || loading || !!loadError}
            onClick={() => void submit(undefined, true)}
          >
            Проверить расчёт
          </button>
          <button
            type="submit"
            className={styles.primary}
            disabled={busy || loading || !!loadError}
          >
            {busy ? 'Подождите…' : initial ? 'Сохранить' : 'Добавить блок'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
