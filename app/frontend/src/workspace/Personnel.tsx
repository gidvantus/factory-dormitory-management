import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { personnelApi } from '../api/personnel';
import type {
  Block,
  Employee,
  EmployeeColumnFilter,
  Filter,
  PersonnelData,
  Preferences,
  SavedList,
} from '../api/personnel';
import { useSession } from '../auth/SessionProvider';
import { currentMonth, dateNumber } from './dashboard/dates';
import type { DateRange } from './dashboard/dates';
import { DormitoryPeriod } from './dormitories/DormitoryPeriod';
import { useFrameRefresh, usePageRefresh } from './usePageRefresh';
import { ArrivalPlanningBoard } from './personnel/ArrivalPlanningBoard';
import { ArrivalPlanningPage } from './personnel/ArrivalPlanningPage';
import { PersonnelEmployeeFocus } from './personnel/PersonnelEmployeeFocus';
import { BlockDialog, SaveListDialog } from './personnel/Dialogs';
import type { Mutate } from './personnel/Forms';
import { PersonnelProfile } from './personnel/PersonnelProfile';
import type { ProfileTab } from './personnel/PersonnelProfile';
import { PersonnelWorkspaceBlock } from './personnel/PersonnelWorkspaceBlock';
import { PersonnelBlockIcon } from './personnel/PersonnelBlockIcon';
import { EmployeeListFilters } from './personnel/EmployeeListFilterPanel';
import { SelectedEmployeesDialog } from './personnel/SelectedEmployeesDialog';
import {
  useEmployeeList,
  useDebounced,
  useEmployeeCounts,
  PAGE_SIZE,
} from './personnel/serverList';
import { employeeListFields, sourceInScope } from './personnel/employeeListFilters';
import plant from '../assets/plant.svg';
import resident from '../assets/avatar-rezident.svg';
import personnel from '../assets/avatar-kadrovik.svg';
import manager from '../assets/avatar-komendant.svg';
import {
  dateLabel,
  dayDiff,
  defaultBlocks,
  dormName,
  endingRange,
  message,
  names,
} from './personnel/helpers';
import s from './personnel/Personnel.module.css';
import w from './personnel/PersonnelWorkspace.module.css';
import listStyles from './personnel/EmployeeList.module.css';
import f from './personnel/PersonnelFocus.module.css';
import type { PersonnelPageExtension } from './personnel/PersonnelPageExtension';

type View = 'workspace' | 'list' | 'planning';
type OpenPerson = (id: string, tab?: ProfileTab) => void;
type Criteria = Omit<SavedList, 'id' | 'name'>;

export function Personnel({ extension }: { extension?: PersonnelPageExtension } = {}): JSX.Element {
  const [params] = useSearchParams();
  return params.get('view') === 'planning' && !extension?.active ? (
    <ArrivalPlanningPage extension={extension} />
  ) : (
    <PersonnelDirectory extension={extension} />
  );
}

