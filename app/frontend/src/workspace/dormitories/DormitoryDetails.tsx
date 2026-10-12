import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type { CustomTab, Dormitory } from '../../api/client';
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
import { ArchiveTable } from './ArchiveTable';
import { CustomTabTable } from './CustomTabTable';
import { DormitorySettingsDialog } from './DormitorySettingsDialog';
import { SettingsContext } from './settingsContext';
import { ReportReadiness } from './ReportReadiness';

import {
  standardTabs as sections,
  standardParents,
  standardChain,
  standardPath,
  customChain,
} from './tabStructure';

export function DormitoryDetails(): JSX.Element {
  const navigate = useNavigate();
  const [sourceParams] = useSearchParams();
  const { dormitoryId = '', '*': sectionPath = '' } = useParams();
  const [primaryPath, secondaryPath, ...extraPath] = sectionPath.split('/');
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [dormitory, setDormitory] = useState<Dormitory | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [range, setRange] = useState<DateRange>(() => currentMonth());
  const [draft, setDraft] = useState<DateRange>(range);
  useEffect(() => {
    const from = sourceParams.get('from');
    const to = sourceParams.get('to');
    if (
      from &&
      to &&
      /^\d{4}-\d{2}-\d{2}$/.test(from) &&
      /^\d{4}-\d{2}-\d{2}$/.test(to) &&
      !rangeError({ from, to })
    ) {
      setRange({ from, to });
      setDraft({ from, to });
    }
  }, [sourceParams]);
  const [placesMonth, setPlacesMonth] = useState(() => currentMonth().from.slice(0, 7));
  const [periodError, setPeriodError] = useState('');
  const [customTabs, setCustomTabs] = useState<CustomTab[]>([]);
  const [tabsLoading, setTabsLoading] = useState(true);
  const [tabsError, setTabsError] = useState('');
  const [tabsAttempt, setTabsAttempt] = useState(0);
  const [settings, setSettings] = useState<{
    key?: string;
    page?: 'structure' | 'links' | 'templates';
  } | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const waitForTabSaves = useRef<(() => Promise<void>) | null>(null);
  const tabScroller = useRef<HTMLElement>(null);

  const selectedCustomTab =
    primaryPath === 'custom' && extraPath.length <= 1
      ? customTabs.find(
          (tab) =>
            String(tab.id) === (extraPath[0] || secondaryPath) &&
            (!extraPath[0] || String(tab.parent_id) === secondaryPath),
        )
      : undefined;
  const customAncestors = selectedCustomTab ? customChain(selectedCustomTab, customTabs) : [];
  const selectedCustomRoot = customAncestors[0];
  const states = dormitory?.section_states ?? {};
  const parents = standardParents(dormitory);
  const active = (key: string): boolean => (states[key] ?? 'active') === 'active';
  const routeStandard =
    primaryPath === 'custom'
      ? selectedCustomRoot?.parent_section
      : secondaryPath || primaryPath || 'report';
  const standardKey =
    primaryPath !== 'custom' &&
    !secondaryPath &&
    ['movement', 'payments'].includes(routeStandard || '')
      ? sections.find((item) => parents[item.path] === routeStandard && active(item.path))?.path ||
        routeStandard
      : routeStandard;
  const section = sections.find((item) => item.path === standardKey);
  const sectionFound =
    !!section &&
    extraPath.length === 0 &&
    (!secondaryPath || parents[secondaryPath] === primaryPath);
  const selectedStandardKeys = standardKey ? standardChain(standardKey, parents) : [];
  const standardDeleted = selectedStandardKeys.some((key) => states[key] === 'deleted');
  const standardReadOnly = selectedStandardKeys.some((key) => states[key] === 'hidden');
  const customReadOnly =
    standardReadOnly || standardDeleted || customAncestors.some((tab) => !tab.is_active);
  const rootSections = sections.filter(({ path }) => !parents[path]);
  const fallbackPath =
    rootSections.find(({ path }) => active(path))?.path ??
    (customTabs.find((tab) => !tab.parent_id && !tab.parent_section && tab.is_active)
      ? 'custom/' +
        customTabs.find((tab) => !tab.parent_id && !tab.parent_section && tab.is_active)?.id
      : '');
  const customPath = (tab: CustomTab): string => 'custom/' + tab.id;
  // A section can have every subtab hidden or removed. Keep its management reachable.

  useEffect(() => {
    const scroller = tabScroller.current;
    const active = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (primaryPath !== 'custom' || !scroller || !active) return;
    const bounds = scroller.getBoundingClientRect();
    const selected = active.getBoundingClientRect();
    if (selected.left < bounds.left || selected.right > bounds.right) {
      scroller.scrollLeft += selected.left - bounds.left;
    }
  }, [primaryPath, selectedCustomTab?.id, status]);

  useEffect(() => {
    const controller = new AbortController();
    setCustomTabs([]);
    setTabsLoading(true);
    setTabsError('');

    void api
      .customTabs(dormitoryId, controller.signal)
      .then((tabs) => {
        if (!controller.signal.aborted) {
          setCustomTabs(tabs);
          setTabsLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setTabsError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить вкладки.',
          );
          setTabsLoading(false);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, tabsAttempt]);

  useEffect(() => {
    if (status === 'ready' && !primaryPath && fallbackPath && fallbackPath !== 'report')
      navigate('/cabinet/dormitories/' + dormitoryId + '/' + fallbackPath, { replace: true });
  }, [status, primaryPath, fallbackPath, dormitoryId, navigate]);

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
              {dormitory.is_archived && <span className={styles.archiveBadge}>Архив</span>}
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                setSettings({ key: selectedCustomTab?.table_key ?? standardKey ?? 'residents' })
              }
            >
              Настроить
            </button>
            {section?.path !== 'places' && primaryPath !== 'custom' && (
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
          <ReportReadiness key={dormitoryId} dormitoryId={dormitoryId} />
          <nav ref={tabScroller} className={styles.tabScroller} aria-label="Разделы общежития">
            <div className={styles.tabs}>
              {rootSections
                .filter(({ path }) => active(path))
                .map(({ path, label }) => (
                  <Link
                    key={path}
                    to={`/cabinet/dormitories/${dormitoryId}/${path}`}
                    className={styles.tab}
                    aria-current={selectedStandardKeys.includes(path) ? 'page' : undefined}
                    data-testid={`dormitory-tab-${path}`}
                  >
                    {label}
                  </Link>
                ))}
              {customTabs
                .filter((tab) => !tab.parent_id && !tab.parent_section && tab.is_active)
                .map((tab) => (
                  <Link
                    key={tab.id}
                    to={`/cabinet/dormitories/${dormitoryId}/custom/${tab.id}`}
                    className={styles.tab}
                    aria-current={selectedCustomRoot?.id === tab.id ? 'page' : undefined}
                    data-testid={`dormitory-custom-tab-${tab.id}`}
                  >
                    {tab.name}
                  </Link>
                ))}
            </div>
          </nav>
          {tabsError && (
            <p role="alert" className={styles.tabsError}>
              {tabsError}{' '}
              <button type="button" onClick={() => setTabsAttempt((n) => n + 1)}>
                Повторить загрузку вкладок
              </button>
            </p>
          )}

          {selectedStandardKeys.map((key) => {
            const label = sections.find((item) => item.path === key)?.label;
            const children = sections.filter(
              (item) => parents[item.path] === key && active(item.path),
            );
            const custom = customTabs.filter(
              (tab) => !tab.parent_id && tab.parent_section === key && tab.is_active,
            );
            return (
              <nav key={key} className={styles.subtabs} aria-label={'Разделы: ' + label}>
                {!['movement', 'payments'].includes(key) && custom.length > 0 && (
                  <Link
                    className={styles.subtab}
                    to={'/cabinet/dormitories/' + dormitoryId + '/' + standardPath(key, parents)}
                    aria-current={
                      primaryPath !== 'custom' && standardKey === key ? 'page' : undefined
                    }
                  >
                    Основная таблица
                  </Link>
                )}
                {children.map((item) => (
                  <Link
                    key={item.path}
                    className={styles.subtab}
                    to={
                      '/cabinet/dormitories/' + dormitoryId + '/' + standardPath(item.path, parents)
                    }
                    data-testid={'dormitory-subtab-' + item.path}
                    aria-current={selectedStandardKeys.includes(item.path) ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                ))}
                {custom.map((tab) => (
                  <Link
                    key={tab.id}
                    className={styles.subtab}
                    to={'/cabinet/dormitories/' + dormitoryId + '/' + customPath(tab)}
                    aria-current={
                      customAncestors.some((item) => item.id === tab.id) ? 'page' : undefined
                    }
                  >
                    {tab.name}
                  </Link>
                ))}
              </nav>
            );
          })}
          {customAncestors.map((node) => {
            const children = customTabs.filter((tab) => tab.parent_id === node.id && tab.is_active);
            return (
              <nav key={node.id} className={styles.subtabs} aria-label={'Подвкладки: ' + node.name}>
                {children.length > 0 && (
                  <Link
                    className={styles.subtab}
                    to={'/cabinet/dormitories/' + dormitoryId + '/' + customPath(node)}
                    aria-current={selectedCustomTab?.id === node.id ? 'page' : undefined}
                  >
                    Основная таблица
                  </Link>
                )}
                {children.map((tab) => (
                  <Link
                    key={tab.id}
                    className={styles.subtab}
                    to={'/cabinet/dormitories/' + dormitoryId + '/' + customPath(tab)}
                    aria-current={
                      customAncestors.some((item) => item.id === tab.id) ? 'page' : undefined
                    }
                  >
                    {tab.name}
                  </Link>
                ))}
              </nav>
            );
          })}
          {primaryPath !== 'custom' && standardReadOnly && (
            <p role="status">
              Вкладка скрыта. Данные доступны только для просмотра и продолжают учитываться в
              отчётах.
            </p>
          )}
          {section?.path === 'places' && standardReadOnly && !standardDeleted && (
            <label>
              Месяц просмотра{' '}
              <input
                type="month"
                value={placesMonth}
                onChange={(event) => {
                  if (event.target.value) setPlacesMonth(event.target.value);
                }}
              />
            </label>
          )}
          <SettingsContext.Provider
            value={{
              open: (key, page) => setSettings({ key, page }),
              revision: settingsRevision,
              readOnly: primaryPath === 'custom' ? customReadOnly : standardReadOnly,
            }}
          >
            {standardDeleted ? (
              <div className={styles.emptySection}>
                <h2>Вкладка удалена</h2>
                <p>Добавьте её обратно через «Настроить».</p>
              </div>
            ) : (
              <fieldset disabled={standardReadOnly} className={styles.sectionContent}>
                {primaryPath === 'custom' ? (
                  tabsLoading ? (
                    <p role="status">Загружаем вкладку…</p>
                  ) : selectedCustomTab ? (
                    <CustomTabTable
                      key={`${dormitoryId}:${selectedCustomTab.id}`}
                      dormitoryId={dormitoryId}
                      tab={
                        customReadOnly
                          ? { ...selectedCustomTab, is_active: false }
                          : selectedCustomTab
                      }
                      waitForSavesRef={waitForTabSaves}
                      onChanged={(updated) =>
                        setCustomTabs((tabs) =>
                          tabs.map((tab) => (tab.id === updated.id ? updated : tab)),
                        )
                      }
                    />
                  ) : selectedCustomRoot?.is_group ? (
                    <div className={styles.emptySection}>
                      <h2>{selectedCustomRoot.name}</h2>
                      <p>
                        {selectedCustomRoot.is_active
                          ? 'Нет активных подвкладок. Добавьте новую или восстановите существующую через «Настроить».'
                          : 'Раздел скрыт. Подвкладки доступны через «Настроить».'}
                      </p>
                    </div>
                  ) : !tabsError ? (
                    <div className={styles.emptySection}>
                      <h2>Вкладка не найдена</h2>
                      <p>Выберите другую вкладку общежития.</p>
                    </div>
                  ) : null
                ) : sectionFound && section.path === 'report' ? (
                  <ReportTable dormitoryId={dormitoryId} range={range} />
                ) : sectionFound && section.path === 'places' ? (
                  <HostelPlaces
                    dormitoryId={dormitoryId}
                    month={placesMonth}
                    onMonthChange={setPlacesMonth}
                  />
                ) : sectionFound && section.path === 'residents' ? (
                  <ResidentsTable dormitoryId={dormitoryId} />
                ) : sectionFound && standardKey === 'inflow' ? (
                  <InflowTable dormitoryId={dormitoryId} range={range} />
                ) : sectionFound && standardKey === 'outflow' ? (
                  <OutflowTable dormitoryId={dormitoryId} range={range} />
                ) : sectionFound && (standardKey === 'advance' || standardKey === 'settlement') ? (
                  <PaymentsTable
                    dormitoryId={dormitoryId}
                    kind={standardKey as 'advance' | 'settlement'}
                    range={range}
                  />
                ) : sectionFound && section.path === 'archive' ? (
                  <ArchiveTable dormitoryId={dormitoryId} range={range} />
                ) : sectionFound ? (
                  <div className={styles.emptySection} data-testid="dormitory-section">
                    <h2>{section.label}</h2>
                    <p data-testid="dormitory-period-applied">
                      Период: {formatDate(range.from)} — {formatDate(range.to)}
                    </p>
                    <p>
                      Нет активных подвкладок. Восстановите или добавьте их обратно через
                      «Настроить».
                    </p>
                  </div>
                ) : (
                  <p className={styles.error} role="alert">
                    Раздел не найден.
                  </p>
                )}
              </fieldset>
            )}
          </SettingsContext.Provider>
          {settings && (
            <DormitorySettingsDialog
              dormitoryId={dormitoryId}
              initialKey={settings.key}
              initialPage={settings.page}
              onClose={() => setSettings(null)}
              onChanged={(data) => {
                setCustomTabs(data.tabs);
                setDormitory((current) =>
                  current
                    ? {
                        ...current,
                        section_states: Object.fromEntries(
                          data.sections.map((item) => [item.key, item.status]),
                        ),
                      }
                    : current,
                );
                setSettingsRevision((value) => value + 1);
              }}
              onOpen={(key) => {
                setSettings(null);
                navigate(
                  '/cabinet/dormitories/' +
                    dormitoryId +
                    '/' +
                    (key.startsWith('custom_')
                      ? 'custom/' + key.slice(7)
                      : standardPath(key, parents)),
                );
              }}
            />
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
