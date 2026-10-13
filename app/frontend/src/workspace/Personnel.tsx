import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { personnelApi } from '../api/personnel';
import type {
  Block,
  Employee,
  Filter,
  PersonnelData,
  Preferences,
  SavedList,
} from '../api/personnel';
import { useSession } from '../auth/SessionProvider';
import { usePageRefresh } from './usePageRefresh';
import { MatchesBoard } from './personnel/Boards';
import { ArrivalPlanningBoard } from './personnel/ArrivalPlanningBoard';
import type { OpenPerson } from './personnel/Boards';
import { BlockDialog, ExportDialog, SaveListDialog } from './personnel/Dialogs';
import type { Mutate } from './personnel/Forms';
import { Favorite, PersonnelProfile } from './personnel/PersonnelProfile';
import type { ProfileTab } from './personnel/PersonnelProfile';
import {
  addDays,
  currentSources,
  dateLabel,
  dayDiff,
  decisionNames,
  defaultBlocks,
  dormName,
  filterPeople,
  isFavorite,
  message,
  names,
  personName,
  value,
} from './personnel/helpers';
import s from './personnel/Personnel.module.css';

type View = 'workspace' | 'list' | 'planning' | 'matches';
type Criteria = Omit<SavedList, 'id' | 'name'>;