function PersonnelDirectory({ extension }: { extension?: PersonnelPageExtension }): JSX.Element {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('employee');
  const [profileTab, setProfileTab] = useState<ProfileTab>('overview');
  const [data, setData] = useState<PersonnelData | null>(null);
  const onData = extension?.onData;
  useEffect(() => {
    if (data) onData?.(data);
  }, [data, onData]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [view, setViewState] = useState<View>(
    params.get('view') === 'planning'
      ? 'planning'
      : params.get('view') === 'list'
        ? 'list'
        : 'workspace',
  );
  const extended = !!extension,
    customActive = !!extension?.active;
  useEffect(() => {
    if (extended && !customActive)
      setViewState(params.get('view') === 'list' ? 'list' : 'workspace');
  }, [extended, customActive, params]);
  function setView(next: View): void {
    setViewState(next);
    setParams((previous) => {
      const result = new URLSearchParams(previous);
      result.set('view', next);
      if (extension) result.delete('tab');
      if (next === 'planning') {
        if (dormitory && !data?.dormitories.find((item) => item.id === dormitory)?.is_archived)
          result.set('dormitory', String(dormitory));
        else result.delete('dormitory');
      }
      return result;
    });
  }
  const [dormitory, setDormitory] = useState<number | null>(() => {
    const id = Number(params.get('dormitory'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const [selectedPeriod, setSelectedPeriod] = useState<DateRange | null>(null);
  const today = data?.today;
  const monthPeriod = useMemo(
    () => (today ? currentMonth(new Date(dateNumber(today))) : currentMonth()),
    [today],
  );
  /**
   * Тот же диапазон, но с устойчивой ссылкой: `monthPeriod` пересчитывается,
   * когда из рамки приходит `today`, и новый объект с теми же датами дёргал
   * эффект рамки вторым запросом на одно открытие (#261).
   */
  const fallbackPeriod = useMemo(
    () => ({ from: monthPeriod.from, to: monthPeriod.to }),
    [monthPeriod.from, monthPeriod.to],
  );
  const period = selectedPeriod ?? fallbackPeriod;
  /**
   * Сервер списка и сводки работает в днях (`days`), а панель показывает диапазон
   * дат. Дни считаются из выбранного диапазона, как и раньше при фильтрации в
   * браузере: одна и та же граница у «завершают вахту» и у блоков.
   */
  const days = Math.min(365, Math.max(1, dayDiff(period.from, period.to)));
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<number[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [columnFilters, setColumnFilters] = useState<EmployeeColumnFilter[]>([]);
  const [selectedList, setSelectedList] = useState<string[] | null>(null);
  const [page, setPage] = useState(0);
  const [configuring, setConfiguring] = useState(false);
  const [blockEditor, setBlockEditor] = useState<Block | 'new' | null>(null);
  const [savingList, setSavingList] = useState(false);
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  /**
   * Две ревизии вместо одной (#251): рамка обновляется ещё и по таймеру, а страница
   * сотрудников и её счётчики — только по фокусу и после сохранений. Иначе открытая
   * вкладка раз в минуту тянула карточки списка. Поэтому общий таймер `usePageRefresh`
   * здесь выключен, а его роль играет `useFrameRefresh`.
   */
  const refresh = usePageRefresh({ timer: false });
  const frameRefresh = useFrameRefresh();
  /**
   * Условия, по которым реально идёт запрос: поиск и условия столбцов применяются
   * после паузы в наборе (#247). Каждый запрос сервер собирает карточки всей
   * организации заново, поэтому буква в поиске не должна стоить отдельной сборки.
   */
  const debouncedQuery = useDebounced(query);
  const debouncedColumnFilters = useDebounced(columnFilters);
  useEffect(() => {
    if (user?.is_active === false || mutating.current) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void personnelApi
      .workspace(controller.signal, { employees: 'none', dormitory, days, period })
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(message(caught));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [attempt, refresh, frameRefresh, user?.is_active, dormitory, days, period]);
  const criteria: Criteria = {
    filter,
    dormitory,
    days,
    period,
    query: debouncedQuery,
    scope,
    column_filters: debouncedColumnFilters,
  };
  const revision = attempt + refresh;
  /**
   * Условия для полей ввода и сохранения списка: показывают набранное сразу, тогда
   * как запросы идут по условиям после паузы. Иначе строка фильтра появлялась бы
   * в самой панели с задержкой.
   */
  const shownCriteria: Criteria = { ...criteria, query, column_filters: columnFilters };
  /**
   * Страница сотрудников приходит с сервера (#247): условия, сортировка и
   * разбиение на страницы считаются там, браузер рисует только полученные карточки.
   */
  const list = useEmployeeList(criteria, page, view === 'list', revision);
  /**
   * Сводка поверхности приходит в рамке полем `counts` (#247): раньше три числа
   * считались в браузере по всему массиву, а без массива стоили бы трёх запросов
   * страницы, каждый из которых пересобирает карточки заново.
   */
  const summary = (id: Filter): number | null => data?.counts?.[id] ?? null;
  /** Счётчики списка при пустых поиске и фильтрах совпадают со сводкой — второй раз их не считаем. */
  const sameAsSummary = !debouncedQuery.trim() && !scope.length && !debouncedColumnFilters.length;
  /**
   * У активного фильтра число уже пришло с показанной страницей (`total`), поэтому
   * отдельный запрос нужен только второму статусу (#247).
   */
  const otherFilters = (['current', 'ending'] as Filter[]).filter((id) => id !== filter);
  const listCounts = useEmployeeCounts(
    criteria,
    otherFilters,
    view === 'list' && !sameAsSummary,
    revision,
  );
  /**
   * Ответ за пределами последнего листа: условия сузили список, пока человек стоял
   * на третьей странице. Показываем последнюю существующую, а не пустой экран (#247).
   */
  useEffect(() => {
    if (!list.result) return;
    if (page > 0 && page >= list.result.pages) setPage(Math.max(0, list.result.pages - 1));
  }, [list.result, page]);
  /**
   * Карточки, которые уже показывались. Полного списка на странице больше нет,
   * поэтому профиль и «Список выбранных» берут карточку отсюда.
   */
  const cards = useRef(new Map<string, Employee>());
  useEffect(() => {
    for (const person of list.result?.items ?? []) cards.current.set(person.id, person);
  }, [list.result]);
  useEffect(() => {
    for (const preview of data?.block_previews ?? [])
      for (const person of preview.items) cards.current.set(person.id, person);
  }, [data]);
  useEffect(() => {
    setPage(0);
  }, [filter, debouncedQuery, dormitory, period, scope, debouncedColumnFilters]);
  const modalOpen = !!selectedId || !!blockEditor || savingList || selectedList !== null;
  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [modalOpen]);
  const mutate: Mutate = async (action) => {
    if (mutating.current) throw new ApiError(409, 'Дождитесь завершения предыдущего сохранения.');
    mutating.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      // Второй раз рамку не запрашиваем: тем же тиком её перезапрашивают эффекты
      // (рамка, страница, счётчики) — раньше сохранение тянуло всю выборку (#247).
      setAttempt((value) => value + 1);
    } catch (caught) {
      setError(message(caught));
      throw caught;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  if (user?.is_active === false)
    return (
      <section className={s.page}>
        <h1>Персонал</h1>
        <p>Активируйте кабинет, чтобы работать с сотрудниками.</p>
      </section>
    );
  if (!data)
    return (
      <section className={s.page}>
        <h1>Персонал</h1>
        {loading ? (
          <p role="status">Загружаем персонал…</p>
        ) : (
          <p role="alert" className={s.error}>
            {error}
            <button
              onClick={() => {
                setLoading(true);
                setAttempt((n) => n + 1);
              }}
            >
              Повторить
            </button>
          </p>
        )}
      </section>
    );
  const blocks = data.preferences.blocks ?? defaultBlocks;
  /**
   * Карточка человека: из уже показанных страниц, затем из рамки (если карточки в ней
   * есть) и по объединённым id.
   *
   * На самой поверхности рамка приходит с `employees=none`: массива сотрудников в ней
   * нет, и сервер больше не собирает карточки всех сотрудников на каждый запрос (#251).
   * Непустой `employees` бывает только у конструктора вкладок — он грузит полный список
   * для своих таблиц и расчётов.
   */
  const cardOf = (id: string): Employee | undefined =>
    cards.current.get(id) ??
    data.employees.find((person) => person.id === id || person.member_ids.includes(id)) ??
    [...cards.current.values()].find((person) => person.member_ids.includes(id));
  const rows = list.result?.items ?? [];
  const total = list.result?.total ?? 0;
  const pages = Math.max(1, list.result?.pages ?? 1);
  /**
   * Номер страницы, к которой относятся показанные строки. Берётся из ответа, а не
   * из состояния: иначе подвал и стрелки уходят вперёд таблицы (#247).
   */
  const shownPage = list.result ? list.result.page - 1 : page;
  const visible = rows.map((person) => ({
    ...person,
    current: person.current.filter((source) => sourceInScope(source, criteria)),
  }));
  const selectedRows = selected.flatMap((id) => (cardOf(id) ? [cardOf(id)!] : []));
  const selectedInRows = rows.filter((person) => selected.includes(person.id));
  const listFields = employeeListFields(data, criteria);
  const extraFields = listFields.filter(
    (field) => field.table && columnFilters.some((rule) => rule.field === field.id),
  );
  const fullCriteria = { ...criteria, dormitory: null, scope: [] };
  const previewFields = employeeListFields(data, fullCriteria).filter((field) =>
    extraFields.some((item) => item.id === field.id),
  );
  const employee = selectedId ? cardOf(selectedId) : undefined;
  const savePreferences = async (changes: Partial<Preferences>): Promise<void> => {
    await mutate(async () => {
      await personnelApi.preferences({ ...data.preferences, blocks, ...changes });
    });
  };
  const onPerson: OpenPerson = (id, tab = 'overview') => {
    setProfileTab(tab);
    const next = new URLSearchParams(params);
    next.set('employee', id);
    setParams(next);
  };
  const closeProfile = (): void => {
    const next = new URLSearchParams(params);
    next.delete('employee');
    setParams(next, { replace: true });
  };
  const changePeriod = (next: DateRange): void => {
    setSelectedPeriod(next.from === monthPeriod.from && next.to === monthPeriod.to ? null : next);
  };
  const onList = (list: Criteria): void => {
    setFilter(list.filter);
    setDormitory(list.dormitory);
    if (list.period) changePeriod(list.period);
    else if (list.filter === 'ending') changePeriod(endingRange(data.today, list.days));
    setQuery(list.query);
    setScope(list.scope);
    setColumnFilters(list.column_filters ?? []);
    setView('list');
  };
  /**
   * Число под фильтром: при пустых условиях — сводка поверхности, у активного
   * фильтра — `total` показанной страницы, у второго статуса — его счётчик (#247).
   */
  const listSummary = (id: Filter): number | null => {
    if (sameAsSummary) return summary(id);
    if (id === filter && list.result) return list.result.total;
    return listCounts[id] ?? null;
  };
  return (
    <section
      className={view === 'workspace' ? w.surface : `${s.page} ${w.surface} ${f.surface}`}
      data-testid="personnel-workspace"
      aria-busy={busy}
    >
      <div className={`${s.heading} ${w.heading}`}>
        <div>
          <span className={`${s.eyebrow} ${w.eyebrow}`}>ЛЮДИ И ИХ ИСТОРИЯ</span>
          <h1>
            Персонал <small>{summary('all') ?? '—'}</small>
          </h1>
          <p>Проживание, вахты и контакты — в одном месте.</p>
        </div>
        {(extension || view === 'workspace') && (
          <div className={s.actions}>
            {extension?.actions}
            {view === 'workspace' && !extension?.active && (
              <>
                <button
                  type="button"
                  className="btn btn--primary btn--compact"
                  disabled={busy || blocks.length >= 20}
                  onClick={() => setBlockEditor('new')}
                >
                  <PersonnelBlockIcon name="plus" /> Добавить блок
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className={`${s.tabs} ${w.tabs}`} role="tablist" aria-label="Раздел персонала">
        {(
          [
            ['workspace', 'Рабочая поверхность'],
            ['list', 'Сотрудники'],
            ['planning', 'План заездов'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={!extension?.active && view === id}
            onClick={() => {
              if (
                id === 'planning' &&
                data.dormitories.some((item) => item.id === dormitory && item.is_archived)
              )
                setDormitory(null);
              setView(id);
            }}
          >
            {label}
            {id === 'list' && <b>{summary('all') ?? ''}</b>}
          </button>
        ))}
        {extension?.tabs}
      </div>
      {extension?.active ? (
        extension.content({ onPerson, onList })
      ) : (
        <>
          {view === 'list' && (
            <div className={f.hero}>
              <div>
                <h2>Сотрудники</h2>
                <p>Люди, проживание и вахты — всё под рукой.</p>
                <div className={f.stats}>
                  <span>
                    <b>{total}</b> В списке
                  </span>
                  <span>
                    <i aria-hidden="true" />
                    <b>{listSummary('current')}</b> Проживает
                  </span>
                  <span>
                    <PersonnelBlockIcon name="ending" />
                    <b>{listSummary('ending')}</b> Завершают вахту
                  </span>
                </div>
              </div>
              <div className={f.heroArt} aria-hidden="true">
                <img src={resident} alt="" />
                <img src={personnel} alt="" />
                <img src={manager} alt="" />
              </div>
            </div>
          )}
          <div className={`${s.toolbar} ${w.toolbar}`}>
            <div className={s.actions}>
              <label>
                Общежитие
                <select
                  aria-label="Общежитие на странице"
                  value={dormitory ?? 'all'}
                  onChange={(event) => {
                    setDormitory(event.target.value === 'all' ? null : Number(event.target.value));
                    setScope([]);
                  }}
                >
                  <option value="all">Все общежития</option>
                  {data.dormitories
                    .filter((dorm) => view !== 'planning' || !dorm.is_archived)
                    .map((dorm) => (
                      <option key={dorm.id} value={dorm.id}>
                        {dorm.name}
                        {dorm.is_archived ? ' · архив' : ''}
                      </option>
                    ))}
                </select>
              </label>
              {view !== 'planning' && (
                <DormitoryPeriod
                  mode="range"
                  label="Период персонала"
                  range={period}
                  resetRange={monthPeriod}
                  limitToYear={false}
                  onChange={changePeriod}
                />
              )}
            </div>
            {view === 'workspace' ? (
              <button
                type="button"
                className={`btn btn--compact ${configuring ? 'btn--primary' : 'btn--outline'}`}
                aria-pressed={configuring}
                onClick={() => setConfiguring((value) => !value)}
              >
                <PersonnelBlockIcon name="settings" />
                {configuring ? 'Завершить настройку' : 'Настроить поверхность'}
              </button>
            ) : view !== 'planning' ? (
              <span className={s.hint}>Нажмите на имя, чтобы открыть карточку</span>
            ) : null}
          </div>
          {error && (
            <p role="alert" className={s.error}>
              {error} <button onClick={() => setAttempt((n) => n + 1)}>Обновить данные</button>
            </p>
          )}
          {selectedId && !employee && (
            <p role="alert" className={s.notice}>
              Карточка не найдена: полный список сотрудников на странице больше не загружается, и
              карточка доступна только среди уже показанных.{' '}
              <button onClick={closeProfile}>Закрыть</button>{' '}
              <Link to="/cabinet/personnel?view=list">Открыть список сотрудников</Link>
            </p>
          )}
          {!data.dormitories.length && view !== 'planning' && (
            <p className={s.notice}>
              Сначала <Link to="/cabinet/dormitories">создайте общежитие</Link>, затем добавьте
              сотрудника в его таблицу.
            </p>
          )}
          {view === 'workspace' && (
            <div className={view === 'workspace' ? w.metrics : s.metrics}>
              {(
                [
                  ['current', 'Проживают сейчас'],
                  ['ending', 'Окончания вахт за период'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={view === 'workspace' ? `link-button ${w.summaryLink}` : undefined}
                  onClick={() =>
                    onList({ ...criteria, filter: id, query: '', scope: [], column_filters: [] })
                  }
                >
                  {view === 'workspace' &&
                    (id === 'current' ? (
                      <i aria-hidden="true" />
                    ) : (
                      <PersonnelBlockIcon name="ending" />
                    ))}
                  <strong>{summary(id)}</strong>
                  <span>{label}</span>
                </button>
              ))}
              {view === 'workspace' && (
                <span className={w.blockCount}>{blocks.length} / 20 блоков</span>
              )}
            </div>
          )}
          {view === 'workspace' && (
            <>
              <div className={w.grid}>
                {blocks.map((block, index) => (
                  <PersonnelWorkspaceBlock
                    key={block.id}
                    block={block}
                    data={data}
                    preview={data.block_previews?.find((item) => item.id === block.id)}
                    dormitory={dormitory}
                    configuring={configuring}
                    busy={busy}
                    first={index === 0}
                    last={index === blocks.length - 1}
                    onPerson={onPerson}
                    onList={onList}
                    onPlanning={() => setView('planning')}
                    onEdit={() => setBlockEditor(block)}
                    onMove={(direction) => {
                      const next = [...blocks];
                      [next[index], next[index + direction]] = [
                        next[index + direction],
                        next[index],
                      ];
                      void savePreferences({ blocks: next }).catch(() => {});
                    }}
                    onRemove={() =>
                      void savePreferences({
                        blocks: blocks.filter((item) => item.id !== block.id),
                      }).catch(() => {})
                    }
                  />
                ))}
              </div>
              <button
                type="button"
                className={`btn btn--outline btn--compact ${w.addCard}`}
                disabled={blocks.length >= 20 || busy}
                onClick={() => setBlockEditor('new')}
              >
                <PersonnelBlockIcon name="plus" />
                <span>
                  <strong>
                    {blocks.length >= 20 ? 'Добавлено 20 блоков' : 'Добавить свой блок'}
                  </strong>
                  <small>Список, контакты или отдельное общежитие</small>
                </span>
                <img src={plant} alt="" />
              </button>
              {configuring && (
                <div className={s.toolbar}>
                  <span className={s.hint}>
                    До 20 блоков. Расположение и содержимое сохраняются в вашем аккаунте.
                  </span>
                  <button
                    disabled={busy}
                    className="btn btn--outline btn--compact"
                    onClick={() => void savePreferences({ blocks: defaultBlocks }).catch(() => {})}
                  >
                    Вернуть стандартные блоки
                  </button>
                </div>
              )}
            </>
          )}
          {view === 'planning' && (
            <ArrivalPlanningBoard data={data} dormitory={dormitory} mutate={mutate} />
          )}
          {view === 'list' && (
            <section className={`${s.board} ${f.employeeBoard}`} data-testid="personnel-list">
              <div className={s.saved}>
                <span className={s.eyebrow}>МОИ СПИСКИ</span>
                {data.preferences.lists.map((list) => (
                  <span key={list.id}>
                    <button onClick={() => onList(list)}>{list.name}</button>
                    <button
                      disabled={busy}
                      aria-label={`Убрать сохранённый список «${list.name}»`}
                      onClick={() =>
                        void savePreferences({
                          lists: data.preferences.lists.filter((item) => item.id !== list.id),
                        }).catch(() => {})
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  disabled={busy || data.preferences.lists.length >= 50}
                  onClick={() => setSavingList(true)}
                >
                  + Сохранить текущий список
                </button>
              </div>
              <div className={s.toolbar}>
                <div>
                  <h2>
                    {names[filter]} · {total}
                  </h2>
                  <p className={s.hint}>Карточка связывает вахты и перемещения одного человека.</p>
                </div>
                <input
                  aria-label="Поиск сотрудника"
                  placeholder="Имя, табельный номер, телефон"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className={s.chips}>
                {Object.entries(names).map(([id, label]) => (
                  <button
                    key={id}
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id as Filter)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {scope.length > 0 && (
                <p className={s.hint}>
                  Общежития списка: {scope.map((id) => dormName(data, id)).join(' · ')}{' '}
                  <button className={s.linkButton} onClick={() => setScope([])}>
                    Сбросить ограничение
                  </button>
                </p>
              )}
              <EmployeeListFilters
                data={data}
                criteria={shownCriteria}
                fields={listFields}
                onChange={setColumnFilters}
              />
              <div className={s.bulk}>
                <strong>
                  {selectedRows.length ? `Выбрано: ${selectedRows.length}` : `Список: ${total}`}
                </strong>
                <button
                  type="button"
                  className={s.primary}
                  disabled={!selectedRows.length}
                  onClick={() => setSelectedList(selectedRows.map((person) => person.id))}
                >
                  Список выбранных{selectedRows.length ? ` (${selectedRows.length})` : ''}
                </button>
                {selectedRows.length > 0 && (
                  <button onClick={() => setSelected([])}>Снять выбор</button>
                )}
                {selectedRows.length > 0 && (
                  <span className={listStyles.selectionHint}>
                    В текущей выборке: {selectedInRows.length} из {selectedRows.length} выбранных.
                    Выбор сохраняется при смене фильтров.
                  </span>
                )}
              </div>
              {view === 'list' && list.loading && !list.result && (
                <p role="status" className={s.hint}>
                  Загружаем сотрудников…
                </p>
              )}
              {view === 'list' && list.error && (
                <p role="alert" className={s.error}>
                  {list.error}{' '}
                  <button type="button" onClick={list.reload}>
                    Повторить
                  </button>
                </p>
              )}
              {view === 'list' && !list.loading && !list.error && list.result && total === 0 && (
                <p className={s.empty} data-testid="personnel-list-empty">
                  По этим условиям сотрудников нет. Измените фильтры или строку поиска.
                </p>
              )}
              <PersonnelEmployeeFocus
                people={visible}
                rows={rows}
                selected={selected}
                onSelection={setSelected}
                data={data}
                criteria={criteria}
                fields={extraFields}
                onPerson={onPerson}
              />
              <div className={s.pagination} data-testid="personnel-pagination">
                <span>
                  {total ? shownPage * PAGE_SIZE + 1 : 0}–
                  {Math.min(total, (shownPage + 1) * PAGE_SIZE)} из {total}
                </span>
                <button disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>
                  Назад
                </button>
                <button disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)}>
                  Далее
                </button>
              </div>
            </section>
          )}
          <div className={s.footer}>
            <span>Сведения из таблиц общежитий · {dateLabel(data.today, true)}</span>
            <span>
              {busy
                ? 'Сохраняем изменения…'
                : 'Настройки рабочей поверхности сохраняются в аккаунте'}
            </span>
          </div>
        </>
      )}
      {selectedList !== null && (
        <SelectedEmployeesDialog
          people={selectedList.flatMap((id) => (cardOf(id) ? [cardOf(id)!] : []))}
          data={data}
          criteria={fullCriteria}
          fields={previewFields}
          onPerson={onPerson}
          onClose={() => setSelectedList(null)}
        />
      )}
      {employee && (
        <PersonnelProfile
          key={employee.id}
          employee={employee}
          data={data}
          tab={profileTab}
          onClose={closeProfile}
          mutate={mutate}
          onReload={() => setAttempt((n) => n + 1)}
        />
      )}
      {blockEditor && (
        <BlockDialog
          block={blockEditor === 'new' ? null : blockEditor}
          data={data}
          onClose={() => setBlockEditor(null)}
          onSave={(block) =>
            savePreferences({
              blocks:
                blockEditor === 'new'
                  ? [...blocks, block]
                  : blocks.map((item) => (item.id === block.id ? block : item)),
            })
          }
        />
      )}
      {savingList && (
        <SaveListDialog
          criteria={shownCriteria}
          data={data}
          onClose={() => setSavingList(false)}
          onSave={async (list, pin) => {
            if (pin && blocks.length >= 20)
              throw new ApiError(
                422,
                'На поверхности уже 20 блоков. Снимите закрепление или уберите один блок.',
              );
            await savePreferences({
              lists: [...data.preferences.lists, list],
              blocks: pin
                ? [
                    ...blocks,
                    {
                      id: crypto.randomUUID(),
                      kind: 'saved',
                      title: list.name,
                      scope: [],
                      days: list.days,
                      limit: 4,
                      wide: false,
                      saved_list_id: list.id,
                    },
                  ]
                : blocks,
            });
          }}
        />
      )}
    </section>
  );
}
