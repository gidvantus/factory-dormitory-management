import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type { Dormitory } from '../../api/client';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { currentMonth, formatDate, rangeError } from '../dashboard/dates';
import type { DateRange } from '../dashboard/dates';
import styles from './Dormitories.module.css';
import { HostelPlaces } from './HostelPlaces';
import { InflowTable } from './InflowTable';
import { OutflowTable } from './OutflowTable';
import { PaymentsTable } from './PaymentsTable';
import { ReportTable } from './ReportTable';
import { ResidentsTable } from './ResidentsTable';

const sections = [
  { path: 'report', label: 'Большой отчёт' },
  { path: 'places', label: 'Места' },
  { path: 'residents', label: 'Проживающие' },
  { path: 'movement', label: 'Движение персонала' },
  { path: 'payments', label: 'Выплаты' },
  { path: 'archive', label: 'Архив' },
] as const;

const subsections: Record<string, { path: string; label: string }[]> = {
  movement: [
    { path: 'inflow', label: 'Приток' },
    { path: 'outflow', label: 'Отток' },
  ],
  payments: [
    { path: 'advance', label: 'На аванс' },
    { path: 'settlement', label: 'На расчёт' },
  ],
};

export function DormitoryDetails(): JSX.Element {
  const { dormitoryId = '', '*': sectionPath = '' } = useParams();
  const [primaryPath, secondaryPath, ...extraPath] = sectionPath.split('/');
  const section = sections.find(({ path }) => path === (primaryPath || 'report'));
  const secondaryOptions = section ? subsections[section.path] : undefined;
  const selectedSecondary = secondaryPath || secondaryOptions?.[0]?.path;
  const sectionFound =
    section &&
    extraPath.length === 0 &&
    (!secondaryPath || secondaryOptions?.some(({ path }) => path === secondaryPath));
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [dormitory, setDormitory] = useState<Dormitory | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [range, setRange] = useState<DateRange>(() => currentMonth());
  const [draft, setDraft] = useState<DateRange>(range);
  const [placesMonth, setPlacesMonth] = useState(() => currentMonth().from.slice(0, 7));
  const [periodError, setPeriodError] = useState('');

  function applyPeriod(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const message = rangeError(draft);
    setPeriodError(message);
    if (!message) setRange({ ...draft });
  }

  function resetPeriod(): void {
    const month = currentMonth();
    setDraft(month);
    setRange(month);
    setPeriodError('');
  }

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .dormitory(dormitoryId, controller.signal)
      .then((item) => {
        if (!controller.signal.aborted) {
          setDormitory(item);
          setStatus('ready');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDormitory(null);
          setStatus(
            error instanceof ApiError && [404, 422].includes(error.status) ? 'missing' : 'error',
          );
        }
      });
    return () => controller.abort();
  }, [dormitoryId, attempt]);

  return (
    <section className={styles.page} aria-label="Общежитие" data-testid="dormitory-details-page">
      <Link
        to="/cabinet/dormitories"
        className={styles.backLink}
        data-testid="dormitory-back"
        data-workspace-focus
      >
        <WorkspaceIcon name="chevron" />
        Назад
      </Link>
      {status === 'ready' && dormitory && (
        <>
          <div className={styles.detailsHeading}>
            <div className={styles.detailsHeadingCopy}>
              <p className={styles.detailsClient}>Клиент: {dormitory.client_name}</p>
              <h1 tabIndex={-1}>Общежитие «{dormitory.name}»</h1>
            </div>
            {section?.path !== 'places' &&
              !(section?.path === 'payments' && selectedSecondary === 'advance') && (
                <form
                  className={styles.periodForm}
                  aria-label="Период общежития"
                  onSubmit={applyPeriod}
                  noValidate
                >
                  <div className={styles.periodFields}>
                    <label className={styles.periodField} htmlFor="dormitory-period-from">
                      От
                      <input
                        id="dormitory-period-from"
                        data-testid="dormitory-period-from"
                        type="date"
                        value={draft.from}
                        onChange={(event) => {
                          setDraft({ ...draft, from: event.target.value });
                          setPeriodError('');
                        }}
                        aria-invalid={!!periodError}
                        aria-describedby={periodError ? 'dormitory-period-error' : undefined}
                      />
                    </label>
                    <label className={styles.periodField} htmlFor="dormitory-period-to">
                      До
                      <input
                        id="dormitory-period-to"
                        data-testid="dormitory-period-to"
                        type="date"
                        value={draft.to}
                        onChange={(event) => {
                          setDraft({ ...draft, to: event.target.value });
                          setPeriodError('');
                        }}
                        aria-invalid={!!periodError}
                        aria-describedby={periodError ? 'dormitory-period-error' : undefined}
                      />
                    </label>
                    <button className="btn btn--primary btn--sm" type="submit">
                      Применить
                    </button>
                    <button className="btn btn--ghost btn--sm" type="button" onClick={resetPeriod}>
                      Текущий месяц
                    </button>
                  </div>
                  {periodError && (
                    <p className={styles.periodError} id="dormitory-period-error" role="alert">
                      {periodError}
                    </p>
                  )}
                </form>
              )}
          </div>
          <nav className={styles.tabScroller} aria-label="Разделы общежития">
            <div className={styles.tabs}>
              {sections.map(({ path, label }) => (
                <Link
                  key={path}
                  to={`/cabinet/dormitories/${dormitoryId}/${path}`}
                  className={styles.tab}
                  aria-current={section?.path === path ? 'page' : undefined}
                  data-testid={`dormitory-tab-${path}`}
                >
                  {label}
                </Link>
              ))}
            </div>
          </nav>
          {sectionFound && secondaryOptions && (
            <nav className={styles.subtabs} aria-label={`Разделы: ${section.label}`}>
              {secondaryOptions.map(({ path, label }) => (
                <Link
                  key={path}
                  to={`/cabinet/dormitories/${dormitoryId}/${section.path}/${path}`}
                  className={styles.subtab}
                  aria-current={selectedSecondary === path ? 'page' : undefined}
                  data-testid={`dormitory-subtab-${path}`}
                >
                  {label}
                </Link>
              ))}
            </nav>
          )}
          {sectionFound && section.path === 'report' ? (
            <ReportTable dormitoryId={dormitoryId} range={range} />
          ) : sectionFound && section.path === 'places' ? (
            <HostelPlaces
              dormitoryId={dormitoryId}
              month={placesMonth}
              onMonthChange={setPlacesMonth}
            />
          ) : sectionFound && section.path === 'residents' ? (
            <ResidentsTable dormitoryId={dormitoryId} />
          ) : sectionFound && section.path === 'movement' && selectedSecondary === 'inflow' ? (
            <InflowTable dormitoryId={dormitoryId} range={range} />
          ) : sectionFound && section.path === 'movement' && selectedSecondary === 'outflow' ? (
            <OutflowTable dormitoryId={dormitoryId} range={range} />
          ) : sectionFound &&
            section.path === 'payments' &&
            (selectedSecondary === 'advance' || selectedSecondary === 'settlement') ? (
            <PaymentsTable dormitoryId={dormitoryId} kind={selectedSecondary} range={range} />
          ) : sectionFound ? (
            <div className={styles.emptySection} data-testid="dormitory-section">
              <h2>
                {secondaryOptions
                  ? secondaryOptions.find(({ path }) => path === selectedSecondary)?.label
                  : section.label}
              </h2>
              <p data-testid="dormitory-period-applied">
                Период: {formatDate(range.from)} — {formatDate(range.to)}
              </p>
              <p>Содержимое раздела добавим позже.</p>
            </div>
          ) : (
            <p className={styles.error} role="alert">
              Раздел не найден.
            </p>
          )}
        </>
      )}
      {status === 'loading' && (
        <p className={styles.status} role="status">
          Загружаем общежитие…
        </p>
      )}
      {status === 'missing' && (
        <p className={styles.error} role="alert">
          Общежитие не найдено.
        </p>
      )}
      {status === 'error' && (
        <div className={styles.error} role="alert">
          <p>Не удалось загрузить общежитие.</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => setAttempt((current) => current + 1)}
          >
            Повторить
          </button>
        </div>
      )}
    </section>
  );
}
