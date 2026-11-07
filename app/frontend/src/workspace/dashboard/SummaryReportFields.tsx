import type {
  CatalogDormitory,
  SummaryConfig,
  SummaryMetric,
  WidgetConfig,
} from '../../api/dashboardBlocks';
import { EditorSection } from '../../components/EditorSection';
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
        description="Одинаковые названия представлены один раз. Для каждого показателя выберите способ расчёта."
      >
        {!options.size && <p>В выбранных общежитиях пока нет строк общего отчёта.</p>}
        {[...options.entries()].map(([key, option]) => {
          const selected = summary.metrics.find((metric) => normalizeMetric(metric.name) === key);
          return (
            <div className={styles.sourceCard} key={key}>
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
                        : summary.metrics.filter((metric) => normalizeMetric(metric.name) !== key),
                    })
                  }
                />
                {option.name}
              </label>
              {selected && (
                <label className={styles.field}>
                  Расчёт — {selected.name}
                  <select
                    value={selected.aggregate}
                    onChange={(event) =>
                      update({
                        metrics: summary.metrics.map((metric) =>
                          metric === selected
                            ? {
                                ...metric,
                                aggregate: event.target.value as SummaryMetric['aggregate'],
                              }
                            : metric,
                        ),
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
