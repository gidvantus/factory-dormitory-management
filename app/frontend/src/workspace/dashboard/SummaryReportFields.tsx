import type {
  CatalogDormitory,
  SummaryConfig,
  SummaryMetric,
  WidgetConfig,
} from '../../api/dashboardBlocks';
import { EditorSection } from '../../components/EditorSection';
import { tableColors } from '../../components/workingTableModel';
import styles from './WidgetDialog.module.css';
import { normalizeMetric, SUMMARY_AGGREGATES } from './summaryModel';

export function SummaryReportFields({
  config,
  catalog,
  onChange,
}: {
  config: WidgetConfig;
  catalog: CatalogDormitory[];
  onChange: (config: WidgetConfig) => void;
}): JSX.Element {
  const summary = config.summary!;
  const update = (next: Partial<SummaryConfig>): void =>
    onChange({ ...config, summary: { ...summary, ...next } });
  const selectedDorms = catalog.filter(
    (dorm) =>
      !config.excluded_dormitory_ids.includes(dorm.id) &&
      (config.all_dormitories || summary.dormitory_ids.includes(dorm.id)),
  );
  const options = new Map<string, SummaryMetric>();
  for (const dorm of selectedDorms) {
    for (const row of dorm.sources.find((source) => source.kind === 'report')?.rows ?? []) {
      const key = normalizeMetric(row.name);
      const metric = options.get(key) ?? { name: row.name, aggregate: 'sum', sources: [] };
      metric.sources.push({ kind: 'report', dormitory_id: dorm.id, row_id: row.id });
      options.set(key, metric);
    }
  }
  // Сохранённый показатель доступен даже после удаления его последнего источника.
  for (const metric of summary.metrics)
    if (!options.has(normalizeMetric(metric.name)))
      options.set(normalizeMetric(metric.name), metric);
  const selectedKeys = new Set(summary.metrics.map((metric) => normalizeMetric(metric.name)));
  const orderedKeys = [
    ...selectedKeys,
    ...[...options.keys()].filter((key) => !selectedKeys.has(key)),
  ];

  function updateMetric(index: number, changes: Partial<SummaryMetric>): void {
    update({
      metrics: summary.metrics.map((metric, i) =>
        i === index ? { ...metric, ...changes } : metric,
      ),
    });
  }

  function moveMetric(index: number, direction: -1 | 1): void {
    const nextIndex = index + direction;
    const metrics = [...summary.metrics];
    [metrics[index], metrics[nextIndex]] = [metrics[nextIndex], metrics[index]];
    update({ metrics });
  }

  return (
    <>
      <EditorSection
        title="Вид сводного отчёта"
        description="Период задаётся календарём на странице «Обзор»: месяц или любые даты."
      >
        <div className={styles.grid}>
          <label className={styles.field}>
            Данные в отчёте
            <select
              value={summary.view}
              onChange={(event) => update({ view: event.target.value as SummaryConfig['view'] })}
            >
              <option value="totals">Итоги за период</option>
              <option value="daily">По дням с итогом</option>
            </select>
          </label>
          <label className={styles.field}>
            Подписи общежитий
            <select
              value={summary.label}
              onChange={(event) => update({ label: event.target.value as SummaryConfig['label'] })}
            >
              <option value="dormitory">Название общежития</option>
              <option value="client">Клиент (название общежития)</option>
            </select>
          </label>
        </div>
        <p className={styles.hint}>
          Блок занимает два места по ширине. До 31 дня — без горизонтальной прокрутки; более 31 дня
          — с прокруткой. На узком экране дни отображаются компактными карточками.
        </p>
      </EditorSection>
      <EditorSection
        title="Общежития"
        description="Каждое общежитие остаётся отдельным, даже если клиент общий."
      >
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={config.all_dormitories}
            onChange={(event) =>
              onChange({
                ...config,
                all_dormitories: event.target.checked,
                excluded_dormitory_ids: [],
                summary: { ...summary, dormitory_ids: selectedDorms.map((dorm) => dorm.id) },
              })
            }
          />
          Все общежития, включая новые
        </label>
        {catalog.map((dorm) => (
          <label key={dorm.id} className={styles.check}>
            <input
              type="checkbox"
              checked={selectedDorms.some((item) => item.id === dorm.id)}
              onChange={(event) => {
                const checked = event.target.checked;
                if (config.all_dormitories)
                  onChange({
                    ...config,
                    excluded_dormitory_ids: checked
                      ? config.excluded_dormitory_ids.filter((id) => id !== dorm.id)
                      : [...config.excluded_dormitory_ids, dorm.id],
                  });
                else
                  update({
                    dormitory_ids: checked
                      ? [...summary.dormitory_ids, dorm.id]
                      : summary.dormitory_ids.filter((id) => id !== dorm.id),
                  });
              }}
            />
            {dorm.name}
          </label>
        ))}
      </EditorSection>
      <EditorSection
        title="Показатели общего отчёта"
        description="Показатели с одинаковыми названиями объединены."
      >
        {!options.size && <p>В выбранных общежитиях пока нет строк общего отчёта.</p>}
        {summary.metrics.length > 1 && (
          <p className={styles.hint}>Порядок выбранных показателей можно изменить стрелками.</p>
        )}
        {orderedKeys.map((key, index) => {
          const option = options.get(key)!;
          const selected = selectedKeys.has(key) ? summary.metrics[index] : undefined;
          return (
            <div className={styles.sourceCard} key={key}>
              <div className={styles.summaryMetricHeader}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={!!selected}
                    onChange={(event) =>
                      update({
                        metrics: event.target.checked
                          ? [
                              ...summary.metrics,
                              {
                                ...option,
                                sources: option.sources.filter(
                                  (source, index, all) =>
                                    all.findIndex(
                                      (item) => item.dormitory_id === source.dormitory_id,
                                    ) === index,
                                ),
                              },
                            ]
                          : summary.metrics.filter(
                              (metric) => normalizeMetric(metric.name) !== key,
                            ),
                      })
                    }
                  />
                  {selected?.name ?? option.name}
                </label>
                {selected && summary.metrics.length > 1 && (
                  <div className={styles.summaryMetricOrder}>
                    <button
                      type="button"
                      className="btn btn--outline btn--compact"
                      aria-label={`Поднять «${selected.name}»`}
                      title="На строку выше"
                      disabled={index === 0}
                      onClick={() => moveMetric(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--outline btn--compact"
                      aria-label={`Опустить «${selected.name}»`}
                      title="На строку ниже"
                      disabled={index === summary.metrics.length - 1}
                      onClick={() => moveMetric(index, 1)}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </div>
              {selected && (
                <div className={`${styles.grid} ${styles.summaryMetricFields}`}>
                  <label className={styles.field}>
                    Расчёт — {selected.name}
                    <select
                      value={selected.aggregate}
                      onChange={(event) =>
                        updateMetric(index, {
                          aggregate: event.target.value as SummaryMetric['aggregate'],
                        })
                      }
                    >
                      {Object.entries(SUMMARY_AGGREGATES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.field}>
                    Цвет строки — {selected.name}
                    <select
                      value={selected.color ?? ''}
                      style={
                        selected.color
                          ? { backgroundColor: `var(--table-fill-${selected.color})` }
                          : undefined
                      }
                      onChange={(event) =>
                        updateMetric(index, {
                          color: (event.target.value || null) as SummaryMetric['color'],
                        })
                      }
                    >
                      <option value="">Без цвета</option>
                      {tableColors.map(({ id, label }) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}
        <p className={styles.hint}>
          Пропуски и ошибки отображаются знаком «—». Сумма и среднее требуют заполнения всех дней;
          последнее значение берётся строго на последнюю дату периода.
        </p>
      </EditorSection>
    </>
  );
}