function blockCriteria(block: Block, dormitory: number | null, data: PersonnelData): Criteria {
  const list =
    block.kind === 'saved'
      ? data.preferences.lists.find((list) => list.id === block.saved_list_id)
      : undefined;
  return {
    filter:
      block.kind === 'saved'
        ? (list?.filter ?? 'all')
        : block.kind === 'residents' || block.kind === 'contacts'
          ? 'current'
          : block.kind === 'outflow'
            ? 'history'
            : block.kind === 'missing'
              ? 'missing'
              : 'ending',
    dormitory: dormitory ?? list?.dormitory ?? null,
    days: list?.days ?? block.days,
    query: list?.query ?? '',
    scope: block.scope.length ? block.scope : (list?.scope ?? []),
  };
}
function WorkspaceBlock({
  block,
  data,
  dormitory,
  onPerson,
  onList,
  onView,
}: {
  block: Block;
  data: PersonnelData;
  dormitory: number | null;
  onPerson: OpenPerson;
  onList: (criteria: Criteria) => void;
  onView: (view: View) => void;
}): JSX.Element {
  const scope = (id: number): boolean =>
    (dormitory == null || id === dormitory) && (!block.scope.length || block.scope.includes(id));
  const criteria = blockCriteria(block, dormitory, data);
  const rows = filterPeople(data, criteria);
  if (block.kind === 'plans') {
    const plans = data.arrival_plans
      .filter(
        (plan) =>
          scope(plan.dormitory_id) &&
          plan.date >= data.today &&
          plan.date <= addDays(data.today, block.days),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    return (
      <>
        <p className={s.hint}>Ближайшие {block.days} дней</p>
        <div className={s.rows}>
          {plans.slice(0, block.limit).map((plan) => (
            <button key={plan.id} onClick={() => onView('planning')}>
              <span>
                <strong>
                  {plan.count} чел. · {dormName(data, plan.dormitory_id)}
                </strong>
                <small>{plan.names.length ? plan.names.join(', ') : 'ФИО не указаны'}</small>
              </span>
              <time>{dateLabel(plan.date)}</time>
            </button>
          ))}
        </div>
        {!plans.length && <p className={s.empty}>На выбранный период планов нет.</p>}
        <div className={s.footer}>
          <span>Ожидается: {plans.reduce((total, plan) => total + plan.count, 0)} чел.</span>
          <button className={s.linkButton} onClick={() => onView('planning')}>
            Открыть план заездов →
          </button>
        </div>
      </>
    );
  }
  if (block.kind === 'residents')
    return (
      <>
        <button className={s.linkButton} onClick={() => onList(criteria)}>
          <div className={s.bigNumber}>
            <strong>{rows.length}</strong>
            <span>проживают сейчас</span>
          </div>
        </button>
        <div className={s.rows}>
          {data.dormitories
            .filter((dorm) => scope(dorm.id))
            .map((dorm) => (
              <button key={dorm.id} onClick={() => onList({ ...criteria, dormitory: dorm.id })}>
                <span>
                  <strong>{dorm.name}</strong>
                  <small>
                    {dorm.client_name}
                    {dorm.is_archived ? ' · архив' : ''}
                  </small>
                </span>
                <span className={s.count}>
                  {
                    rows.filter((person) =>
                      person.current.some((source) => source.dormitory_id === dorm.id),
                    ).length
                  }
                </span>
              </button>
            ))}
        </div>
        <div className={s.footer}>
          <span>Одна карточка — один человек в сводке</span>
          <button className={s.linkButton} onClick={() => onList(criteria)}>
            Посмотреть сотрудников →
          </button>
        </div>
      </>
    );
  if (
    block.kind === 'saved' &&
    !data.preferences.lists.some((list) => list.id === block.saved_list_id)
  )
    return <p className={s.empty}>Выберите сохранённый список в настройках блока.</p>;
  return (
    <>
      <p className={s.hint}>
        {block.kind === 'ending'
          ? `Сегодня и следующие ${block.days} дней`
          : block.kind === 'contacts'
            ? 'Телефоны проживающих сотрудников'
            : names[criteria.filter]}
      </p>
      <div className={s.rows}>
        {rows.slice(0, block.limit).map((person) => {
          const source = currentSources(person, criteria.dormitory)
            .filter((source) => scope(source.dormitory_id))
            .sort((a, b) => value(a, 'shift_end').localeCompare(value(b, 'shift_end')))[0];
          const end = value(source, 'shift_end');
          const decision = data.decisions.find(
            (decision) => decision.resident_id === source?.row_id,
          );
          return (
            <button
              key={person.id}
              onClick={() => onPerson(person.id, block.kind === 'outflow' ? 'history' : 'overview')}
            >
              <span>
                <strong>{personName(person)}</strong>
                <small>
                  {source
                    ? dormName(data, source.dormitory_id)
                    : person.sources
                        .map((source) => dormName(data, source.dormitory_id))
                        .filter((name, index, all) => all.indexOf(name) === index)
                        .join(' · ')}{' '}
                  · Т/н {person.personnel_number ?? '—'}
                </small>
                {block.kind === 'ending' && (
                  <small>{decisionNames[decision?.status ?? 'waiting']}</small>
                )}
                {block.kind === 'outflow' && person.last_outflow && (
                  <small>
                    {dateLabel(person.last_outflow.date, true)} ·{' '}
                    {person.last_outflow.reason || 'Причина не указана'}
                  </small>
                )}
              </span>
              {block.kind === 'contacts' ? (
                <span>{person.phone ?? 'Телефон не указан'}</span>
              ) : block.kind === 'ending' ? (
                <time>
                  {end === data.today ? 'Сегодня' : `Через ${dayDiff(data.today, end)} дн.`}
                </time>
              ) : (
                <span>→</span>
              )}
            </button>
          );
        })}
      </div>
      {!rows.length && <p className={s.empty}>По выбранным условиям сотрудников нет.</p>}
      <div className={s.footer}>
        <span>Всего сотрудников: {rows.length}</span>
        <button className={s.linkButton} onClick={() => onList(criteria)}>
          Открыть список →
        </button>
      </div>
    </>
  );
}

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
    params.get('view') === 'planning' ? 'planning' : 'workspace',
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
  const [page, setPage] = useState(0);
  const [configuring, setConfiguring] = useState(false);
  const [blockEditor, setBlockEditor] = useState<Block | 'new' | null>(null);
  const [savingList, setSavingList] = useState(false);
  const [exporting, setExporting] = useState<'people' | 'departures' | null>(null);
  const [notice, setNotice] = useState('');
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
    setSelected([]);
  }, [filter, query, dormitory, days, scope]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const modalOpen = !!selectedId || !!blockEditor || savingList || !!exporting;
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
  const criteria: Criteria = { filter, dormitory, days, query, scope };
  const rows = filterPeople(data, criteria);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const actualPage = Math.min(page, pages - 1);
  const visible = rows.slice(actualPage * 20, actualPage * 20 + 20);
  const selectedRows = rows.filter((person) => selected.includes(person.id));
  const actionRows = selectedRows.length ? selectedRows : rows;
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
  const onFavorite = (person: Employee): void => {
    const favorites = data.preferences.favorites.filter((id) => !person.member_ids.includes(id));
    if (!isFavorite(person, data)) favorites.push(person.id);
    void savePreferences({ favorites }).catch(() => {});
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
    setView('list');
  };
  async function copyPhones(): Promise<void> {
    const phones = [
      ...new Map(
        actionRows
          .filter((person) => person.phone)
          .map((person) => [person.phone!.replace(/\D/g, ''), person.phone!]),
      ).values(),
    ];
    if (!phones.length) {
      setNotice('В выбранном списке нет заполненных телефонов.');
      return;
    }
    try {
      await navigator.clipboard.writeText(phones.join('\n'));
      setNotice(
        `Скопировано телефонов: ${phones.length}. Без телефона: ${actionRows.filter((person) => !person.phone).length}.`,
      );
    } catch {
      setError(
        'Браузер не разрешил копирование. Можно выгрузить телефоны через «Экспорт для Excel».',
      );
    }
  }
  const summary = (id: Filter): number =>
    filterPeople(data, { filter: id, dormitory, days, query: '', scope: [] }).length;
  return (
    <section className={s.page} data-testid="personnel-workspace" aria-busy={busy}>
      <div className={s.heading}>
        <div>
          <span className={s.eyebrow}>ЛЮДИ И ИХ ИСТОРИЯ</span>
          <h1>
            Персонал <small>{data.employees.length}</small>
          </h1>
          <p>Проживание, вахты и контакты — в одном месте.</p>
        </div>
        {view !== 'planning' && (
          <div className={s.actions}>
            <button disabled={busy || blocks.length >= 20} onClick={() => setBlockEditor('new')}>
              + Добавить блок
            </button>
          </div>
        )}
      </div>
      <div className={s.tabs} role="tablist" aria-label="Раздел персонала">
        {(
          [
            ['workspace', 'Рабочая поверхность'],
            ['list', 'Сотрудники'],
            ['planning', 'План заездов'],
            ['matches', 'Совпадения'],
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
            {id === 'matches' && <b>{data.matches.length}</b>}
          </button>
        ))}
      </div>
      <div className={s.toolbar}>
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
          <button onClick={() => setConfiguring((value) => !value)}>
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
      {notice && (
        <p role="status" className={s.notice}>
          {notice}
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
      {view !== 'planning' &&
        data.employees.some(
          (person) => person.identity_status === 'pending' || person.current.length > 1,
        ) && (
          <p className={s.notice}>
            Есть карточки с непроверенной личностью или несколькими записями проживания. До проверки
            совпадений количество уникальных сотрудников предварительное.{' '}
            <button
              className={s.linkButton}
              onClick={() => onList({ ...criteria, filter: 'pending', query: '', scope: [] })}
            >
              Проверить записи →
            </button>
          </p>
        )}
      {view !== 'planning' && (
        <div className={s.metrics}>
          {(
            [
              ['current', 'Проживают сейчас'],
              ['ending', `Вахта заканчивается до ${days} дней`],
              ['overdue', 'Дата окончания уже прошла'],
              ['missing', 'Нужно дополнить данные'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => onList({ ...criteria, filter: id, query: '', scope: [] })}
            >
              <strong>{summary(id)}</strong>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
      {view === 'workspace' && (
        <>
          <div className={s.grid}>
            {blocks.map((block, index) => (
              <article
                key={block.id}
                className={`${s.card} ${block.wide ? s.wide : ''}`}
                data-testid={`personnel-block-${block.id}`}
              >
                <div className={s.cardHead}>
                  <div>
                    <h2>{block.title}</h2>
                    <small>
                      {block.scope.length
                        ? block.scope.map((id) => dormName(data, id)).join(' · ')
                        : 'Все общежития'}
                    </small>
                  </div>
                  {configuring ? (
                    <div className={s.blockTools}>
                      <button
                        disabled={busy || index === 0}
                        aria-label={`Поднять блок «${block.title}»`}
                        onClick={() => {
                          const next = [...blocks];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          void savePreferences({ blocks: next }).catch(() => {});
                        }}
                      >
                        ↑
                      </button>
                      <button
                        disabled={busy || index === blocks.length - 1}
                        aria-label={`Опустить блок «${block.title}»`}
                        onClick={() => {
                          const next = [...blocks];
                          [next[index], next[index + 1]] = [next[index + 1], next[index]];
                          void savePreferences({ blocks: next }).catch(() => {});
                        }}
                      >
                        ↓
                      </button>
                      <button
                        disabled={busy}
                        aria-label={`Убрать блок «${block.title}»`}
                        onClick={() =>
                          void savePreferences({
                            blocks: blocks.filter((item) => item.id !== block.id),
                          }).catch(() => {})
                        }
                      >
                        ×
                      </button>
                      <button disabled={busy} onClick={() => setBlockEditor(block)}>
                        Изменить
                      </button>
                    </div>
                  ) : (
                    <button
                      aria-label={`Настроить блок «${block.title}»`}
                      onClick={() => setBlockEditor(block)}
                    >
                      ⚙
                    </button>
                  )}
                </div>
                <WorkspaceBlock
                  block={block}
                  data={data}
                  dormitory={dormitory}
                  onPerson={onPerson}
                  onList={onList}
                  onView={setView}
                />
              </article>
            ))}
            <button
              className={s.addCard}
              disabled={blocks.length >= 20 || busy}
              onClick={() => setBlockEditor('new')}
            >
              + Добавить свой блок
            </button>
          </div>
          {configuring && (
            <div className={s.toolbar}>
              <span className={s.hint}>
                До 20 блоков. Расположение и содержимое сохраняются в вашем аккаунте.
              </span>
              <button
                disabled={busy}
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
      {view === 'matches' && (
        <MatchesBoard data={data} dormitory={dormitory} onPerson={onPerson} mutate={mutate} />
      )}
      {view === 'list' && (
        <section className={s.board}>
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
          <div className={s.bulk}>
            <strong>
              {selectedRows.length ? `Выбрано: ${selectedRows.length}` : `Список: ${rows.length}`}
            </strong>
            {selectedRows.length > 0 && (
              <button onClick={() => setSelected([])}>Снять выбор</button>
            )}
            <button disabled={!actionRows.length} onClick={() => void copyPhones()}>
              Копировать телефоны
            </button>
            <button disabled={!actionRows.length} onClick={() => setExporting('people')}>
              Экспорт для Excel
            </button>
            <button disabled={!actionRows.length} onClick={() => setExporting('departures')}>
              Список выездов
            </button>
          </div>
          <div className={s.tableScroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={`Выбрать весь список: ${rows.length}`}
                      checked={rows.length > 0 && selectedRows.length === rows.length}
                      aria-checked={
                        selectedRows.length > 0 && selectedRows.length < rows.length
                          ? 'mixed'
                          : selectedRows.length === rows.length && rows.length > 0
                      }
                      onChange={(event) =>
                        setSelected(event.target.checked ? rows.map((person) => person.id) : [])
                      }
                    />
                  </th>
                  <th>Сотрудник</th>
                  <th>Проживание</th>
                  <th>Период вахты</th>
                  <th>Статус</th>
                  <th>Телефон</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Выбрать сотрудника ${personName(person)}`}
                        checked={selected.includes(person.id)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, person.id]
                              : selected.filter((id) => id !== person.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <Favorite employee={person} data={data} onToggle={onFavorite} />
                      <button className={s.name} onClick={() => onPerson(person.id)}>
                        {personName(person)}
                        <small>Т/н {person.personnel_number ?? '—'}</small>
                      </button>
                    </td>
                    <td>
                      {person.current.length
                        ? person.current.map((source) => (
                            <div key={source.row_id}>
                              {dormName(data, source.dormitory_id)}
                              <small>{value(source, 'hostel_name') || 'Место не указано'}</small>
                            </div>
                          ))
                        : 'Сейчас не проживает'}
                    </td>
                    <td>
                      {person.current.map((source) => {
                        const decision = data.decisions.find(
                          (item) => item.resident_id === source.row_id,
                        );
                        return (
                          <div key={source.row_id}>
                            {dateLabel(value(source, 'shift_start'))} —{' '}
                            {dateLabel(value(source, 'shift_end'))}
                            <small>
                              <button className={s.linkButton} onClick={() => onPerson(person.id)}>
                                {decisionNames[decision?.status ?? 'waiting']}
                              </button>
                            </small>
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      <span className={s.badge}>
                        {person.current.length ? 'Проживает' : 'Вне общежитий'}
                      </span>
                      {person.identity_status === 'pending' && (
                        <small>Личность требует проверки</small>
                      )}
                      {person.has_outflow && (
                        <button
                          className={s.linkButton}
                          onClick={() => onPerson(person.id, 'history')}
                        >
                          Есть история оттока
                        </button>
                      )}
                    </td>
                    <td>{person.phone ?? 'Не указан'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <p className={s.empty}>Сотрудников по выбранным условиям нет.</p>}
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
      {employee && (
        <PersonnelProfile
          key={employee.id}
          employee={employee}
          data={data}
          tab={profileTab}
          onClose={closeProfile}
          mutate={mutate}
          onFavorite={onFavorite}
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
      {exporting && (
        <ExportDialog
          people={actionRows}
          data={data}
          departures={exporting === 'departures'}
          onClose={() => setExporting(null)}
        />
      )}
    </section>
  );
}
