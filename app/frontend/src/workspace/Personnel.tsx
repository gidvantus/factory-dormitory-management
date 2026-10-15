import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { personnelApi } from '../api/personnel';
import type {
  Block,
  EmployeeColumnFilter,
  Filter,
  PersonnelData,
  Preferences,
  SavedList,
} from '../api/personnel';
import { useSession } from '../auth/SessionProvider';
import { usePageRefresh } from './usePageRefresh';
import { ArrivalPlanningBoard } from './personnel/ArrivalPlanningBoard';
import { PersonnelEmployeeFocus } from './personnel/PersonnelEmployeeFocus';
import { BlockDialog, SaveListDialog } from './personnel/Dialogs';
import type { Mutate } from './personnel/Forms';
import { PersonnelProfile } from './personnel/PersonnelProfile';
import type { ProfileTab } from './personnel/PersonnelProfile';
import { PersonnelWorkspaceBlock } from './personnel/PersonnelWorkspaceBlock';
import { PersonnelBlockIcon } from './personnel/PersonnelBlockIcon';
import { EmployeeListFilters } from './personnel/EmployeeListFilterPanel';
import { SelectedEmployeesDialog } from './personnel/SelectedEmployeesDialog';
import { employeeListFields, sourceInScope } from './personnel/employeeListFilters';
import plant from '../assets/plant.svg';
import resident from '../assets/avatar-rezident.svg';
import personnel from '../assets/avatar-kadrovik.svg';
import manager from '../assets/avatar-komendant.svg';
import {
  dateLabel,
  defaultBlocks,
  dormName,
  filterPeople,
  message,
  names,
} from './personnel/helpers';
import s from './personnel/Personnel.module.css';
import w from './personnel/PersonnelWorkspace.module.css';
import listStyles from './personnel/EmployeeList.module.css';
import f from './personnel/PersonnelFocus.module.css';

type View = 'workspace' | 'list' | 'planning';
type OpenPerson = (id: string, tab?: ProfileTab) => void;
type Criteria = Omit<SavedList, 'id' | 'name'>;

