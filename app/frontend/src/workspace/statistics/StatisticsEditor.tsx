import { useEffect, useState } from 'react';
import type { CellValue, PlaceMetric } from '../../api/client';
import type { CatalogDormitory, WidgetConfig, WidgetSource } from '../../api/dashboardBlocks';
import { statisticsApi } from '../../api/statistics';
import type { StatisticsBlock, StatisticsResult } from '../../api/statistics';
import type { DateRange } from '../dashboard/dates';
import { rangeError } from '../dashboard/dates';
import {
  displayNames,
  errorMessage,
  metadata,
  metrics,
  operations,
  sourceFor,
  sourceLabel,
  validSource,
} from './helpers';
import { Icon } from './Icon';
import { StatisticsChart } from './StatisticsChart';
import styles from './Statistics.module.css';

function SourceFields({
  dorm,
  source,
  block,
  onChange,
  showSourcePicker = true,
}: {
  dorm: CatalogDormitory;
  source: WidgetSource;
  block: StatisticsBlock;
  onChange: (source: WidgetSource) => void;
  showSourcePicker?: boolean;
}): JSX.Element {
  const meta = metadata(dorm, source);
  const filterCol =
    source.kind === 'table'
      ? meta?.columns.find((col) => col.id === source.filter?.column_id)
      : undefined;
  const value = source.kind === 'table' ? source.filter?.value : null;
  const setFilterValue = (next: CellValue): void => {
    if (source.kind === 'table' && source.filter)
      onChange({ ...source, filter: { ...source.filter, value: next } });
  };
  return (
    <>
      {source.kind === 'arrival_plan' && (
        <p className={styles.hint}>
          Количество ожидаемых людей по датам заезда, включая будущие даты выбранного периода. Дни
          без записей дают 0. Заполнение ФИО не влияет на расчёт.
        </p>
      )}
      {showSourcePicker && source.kind === 'table' && (
        <label className={styles.field}>
          Таблица в этом общежитии
          <select
            value={meta?.key ?? ''}
            onChange={(event) => {
              const next = dorm.sources.find((item) => item.key === event.target.value);
              if (next) onChange(sourceFor(dorm, next));
            }}
          >
            <option value="" disabled>
              Источник недоступен — выберите другой
            </option>
            {dorm.sources
              .filter((item) => item.kind === block.query.source_kind)
              .map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {source.kind === 'report' && (
        <label className={styles.field}>
          Строка отчёта
          <select
            value={source.row_id}
            onChange={(event) => onChange({ ...source, row_id: Number(event.target.value) })}
          >
            {!meta?.rows.some((row) => row.id === source.row_id) && (
              <option value={source.row_id} disabled>
                Выберите строку
              </option>
            )}
            {meta?.rows.map((row) => (
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
            Показатель
            <select
              value={source.metric}
              onChange={(event) =>
                onChange({ ...source, metric: event.target.value as PlaceMetric })
              }
            >
              {Object.entries(metrics).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Хостел
            <select
              value={source.hostel_id ?? ''}
              onChange={(event) =>
                onChange({
                  ...source,
                  hostel_id: event.target.value ? Number(event.target.value) : null,
                })
              }
            >
              <option value="">Все хостелы</option>
              {meta?.hostels.map((item) => (
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
          {block.query.operation === 'sum' && (
            <label className={styles.field}>
              Числовой столбец
              <select
                value={source.value_column_id ?? ''}
                onChange={(event) =>
                  onChange({ ...source, value_column_id: Number(event.target.value) })
                }
              >
                <option value="" disabled>
                  Выберите столбец
                </option>
                {meta?.columns
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
            Дата для расчёта
            <select
              value={source.date_column_id ?? ''}
              onChange={(event) =>
                onChange({
                  ...source,
                  date_column_id: event.target.value ? Number(event.target.value) : null,
                })
              }
            >
              <option value="">Без даты — текущее состояние</option>
              {meta?.columns
                .filter((col) => col.kind === 'date')
                .map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.name}
                  </option>
                ))}
            </select>
          </label>
          {source.date_column_id === null && (
            <p className={styles.hint}>
              Текущее состояние таблицы повторяется на каждой дате. Для событий по дням выберите
              столбец с датой.
            </p>
          )}
          <label className={styles.field}>
            Условие по столбцу
            <select
              value={source.filter?.column_id ?? ''}
              onChange={(event) =>
                onChange({
                  ...source,
                  filter: event.target.value
                    ? { column_id: Number(event.target.value), operator: 'not_empty', value: null }
                    : null,
                })
              }
            >
              <option value="">Без условия</option>
              {meta?.columns.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.name}
                </option>
              ))}
            </select>
          </label>
          {source.filter && (
            <>
              <label className={styles.field}>
                Условие
                <select
                  value={source.filter.operator}
                  onChange={(event) =>
                    onChange({
                      ...source,
                      filter: {
                        ...source.filter!,
                        operator: event.target.value as 'equals' | 'not_empty',
                        value: filterCol?.kind === 'checkbox' ? true : null,
                      },
                    })
                  }
                >
                  <option value="not_empty">Заполнено</option>
                  <option value="equals">Равно</option>
                </select>
              </label>
              {source.filter.operator === 'equals' && (
                <label className={styles.field}>
                  Значение
                  {filterCol?.kind === 'select' ? (
                    <select
                      value={String(value ?? '')}
                      onChange={(event) => setFilterValue(event.target.value)}
                    >
                      <option value="" disabled>
                        Выберите значение
                      </option>
                      {filterCol.options.map((option, index) => (
                        <option key={option.id ?? index} value={option.id ?? ''}>
                          {option.label}
                          {option.archived ? ' (Архив)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : filterCol?.kind === 'checkbox' ? (
                    <select
                      value={String(value ?? true)}
                      onChange={(event) => setFilterValue(event.target.value === 'true')}
                    >
                      <option value="true">Да</option>
                      <option value="false">Нет</option>
                    </select>
                  ) : (
                    <input
                      type={
                        filterCol?.kind === 'number'
                          ? 'number'
                          : filterCol?.kind === 'date'
                            ? 'date'
                            : 'text'
                      }
                      step="any"
                      value={String(value ?? '')}
                      onChange={(event) =>
                        setFilterValue(
                          filterCol?.kind === 'number'
                            ? event.target.value === ''
                              ? null
                              : Number(event.target.value)
                            : event.target.value,
                        )
                      }
                    />
                  )}
                </label>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

export function StatisticsEditor({
  initial,
  catalog,
  range,
  busy,
  onSave,
  onCancel,
  onRefresh,
}: {
  initial: StatisticsBlock;
  catalog: CatalogDormitory[];
  range: DateRange;
  busy: boolean;
  onSave: (block: StatisticsBlock) => Promise<void>;
  onCancel: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [preview, setPreview] = useState<StatisticsResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [override, setOverride] = useState('');
  const anchor = draft.query.sources[0];
  const dorm = catalog.find((item) => item.id === anchor?.dormitory_id);
  const valid =
    !!draft.name.trim() &&
    (draft.query.all_dormitories || draft.selected_dormitory_ids.length > 0) &&
    draft.query.sources.length > 0 &&
    draft.query.sources.every((source) =>
      validSource(
        source,
        catalog.find((item) => item.id === source.dormitory_id),
        draft,
      ),
    );
  const change = (patch: Partial<StatisticsBlock>): void =>
    setDraft((current) => ({ ...current, ...patch }));
  const query = (patch: Partial<WidgetConfig>): void =>
    change({ query: { ...draft.query, ...patch } });
  const setAnchor = (source: WidgetSource): void => query({ sources: [source] });
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    setLoading(false);
    if (!valid || rangeError(range)) return;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void statisticsApi
        .preview(
          { ...draft, name: draft.name.trim(), query: { ...draft.query, name: draft.name.trim() } },
          range,
          controller.signal,
        )
        .then((result) => {
          if (!controller.signal.aborted) {
            setPreview(result);
            setLoading(false);
          }
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(caught));
            setLoading(false);
          }
        });
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [draft, range, valid, catalog]);
  const target = catalog.find((item) => item.id === Number(override));
  const explicit = draft.query.sources.find((item) => item.dormitory_id === target?.id);
  const overrideSource =
    explicit ??
    (target && target.sources.find((item) => item.kind === draft.query.source_kind)
      ? sourceFor(
          target,
          target.sources.find((item) => item.kind === draft.query.source_kind)!,
        )
      : undefined);
  return (
    <>
      <button className={styles.back} disabled={busy} onClick={onCancel}>
        <Icon name="arrow" />
        Вернуться к отчёту
      </button>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>КОНСТРУКТОР БЛОКА</p>
          <h1>От данных — к результату</h1>
          <p className={styles.subtitle}>Выберите, что считать и как это показать.</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.secondary} disabled={busy} onClick={onCancel}>
            Отмена
          </button>
          <button
            className={styles.primary}
            disabled={!valid || busy}
            onClick={() =>
              void onSave({
                ...draft,
                name: draft.name.trim(),
                query: { ...draft.query, name: draft.name.trim() },
              })
            }
          >
            <Icon name="check" />
            {busy ? 'Сохранение…' : 'Сохранить блок'}
          </button>
        </div>
      </div>
      <div className={styles.editorGrid}>
        <div className={styles.editorSettings}>
          <section className={styles.settingSection}>
            <h2>
              <span>1</span>Данные
            </h2>
            <label className={styles.field}>
              Название блока
              <input
                maxLength={120}
                value={draft.name}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              Общежитие для образца
              <select
                value={dorm?.id ?? ''}
                onChange={(event) => {
                  const next = catalog.find((item) => item.id === Number(event.target.value));
                  const meta = next?.sources.find((item) => item.kind === draft.query.source_kind);
                  if (next && meta) setAnchor(sourceFor(next, meta));
                }}
              >
                <option value="" disabled>
                  Общежитие недоступно
                </option>
                {catalog.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.is_archived ? ' (Архив)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Откуда брать данные
              <select
                value={metadata(dorm, anchor)?.key ?? ''}
                onChange={(event) => {
                  const meta = dorm?.sources.find((item) => item.key === event.target.value);
                  if (dorm && meta)
                    query({
                      source_kind: meta.kind,
                      period: meta.kind === 'arrival_plan' ? 'range' : draft.query.period,
                      operation:
                        meta.kind === 'table' && draft.query.source_kind === 'table'
                          ? draft.query.operation
                          : meta.kind === 'table'
                            ? 'count'
                            : 'sum',
                      sources: [sourceFor(dorm, meta)],
                    });
                }}
              >
                <option value="" disabled>
                  Выберите вкладку
                </option>
                {dorm?.sources.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {draft.query.source_kind === 'table' && (
              <label className={styles.field}>
                Что считать
                <select
                  value={draft.query.operation}
                  onChange={(event) => query({ operation: event.target.value as 'count' | 'sum' })}
                >
                  <option value="count">Количество строк</option>
                  <option value="sum">Сумма числового столбца</option>
                </select>
              </label>
            )}
            {dorm && anchor ? (
              <SourceFields
                dorm={dorm}
                source={anchor}
                block={draft}
                onChange={setAnchor}
                showSourcePicker={false}
              />
            ) : (
              <p className={styles.alert}>Выберите существующее общежитие и источник.</p>
            )}
            <label className={styles.field}>
              Общежития
              <select
                value={draft.query.all_dormitories ? 'all' : 'selected'}
                onChange={(event) => query({ all_dormitories: event.target.value === 'all' })}
              >
                <option value="all">Все, включая новые</option>
                <option value="selected">Только выбранные</option>
              </select>
            </label>
            {!draft.query.all_dormitories ? (
              <div className={styles.dormitoryChecks}>
                {catalog.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={draft.selected_dormitory_ids.includes(item.id)}
                      onChange={(event) =>
                        change({
                          selected_dormitory_ids: event.target.checked
                            ? [...draft.selected_dormitory_ids, item.id]
                            : draft.selected_dormitory_ids.filter((id) => id !== item.id),
                        })
                      }
                    />
                    {item.name}
                    {item.is_archived ? ' (Архив)' : ''}
                  </label>
                ))}
              </div>
            ) : (
              <p className={styles.fieldHint}>
                <Icon name="refresh" />
                Новые общежития включаются автоматически
              </p>
            )}
          </section>
          <section className={styles.settingSection}>
            <h2>
              <span>2</span>Расчёт и условия
            </h2>
            <label className={styles.field}>
              Как считать за период
              <select
                value={draft.aggregation}
                onChange={(event) =>
                  change({ aggregation: event.target.value as StatisticsBlock['aggregation'] })
                }
              >
                {Object.entries(operations).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {draft.query.source_kind === 'table' && (
              <label className={styles.field}>
                Данные на каждой дате
                <select
                  value={draft.query.period}
                  onChange={(event) =>
                    query({ period: event.target.value as 'range' | 'snapshot' })
                  }
                >
                  <option value="range">События этого дня</option>
                  <option value="snapshot">Накопительно до этой даты</option>
                </select>
              </label>
            )}
            <label className={styles.field}>
              Разбивка
              <select
                value={draft.breakdown}
                disabled={['number', 'table', 'pie'].includes(draft.display)}
                onChange={(event) =>
                  change({ breakdown: event.target.value as 'date' | 'dormitory' })
                }
              >
                <option value="date">По дням</option>
                <option value="dormitory">По общежитиям</option>
              </select>
            </label>
            {draft.query.source_kind !== 'arrival_plan' && (
              <details className={styles.sourceOverrides}>
                <summary>Связи с другими общежитиями</summary>
                <p className={styles.hint}>
                  По умолчанию подбираются строки, вкладки и столбцы с такими же названиями. Если
                  структура отличается, укажите источник вручную.
                </p>
                <label className={styles.field}>
                  Настроить общежитие
                  <select value={override} onChange={(event) => setOverride(event.target.value)}>
                    <option value="">Выберите общежитие</option>
                    {catalog
                      .filter((item) => item.id !== dorm?.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                {target && overrideSource && (
                  <>
                    <p className={styles.hint}>
                      {explicit
                        ? 'Источник задан явно'
                        : 'Настройте источник и он будет закреплён за этим общежитием'}
                    </p>
                    <SourceFields
                      dorm={target}
                      source={overrideSource}
                      block={draft}
                      onChange={(next) =>
                        query({
                          sources: [
                            ...draft.query.sources.filter(
                              (item) => item.dormitory_id !== next.dormitory_id,
                            ),
                            next,
                          ],
                        })
                      }
                    />
                    {explicit && (
                      <button
                        className={styles.textButton}
                        onClick={() =>
                          query({
                            sources: draft.query.sources.filter(
                              (item) => item.dormitory_id !== target.id,
                            ),
                          })
                        }
                      >
                        Вернуть автоматический подбор
                      </button>
                    )}
                  </>
                )}
              </details>
            )}
          </section>
        </div>
        <div className={styles.editorPreview}>
          <section className={styles.formatSection}>
            <div className={styles.sectionHeading}>
              <h2>
                <span className={styles.stepNumber}>3</span>Вид блока
              </h2>
              <span className={styles.smallMuted}>Можно изменить в любой момент</span>
            </div>
            <div className={styles.formatGrid}>
              {Object.entries(displayNames).map(([display, name]) => (
                <button
                  key={display}
                  className={draft.display === display ? styles.formatSelected : ''}
                  aria-pressed={draft.display === display}
                  onClick={() =>
                    change({
                      display: display as StatisticsBlock['display'],
                      breakdown: display === 'pie' ? 'dormitory' : draft.breakdown,
                    })
                  }
                >
                  <Icon name={display as StatisticsBlock['display']} />
                  <span>{name}</span>
                  {draft.display === display && (
                    <span className={styles.formatCheck}>
                      <Icon name="check" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
          <div className={styles.previewLabel}>
            <span />
            ПРЕДПРОСМОТР
            <span className={styles.smallMuted}>По данным базы за выбранный период</span>
          </div>
          <section className={styles.blockCard} aria-busy={loading}>
            <div className={styles.blockHeading}>
              <div>
                <h2>{draft.name || 'Название блока'}</h2>
                <p>{sourceLabel(draft, catalog)}</p>
              </div>
              <span className={styles.typeBadge}>{displayNames[draft.display]}</span>
            </div>
            {preview ? (
              <StatisticsChart block={draft} result={preview} range={range} />
            ) : (
              <p className={styles.noData} role="status">
                {loading
                  ? 'Расчёт по данным базы…'
                  : error || rangeError(range) || 'Заполните настройки источника'}
              </p>
            )}
            {preview?.errors.length ? (
              <ul className={styles.blockErrors}>
                {preview.errors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            ) : null}
          </section>
          <div className={styles.recipe}>
            <Icon name="layers" />
            <div>
              <strong>Как получится результат</strong>
              <p>
                {sourceLabel(draft, catalog)} →{' '}
                {draft.query.all_dormitories ? 'все общежития' : 'выбранные общежития'} →{' '}
                {operations[draft.aggregation].toLocaleLowerCase('ru-RU')} →{' '}
                {displayNames[draft.display].toLocaleLowerCase('ru-RU')}
              </p>
            </div>
          </div>
          <div className={styles.structureNote}>
            <div className={styles.noteIcon}>
              <Icon name="refresh" />
            </div>
            <div>
              <strong>Структура обновляется автоматически</strong>
              <p>
                Новые вкладки, строки и столбцы появятся в выборе данных. Связи с сохранёнными
                источниками используют их идентификаторы и сохраняются при переименовании.
              </p>
              <button className={styles.textButton} onClick={onRefresh}>
                Обновить источники сейчас
                <Icon name="refresh" />
              </button>
            </div>
          </div>
          <p className={styles.previewDisclaimer}>
            «—» означает отсутствие данных или проблему источника. Будущие даты не включаются в
            итог. Предпросмотр не сохраняет настройки.
          </p>
        </div>
      </div>
    </>
  );
}
