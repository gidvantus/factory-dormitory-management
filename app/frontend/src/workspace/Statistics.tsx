import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CatalogDormitory } from '../api/dashboardBlocks';
import { statisticsApi } from '../api/statistics';
import type {
  ReportInput,
  StatisticsBlock,
  StatisticsData,
  StatisticsReport,
} from '../api/statistics';
import { Modal } from '../components/Modal';
import { currentMonth, formatDate, rangeError } from './dashboard/dates';
import type { DateRange } from './dashboard/dates';
import { usePageRefresh } from './usePageRefresh';
import {
  displayNames,
  errorMessage,
  newBlock,
  operations,
  sourceLabel,
} from './statistics/helpers';
import { Icon } from './statistics/Icon';
import { StatisticsChart } from './statistics/StatisticsChart';
import { StatisticsEditor } from './statistics/StatisticsEditor';
import styles from './statistics/Statistics.module.css';

function ReportDialog({
  report,
  onClose,
  onSave,
}: {
  report: StatisticsReport | null;
  onClose: () => void;
  onSave: (input: ReportInput) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(report?.name ?? '');
  const [description, setDescription] = useState(report?.description ?? '');
  const [visibility, setVisibility] = useState<ReportInput['visibility']>(
    report?.visibility ?? 'shared',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        visibility,
        blocks: report?.blocks ?? [],
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={report ? 'Настройки отчёта' : 'Создать отчёт'}
      testId="statistics-report-dialog"
      onClose={onClose}
      closeDisabled={busy}
      panelClassName={styles.smallModal}
      containerClassName={styles.modalTheme}
    >
      <form onSubmit={(event) => void submit(event)}>
        <p className={styles.modalIntro}>
          {report
            ? 'Название, описание и доступ к отчёту.'
            : 'Дайте отчёту название, затем добавьте нужные показатели и графики.'}
        </p>
        <label className={styles.field}>
          Название отчёта
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Например, выход персонала за месяц"
          />
        </label>
        <label className={styles.field}>
          Описание
          <textarea
            rows={3}
            maxLength={1000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Для чего нужен этот отчёт"
          />
        </label>
        <label className={styles.field}>
          Доступ
          <select
            disabled={!!report && !report.can_manage}
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as ReportInput['visibility'])}
          >
            <option value="shared">Общий — доступен всем активным пользователям</option>
            <option value="personal">Личный — доступен только мне</option>
          </select>
        </label>
        <p className={styles.hint}>
          Общие отчёты могут редактировать все активные пользователи. Менять доступ и удалять отчёт
          может его создатель.
        </p>
        {error && (
          <p role="alert" className={styles.alert}>
            {error}
          </p>
        )}
        <div className={styles.modalFooter}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button className={styles.primary} disabled={!name.trim() || busy}>
            {busy ? 'Сохранение…' : report ? 'Сохранить' : 'Создать отчёт'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Statistics(): JSX.Element {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const refresh = usePageRefresh();
  const listRefresh = reportId ? 0 : refresh;
  const [attempt, setAttempt] = useState(0);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [catalog, setCatalog] = useState<CatalogDormitory[]>([]);
  const [sourcesError, setSourcesError] = useState('');
  const [reports, setReports] = useState<StatisticsReport[]>([]);
  const [report, setReport] = useState<StatisticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<StatisticsData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [range, setRange] = useState<DateRange>(() => currentMonth());
  const [rangeMode, setRangeMode] = useState('month');
  const [dormitory, setDormitory] = useState('all');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [dialog, setDialog] = useState<'create' | 'settings' | null>(null);
  const [editor, setEditor] = useState<StatisticsBlock | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const reload = (): void => {
    setEditor(null);
    setDialog(null);
    setDeleting(null);
    setAttempt((current) => current + 1);
  };
  useEffect(() => {
    setEditor(null);
    setDialog(null);
    setDeleting(null);
  }, [reportId]);
  useEffect(() => {
    const controller = new AbortController();
    void statisticsApi
      .sources(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setCatalog(items);
          setSourcesError('');
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setSourcesError(errorMessage(caught));
      });
    return () => controller.abort();
  }, [attempt, sourceAttempt, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setReport(null);
    setData(null);
    const request = reportId
      ? statisticsApi.report(reportId, controller.signal).then((item) => {
          if (!controller.signal.aborted) setReport(item);
        })
      : statisticsApi.reports(controller.signal).then((items) => {
          if (!controller.signal.aborted) setReports(items);
        });
    void request
      .then(() => {
        if (!controller.signal.aborted) setLoading(false);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(caught));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [reportId, attempt, listRefresh]);
  useEffect(() => {
    if (!report || editor || rangeError(range)) {
      setData(null);
      setDataLoading(false);
      return;
    }
    const controller = new AbortController();
    setData(null);
    setDataError('');
    setDataLoading(true);
    void statisticsApi
      .data(String(report.id), range, dormitory, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.revision !== report.revision)
          setDataError(
            'Отчёт изменён другим пользователем. Обновите отчёт, чтобы загрузить новую версию.',
          );
        else setData(result);
        setDataLoading(false);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setDataError(errorMessage(caught));
          setDataLoading(false);
        }
      });
    return () => controller.abort();
  }, [report, range, dormitory, editor, refresh]);
  async function persist(input: ReportInput): Promise<void> {
    if (!report) return;
    setBusy(true);
    setError('');
    try {
      const saved = await statisticsApi.save(report.id, {
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        blocks: input.blocks,
        revision: report.revision,
      });
      setReport(saved);
    } finally {
      setBusy(false);
    }
  }
  async function saveBlocks(blocks: StatisticsBlock[]): Promise<void> {
    if (!report) return;
    try {
      await persist({ ...report, blocks });
      setEditor(null);
      setDeleting(null);
    } catch (caught) {
      setError(errorMessage(caught));
      setDeleting(null);
    }
  }
  async function remove(): Promise<void> {
    if (!report || !deleting) return;
    if (deleting !== 'report') {
      await saveBlocks(report.blocks.filter((block) => block.id !== deleting));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await statisticsApi.remove(report.id, report.revision);
      navigate('/cabinet/statistics');
    } catch (caught) {
      setError(errorMessage(caught));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }
  function startBlock(): void {
    const block = newBlock(catalog);
    if (block) {
      setEditor(block);
      setError('');
    }
  }
  const filtered = reports.filter(
    (item) =>
      (filter === 'all' || item.visibility === filter) &&
      `${item.name} ${item.description}`
        .toLocaleLowerCase('ru-RU')
        .includes(search.toLocaleLowerCase('ru-RU')),
  );
  return (
    <section className={`${styles.page} ${styles.live}`} aria-label="Статистика">
      {error && (
        <div role="alert" className={styles.alert}>
          {error}
          <button className={styles.textButton} disabled={busy} onClick={reload}>
            Обновить страницу
          </button>
        </div>
      )}
      {sourcesError && (
        <div role="alert" className={styles.alert}>
          Не удалось обновить источники: {sourcesError}
          <button className={styles.textButton} onClick={reload}>
            Повторить
          </button>
        </div>
      )}
      {loading ? (
        <p className={styles.noData} role="status">
          Загрузка отчётов…
        </p>
      ) : reportId && !report ? (
        <Link className={styles.back} to="/cabinet/statistics">
          <Icon name="arrow" />
          Все отчёты
        </Link>
      ) : editor && report ? (
        <StatisticsEditor
          key={editor.id}
          initial={editor}
          catalog={catalog}
          range={range}
          busy={busy}
          onRefresh={() => setSourceAttempt((current) => current + 1)}
          onCancel={() => setEditor(null)}
          onSave={(block) =>
            saveBlocks(
              report.blocks.some((item) => item.id === block.id)
                ? report.blocks.map((item) => (item.id === block.id ? block : item))
                : [...report.blocks, block],
            )
          }
        />
      ) : report ? (
        <>
          <Link className={styles.back} to="/cabinet/statistics">
            <Icon name="arrow" />
            Все отчёты
          </Link>
          <div className={styles.pageHeading}>
            <div>
              <div className={styles.titleKicker}>
                <span className={styles.tag}>
                  {report.visibility === 'personal' ? 'Личный отчёт' : 'Общий отчёт'}
                </span>
                <span className={styles.smallMuted}>
                  Данные базы · {report.created_by_name || 'Автор удалён'}
                </span>
              </div>
              <h1>{report.name}</h1>
              {report.description && <p className={styles.subtitle}>{report.description}</p>}
            </div>
            <div className={styles.actions}>
              <button
                className={styles.secondary}
                disabled={busy}
                onClick={() => setDialog('settings')}
              >
                <Icon name="edit" />
                Настройки
              </button>
              <button
                className={styles.primary}
                disabled={!catalog.length || busy || report.blocks.length >= 40}
                onClick={startBlock}
              >
                <Icon name="plus" />
                Добавить блок
              </button>
            </div>
          </div>
          <div className={styles.reportToolbar}>
            <div className={styles.toolbarFields}>
              <label>
                <select
                  aria-label="Режим периода"
                  value={rangeMode}
                  onChange={(event) => {
                    setRangeMode(event.target.value);
                    if (event.target.value === 'month') setRange(currentMonth());
                  }}
                >
                  <option value="month">Месяц</option>
                  <option value="range">Произвольный период</option>
                </select>
              </label>
              {rangeMode === 'month' ? (
                <label>
                  <Icon name="calendar" />
                  <input
                    type="month"
                    aria-label="Месяц отчёта"
                    value={range.from.slice(0, 7)}
                    onChange={(event) => {
                      if (/^\d{4}-\d{2}$/.test(event.target.value))
                        setRange(currentMonth(new Date(`${event.target.value}-15T12:00:00Z`)));
                    }}
                  />
                </label>
              ) : (
                <>
                  <label>
                    От
                    <input
                      type="date"
                      aria-label="Начало периода"
                      value={range.from}
                      onChange={(event) => setRange({ ...range, from: event.target.value })}
                    />
                  </label>
                  <label>
                    До
                    <input
                      type="date"
                      aria-label="Конец периода"
                      value={range.to}
                      onChange={(event) => setRange({ ...range, to: event.target.value })}
                    />
                  </label>
                </>
              )}
              <label>
                <select
                  aria-label="Общежития отчёта"
                  value={dormitory}
                  onChange={(event) => setDormitory(event.target.value)}
                >
                  <option value="all">Все общежития · {catalog.length}</option>
                  {catalog.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.is_archived ? ' (Архив)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className={styles.textButton} disabled={busy} onClick={reload}>
              <Icon name="refresh" />
              Обновить
            </button>
          </div>
          {rangeError(range) && (
            <p role="alert" className={styles.alert}>
              {rangeError(range)}
            </p>
          )}
          {dataError && (
            <p role="alert" className={styles.alert}>
              {dataError}
              <button className={styles.textButton} onClick={reload}>
                Обновить отчёт
              </button>
            </p>
          )}
          {report.blocks.length ? (
            <>
              <p className={styles.periodNote}>
                {dataLoading
                  ? 'Обновление расчётов…'
                  : data?.through_date
                    ? `Расчёт по ${formatDate(data.through_date)} включительно. Будущие даты не учитываются.`
                    : 'За выбранный период нет доступных дат.'}
              </p>
              <div className={styles.blockGrid} aria-busy={dataLoading}>
                {report.blocks.map((block, index) => {
                  const result = data?.results.find((item) => item.id === block.id);
                  return (
                    <section key={block.id} className={`${styles.blockCard} ${styles.fullBlock}`}>
                      <div className={styles.blockHeading}>
                        <div>
                          <h2>{block.name}</h2>
                          <p>{sourceLabel(block, catalog)}</p>
                        </div>
                        <div className={styles.blockActions}>
                          <button
                            aria-label={`Поднять блок ${block.name}`}
                            disabled={index === 0 || busy}
                            onClick={() => {
                              const blocks = [...report.blocks];
                              [blocks[index - 1], blocks[index]] = [
                                blocks[index],
                                blocks[index - 1],
                              ];
                              void saveBlocks(blocks);
                            }}
                          >
                            ↑
                          </button>
                          <button
                            aria-label={`Опустить блок ${block.name}`}
                            disabled={index === report.blocks.length - 1 || busy}
                            onClick={() => {
                              const blocks = [...report.blocks];
                              [blocks[index + 1], blocks[index]] = [
                                blocks[index],
                                blocks[index + 1],
                              ];
                              void saveBlocks(blocks);
                            }}
                          >
                            ↓
                          </button>
                          <button
                            aria-label={`Редактировать блок ${block.name}`}
                            disabled={busy}
                            onClick={() => {
                              setError('');
                              setEditor(block);
                            }}
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            aria-label={`Удалить блок ${block.name}`}
                            disabled={busy}
                            onClick={() => setDeleting(block.id)}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </div>
                      {result ? (
                        <StatisticsChart block={block} result={result} range={range} />
                      ) : (
                        <p className={styles.noData} role="status">
                          {dataLoading ? 'Расчёт…' : 'Данные не загружены'}
                        </p>
                      )}
                      {result?.errors.length ? (
                        <ul className={styles.blockErrors}>
                          {result.errors.map((message, i) => (
                            <li key={i}>{message}</li>
                          ))}
                        </ul>
                      ) : null}
                      <div className={styles.metricFooter}>
                        <span>{operations[block.aggregation]}</span>
                        <span>{displayNames[block.display]}</span>
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          ) : (
            <div className={styles.emptyReport}>
              <span>
                <Icon name="layers" />
              </span>
              <h2>Соберите свой отчёт</h2>
              <p>Добавьте первый блок: показатель, график или таблицу по общежитиям и датам.</p>
              <button className={styles.primary} disabled={!catalog.length} onClick={startBlock}>
                <Icon name="plus" />
                Добавить первый блок
              </button>
            </div>
          )}
          {report.can_manage && (
            <button
              className={`${styles.textButton} ${styles.deleteReport}`}
              disabled={busy}
              onClick={() => setDeleting('report')}
            >
              <Icon name="trash" />
              Удалить отчёт
            </button>
          )}
        </>
      ) : (
        <>
          <div className={styles.pageHeading}>
            <div>
              <p className={styles.eyebrow}>СТАТИСТИКА</p>
              <h1>Ваши отчёты</h1>
              <p className={styles.subtitle}>Нужные показатели — в удобном для вас виде.</p>
            </div>
            <button className={styles.primary} onClick={() => setDialog('create')}>
              <Icon name="plus" />
              Создать отчёт
            </button>
          </div>
          <div className={styles.intro}>
            <div>
              <div className={styles.introKicker}>
                <span />
                КОНСТРУКТОР ОТЧЁТОВ
              </div>
              <h2>От данных — к понятной картине</h2>
              <p>
                Объединяйте показатели общежитий, сравнивайте даты,
                <br className={styles.desktopBreak} /> собирайте числа, графики и таблицы в одном
                отчёте.
              </p>
              <button className={styles.introLink} onClick={() => setDialog('create')}>
                Собрать свой отчёт
                <Icon name="chevron" />
              </button>
            </div>
            <div className={styles.libraryArt} aria-hidden="true">
              <Icon name="bar" />
              <Icon name="table" />
              <Icon name="pie" />
            </div>
          </div>
          <div className={styles.libraryToolbar}>
            <div className={styles.tabs} role="group" aria-label="Доступ к отчётам">
              {[
                ['all', 'Все отчёты'],
                ['shared', 'Общие'],
                ['personal', 'Личные'],
              ].map(([key, name]) => (
                <button
                  key={key}
                  className={filter === key ? styles.tabActive : ''}
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {name}
                </button>
              ))}
            </div>
            <label className={styles.search}>
              <Icon name="search" />
              <input
                aria-label="Поиск отчёта"
                placeholder="Найти отчёт…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          {!filtered.length && (
            <p className={styles.periodNote}>
              {reports.length
                ? 'По вашему запросу отчётов не найдено.'
                : 'Пока нет отчётов. Создайте первый и добавьте нужные блоки.'}
            </p>
          )}
          <div className={styles.reportCards}>
            {filtered.map((item) => (
              <Link
                key={item.id}
                to={`/cabinet/statistics/${item.id}`}
                className={styles.reportCard}
              >
                <div className={styles.reportCardTop}>
                  <span className={styles.reportIcon}>
                    <Icon name={item.blocks[0]?.display ?? 'layers'} />
                  </span>
                  <span className={styles.tag}>
                    {item.visibility === 'personal' ? 'Личный' : 'Общий'}
                  </span>
                </div>
                <h2>{item.name}</h2>
                <p>{item.description || 'Отчёт по данным общежитий'}</p>
                <div className={styles.blockComposition}>
                  {item.blocks.length ? (
                    item.blocks.slice(0, 6).map((block) => (
                      <span key={block.id}>
                        <Icon name={block.display} />
                        {displayNames[block.display]}
                      </span>
                    ))
                  ) : (
                    <span>Добавьте первый блок</span>
                  )}
                </div>
                <div className={styles.cardFooter}>
                  <span>
                    {item.blocks.length} блоков · {item.created_by_name || 'Автор удалён'}
                  </span>
                  <span>
                    Открыть
                    <Icon name="chevron" />
                  </span>
                </div>
              </Link>
            ))}
            <button className={styles.newReportCard} onClick={() => setDialog('create')}>
              <span>
                <Icon name="plus" />
              </span>
              <strong>Создать отчёт</strong>
              <p>Соберите то, что нужно именно вам</p>
            </button>
          </div>
          <div className={styles.howItWorks}>
            <div>
              <span>1</span>
              <strong>Выберите данные</strong>
              <p>Любые вкладки и строки</p>
            </div>
            <Icon name="chevron" />
            <div>
              <span>2</span>
              <strong>Настройте расчёт</strong>
              <p>Период, условия, общежития</p>
            </div>
            <Icon name="chevron" />
            <div>
              <span>3</span>
              <strong>Выберите вид</strong>
              <p>Числа, графики и таблицы</p>
            </div>
          </div>
        </>
      )}
      {dialog && (
        <ReportDialog
          report={dialog === 'settings' ? report : null}
          onClose={() => setDialog(null)}
          onSave={async (input) => {
            if (dialog === 'create') {
              const created = await statisticsApi.create(input);
              setDialog(null);
              navigate(`/cabinet/statistics/${created.id}`);
            } else {
              await persist(input);
              setDialog(null);
            }
          }}
        />
      )}
      {deleting && report && (
        <Modal
          title={deleting === 'report' ? 'Удалить отчёт?' : 'Удалить блок?'}
          testId="statistics-delete-dialog"
          onClose={() => setDeleting(null)}
          closeDisabled={busy}
          panelClassName={styles.smallModal}
          containerClassName={styles.modalTheme}
        >
          <p>
            {deleting === 'report'
              ? `Отчёт «${report.name}» и настройки всех его блоков будут удалены. Исходные данные общежитий сохранятся.`
              : 'Блок будет удалён из отчёта. Исходные данные общежитий сохранятся.'}
          </p>
          <div className={styles.modalFooter}>
            <button className={styles.secondary} disabled={busy} onClick={() => setDeleting(null)}>
              Отмена
            </button>
            <button className={styles.primary} disabled={busy} onClick={() => void remove()}>
              {busy ? 'Удаление…' : 'Удалить'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