export function Personnel(): JSX.Element {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('employee');
  const [profileTab, setProfileTab] = useState<ProfileTab>('overview');
  const [data, setData] = useState<PersonnelData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>(
    params.get('view') === 'planning'
      ? 'planning'
      : params.get('view') === 'list'
        ? 'list'
        : 'workspace',
  );
  const [dormitory, setDormitory] = useState<number | null>(() => {
    const id = Number(params.get('dormitory'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const [days, setDays] = useState(5);
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
  const refresh = usePageRefresh();
  useEffect(() => {
    if (user?.is_active === false || mutating.current) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void personnelApi
      .workspace(controller.signal)
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
  }, [attempt, refresh, user?.is_active]);
  useEffect(() => {
    setPage(0);
  }, [filter, query, dormitory, days, scope, columnFilters]);
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
      try {
        setData(await personnelApi.workspace());
      } catch (caught) {
        setError(`Изменение сохранено. Не удалось обновить данные: ${message(caught)}`);
      }
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
  const criteria: Criteria = {
    filter,
    dormitory,
    days,
    query,
    scope,
    column_filters: columnFilters,
  };
  const rows = filterPeople(data, criteria);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const actualPage = Math.min(page, pages - 1);
  const visible = rows.slice(actualPage * 20, actualPage * 20 + 20).map((person) => ({
    ...person,
    current: person.current.filter((source) => sourceInScope(source, criteria)),
  }));
  const selectedRows = data.employees.filter((person) => selected.includes(person.id));
  const selectedInRows = rows.filter((person) => selected.includes(person.id));
  const listFields = employeeListFields(data, criteria);
  const extraFields = listFields.filter(
    (field) => field.table && columnFilters.some((rule) => rule.field === field.id),
  );
  const fullCriteria = { ...criteria, dormitory: null, scope: [] };
  const previewFields = employeeListFields(data, fullCriteria).filter((field) =>
    extraFields.some((item) => item.id === field.id),
  );
  const employee = selectedId
    ? data.employees.find(
        (person) => person.id === selectedId || person.member_ids.includes(selectedId),
      )
    : undefined;
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
  const onList = (list: Criteria): void => {
    setFilter(list.filter);
    setDormitory(list.dormitory);
    setDays(list.days);
    setQuery(list.query);
    setScope(list.scope);
    setColumnFilters(list.column_filters ?? []);
    setView('list');
  };
  const summary = (id: Filter): number =>
    filterPeople(data, { filter: id, dormitory, days, query: '', scope: [] }).length;
  const listSummary = (id: Filter): number =>
    filterPeople({ ...data, employees: rows }, { ...criteria, filter: id }).length;
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
            Персонал <small>{data.employees.length}</small>
          </h1>
          <p>Проживание, вахты и контакты — в одном месте.</p>
        </div>
        {view === 'workspace' && (
          <div className={s.actions}>
            <button
              type="button"
              className="btn btn--primary btn--compact"
              disabled={busy || blocks.length >= 20}
              onClick={() => setBlockEditor('new')}
            >
              <PersonnelBlockIcon name="plus" /> Добавить блок
            </button>
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
            aria-selected={view === id}
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
            {id === 'list' && <b>{data.employees.length}</b>}
          </button>
        ))}
      </div>
      {view === 'list' && (
        <div className={f.hero}>
          <div>
            <h2>Сотрудники</h2>
            <p>Люди, проживание и вахты — всё под рукой.</p>
            <div className={f.stats}>
              <span>
                <b>{rows.length}</b> В списке
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
            <label>
              Период
              <select
                aria-label="Период окончания вахты"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {[...new Set([5, 7, 14, 30, days])]
                  .sort((a, b) => a - b)
                  .map((days) => (
                    <option key={days} value={days}>
                      Вахта: до {days} дней
                    </option>
                  ))}
              </select>
            </label>
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
          Карточка не найдена. <button onClick={closeProfile}>Закрыть</button>
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
              ['ending', `Вахта заканчивается до ${days} дней`],
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
                  [next[index], next[index + direction]] = [next[index + direction], next[index]];
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
              <strong>{blocks.length >= 20 ? 'Добавлено 20 блоков' : 'Добавить свой блок'}</strong>
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
        <section className={`${s.board} ${f.employeeBoard}`}>
          <div className={s.saved}>
            <span className={s.eyebrow}>МОИ СПИСКИ</span>
            {data.preferences.lists.map((list) => (
              <span key={list.id}>
                <button onClick={() => onList(list)}>
                  {list.name} <b>{filterPeople(data, list).length}</b>
                </button>
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
                {names[filter]} · {rows.length}
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
              <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id as Filter)}>
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
            criteria={criteria}
            fields={listFields}
            onChange={setColumnFilters}
          />
          <div className={s.bulk}>
            <strong>
              {selectedRows.length ? `Выбрано: ${selectedRows.length}` : `Список: ${rows.length}`}
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
                В текущей выборке: {selectedInRows.length} из {selectedRows.length} выбранных. Выбор
                сохраняется при смене фильтров.
              </span>
            )}
          </div>
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
          <div className={s.pagination}>
            <span>
              {rows.length ? actualPage * 20 + 1 : 0}–{Math.min(rows.length, (actualPage + 1) * 20)}{' '}
              из {rows.length}
            </span>
            <button disabled={actualPage === 0} onClick={() => setPage(actualPage - 1)}>
              Назад
            </button>
            <button disabled={actualPage >= pages - 1} onClick={() => setPage(actualPage + 1)}>
              Далее
            </button>
          </div>
        </section>
      )}
      <div className={s.footer}>
        <span>Сведения из таблиц общежитий · {dateLabel(data.today, true)}</span>
        <span>
          {busy ? 'Сохраняем изменения…' : 'Настройки рабочей поверхности сохраняются в аккаунте'}
        </span>
      </div>
      {selectedList !== null && (
        <SelectedEmployeesDialog
          people={data.employees.filter((person) => selectedList.includes(person.id))}
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
          criteria={criteria}
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
