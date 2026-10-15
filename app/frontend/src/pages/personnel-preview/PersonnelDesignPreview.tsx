import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import {
  TODAY,
  blockDescriptions,
  blockNames,
  blockStorageKey,
  calendarDays,
  dateLabel,
  dayDiff,
  deadline,
  dormitories,
  dormName,
  endingSoon,
  initials,
  initialBlocks,
  needsData,
  readBlocks,
} from './data';
import type { Block, BlockKind, Person, PersonEvent } from './data';
import { listNames, matches, selectSavedList, usePersonnelOperations } from './operations';
import { PersonnelOperationsProvider } from './PersonnelOperationsProvider';
import type { ListFilter, ProfileTab, SavedList, WorkspaceView } from './operations';
import {
  FavoriteButton,
  MatchesBoard,
  NextShift,
  OperationsBlock,
  PersonNotes,
  PlanningBoard,
  SaveListDialog,
  SavedListsBar,
} from './OperationsViews';
import styles from './PersonnelDesignPreview.module.css';
import ops from './Operations.module.css';

type IconName =
  | 'plus'
  | 'settings'
  | 'search'
  | 'phone'
  | 'calendar'
  | 'arrow'
  | 'up'
  | 'down'
  | 'close'
  | 'copy'
  | 'history'
  | 'check'
  | 'info'
  | 'grid'
  | 'list'
  | 'alert';
const blockIcons: Record<BlockKind, IconName> = {
  residents: 'grid',
  ending: 'calendar',
  contacts: 'phone',
  outflow: 'history',
  missing: 'alert',
  plans: 'calendar',
  saved: 'list',
};

function Icon({ name }: { name: IconName }): JSX.Element {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    settings: (
      <>
        <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
        <circle cx="15" cy="7" r="2" />
        <circle cx="9" cy="17" r="2" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    phone: <path d="m7 3 3 5-2.5 2.5a14 14 0 0 0 6 6L16 14l5 3-1 3c-1 3-7-1-10-4S3 7 4 4l3-1Z" />,
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    up: <path d="m6 14 6-6 6 6" />,
    down: <path d="m6 10 6 6 6-6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M15 8V3H3v13h5" />
      </>
    ),
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10h.01" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    alert: (
      <>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 9v5m0 3h.01" />
      </>
    ),
  };
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Avatar({ person, large = false }: { person: Person; large?: boolean }): JSX.Element {
  return (
    <span
      className={`${styles.avatar} ${large ? styles.avatarLarge : ''}`}
      data-color={Number(person.number) % 4}
      aria-hidden="true"
    >
      {initials(person.name)}
    </span>
  );
}
function PersonButton({
  person,
  onClick,
  subtitle,
}: {
  person: Person;
  onClick: () => void;
  subtitle?: string;
}): JSX.Element {
  return (
    <button className={styles.personButton} onClick={onClick}>
      <Avatar person={person} />
      <span>
        <strong>{person.name.split(' ').slice(0, 2).join(' ')}</strong>
        <small>{subtitle ?? `${dormName(person.dormitoryId)} · Т/н ${person.number}`}</small>
      </span>
    </button>
  );
}
function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={styles.empty}>
      <Icon name="search" />
      <strong>{children}</strong>
      <span>Попробуйте изменить общежитие или период.</span>
    </div>
  );
}
function Scope({ block, dormitory }: { block: Block; dormitory: string }): JSX.Element {
  const names = block.scope.length ? block.scope.map(dormName).join(', ') : 'Все общежития';
  return (
    <span className={styles.scope}>
      {dormitory !== 'all'
        ? `${dormName(dormitory)}${block.scope.length ? ` · выбор блока: ${names}` : ''}`
        : names}
    </span>
  );
}
function inScope(id: string, block: Block, dormitory: string): boolean {
  return (
    (dormitory === 'all' || id === dormitory) && (!block.scope.length || block.scope.includes(id))
  );
}

function BlockBody({
  block,
  dormitory,
  days,
  onPerson,
  onList,
  onCopy,
  onView,
  onSaved,
}: {
  block: Block;
  dormitory: string;
  days: number;
  onPerson: (person: Person, tab?: ProfileTab) => void;
  onList: (filter: ListFilter, scope: string[], days?: number) => void;
  onCopy: (text: string) => void;
  onView: (view: WorkspaceView) => void;
  onSaved: (list: SavedList) => void;
}): JSX.Element {
  const { people } = usePersonnelOperations();
  const residents = people.filter((p) => p.current && inScope(p.dormitoryId, block, dormitory));
  const period = block.days ?? days;
  const ending = residents
    .filter((p) => endingSoon(p, period))
    .sort((a, b) => (a.end ?? '').localeCompare(b.end ?? ''));
  const events = people
    .flatMap((person) =>
      person.history
        .filter((event) => event.kind === 'outflow' && inScope(event.dormitoryId, block, dormitory))
        .map((event) => ({ person, event })),
    )
    .sort((a, b) => b.event.date.localeCompare(a.event.date));
  if (['plans', 'saved'].includes(block.kind))
    return (
      <OperationsBlock
        block={block}
        dormitory={dormitory}
        onPerson={onPerson}
        onView={onView}
        onSaved={onSaved}
      />
    );
  if (block.kind === 'residents')
    return (
      <>
        <div className={styles.residentTotal}>
          <button
            onClick={() => onList('current', block.scope)}
            aria-label={`Показать ${residents.length} проживающих`}
          >
            {residents.length}
            <Icon name="arrow" />
          </button>
          <span>
            Всего проживающих сотрудников
            <br />
            <small>Один сотрудник — один человек в сводке</small>
          </span>
        </div>
        {block.presentation === 'distribution' && (
          <div className={styles.distribution}>
            {dormitories
              .filter((d) => inScope(d.id, block, dormitory))
              .map((d) => {
                const count = residents.filter((p) => p.dormitoryId === d.id).length;
                return (
                  <button
                    key={d.id}
                    className={styles.dormRow}
                    onClick={() => onList('current', [d.id])}
                    aria-label={`${d.name}: ${count} проживающих`}
                  >
                    <span>
                      <strong>{d.name}</strong>
                      <small>{d.client}</small>
                    </span>
                    <span className={styles.bar}>
                      <span
                        style={{
                          width: `${residents.length ? (count / residents.length) * 100 : 0}%`,
                          background: d.color,
                        }}
                      />
                    </span>
                    <b>{count}</b>
                    <Icon name="arrow" />
                  </button>
                );
              })}
          </div>
        )}
        {!residents.length && (
          <p className={styles.inlineNote}>В выбранных общежитиях проживающих нет.</p>
        )}
        <div className={styles.cardFooter}>
          <span>Источник: Проживающие</span>
          <button onClick={() => onList('current', block.scope)}>
            Посмотреть сотрудников <Icon name="arrow" />
          </button>
        </div>
      </>
    );
  if (block.kind === 'outflow')
    return (
      <>
        <p className={styles.blockNote}>Последние события · включая тех, кто вернулся</p>
        <div className={styles.eventList}>
          {events.slice(0, 4).map(({ person, event }) => (
            <button
              key={event.id}
              className={styles.eventRow}
              onClick={() => onPerson(person, 'history')}
            >
              <span className={styles.eventDate}>{dateLabel(event.date)}</span>
              <span>
                <strong>{person.name.split(' ').slice(0, 2).join(' ')}</strong>
                <small>
                  {dormName(event.dormitoryId)}
                  {person.current ? ' · сейчас снова проживает' : ''}
                </small>
              </span>
              <span
                className={`${styles.badge} ${event.reason === 'Завершил вахту' ? styles.neutral : styles.peach}`}
              >
                {event.reason}
              </span>
            </button>
          ))}
        </div>
        {!events.length && <Empty>Записей в оттоке нет</Empty>}
        <div className={styles.cardFooter}>
          <span>События за всё время: {events.length}</span>
          <button onClick={() => onList('history', block.scope)}>
            Все сотрудники с историей <Icon name="arrow" />
          </button>
        </div>
      </>
    );
  const rows =
    block.kind === 'ending'
      ? ending
      : block.kind === 'missing'
        ? residents.filter(needsData)
        : residents;
  return (
    <>
      <p className={styles.blockNote}>
        {block.kind === 'ending'
          ? `Сегодня и следующие ${period} дн. · ${dateLabel(TODAY)} — ${dateLabel(new Date(Date.parse(`${TODAY}T00:00:00Z`) + period * 86400000).toISOString().slice(0, 10))}`
          : block.kind === 'missing'
            ? 'Телефон, начало и окончание вахты'
            : 'Телефоны проживающих · демонстрационные номера'}
      </p>
      <div className={styles.personList}>
        {rows.slice(0, 4).map((person) => (
          <div key={person.id} className={styles.personRow}>
            <PersonButton person={person} onClick={() => onPerson(person)} />
            <div className={styles.personMeta}>
              {block.kind === 'ending' && (
                <span
                  className={`${styles.badge} ${person.end && dayDiff(TODAY, person.end) <= 1 ? styles.peach : styles.sand}`}
                >
                  {deadline(person)}
                </span>
              )}
              {block.kind === 'missing' && (
                <small className={styles.missing}>
                  {[
                    !person.phone && 'Нет телефона',
                    (!person.start || !person.end) && 'Нет дат вахты',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
              {(block.showPhone || block.kind === 'contacts') &&
                (person.phone ? (
                  <button
                    className={styles.phoneButton}
                    onClick={() => onCopy(person.phone!)}
                    title={`Скопировать телефон ${person.name}`}
                  >
                    {person.phone}
                    <Icon name="copy" />
                  </button>
                ) : (
                  <span className={styles.missing}>Телефон не указан</span>
                ))}
            </div>
          </div>
        ))}
      </div>
      {!rows.length && (
        <Empty>
          {block.kind === 'missing' ? 'Все данные заполнены' : 'Сотрудников по этим условиям нет'}
        </Empty>
      )}
      <div className={styles.cardFooter}>
        <span>
          Всего сотрудников: {rows.length}
          {rows.length > 4 ? ' · показаны первые 4' : ''}
        </span>
        <button
          onClick={() =>
            onList(
              block.kind === 'ending' ? 'ending' : block.kind === 'missing' ? 'missing' : 'current',
              block.scope,
              period,
            )
          }
        >
          Открыть список <Icon name="arrow" />
        </button>
      </div>
    </>
  );
}

function History({ events }: { events: PersonEvent[] }): JSX.Element {
  if (!events.length) return <p className={styles.inlineNote}>Событий этого типа пока нет.</p>;
  return (
    <ol className={styles.timeline}>
      {events.map((event) => (
        <li key={event.id} data-kind={event.kind}>
          <span className={styles.timelineDot}>
            <Icon
              name={
                event.kind === 'outflow' ? 'history' : event.kind === 'shift' ? 'calendar' : 'arrow'
              }
            />
          </span>
          <div>
            <time>{dateLabel(event.date, true)}</time>
            <h4>{event.title}</h4>
            <p>{event.detail}</p>
            {event.reason && (
              <span className={`${styles.badge} ${styles.peach}`}>Причина: {event.reason}</span>
            )}
            <small>
              Источник:{' '}
              {event.source ??
                (event.kind === 'outflow'
                  ? 'Отток'
                  : event.kind === 'shift'
                    ? 'Карточка вахты'
                    : event.kind === 'arrival'
                      ? 'Приток'
                      : 'Перевод между общежитиями')}
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PersonDrawer({
  person,
  initialTab,
  onClose,
  onCopy,
}: {
  person: Person;
  initialTab: ProfileTab;
  onClose: () => void;
  onCopy: (text: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const [historyFilter, setHistoryFilter] = useState('all');
  const outflow = person.history.filter((event) => event.kind === 'outflow');
  const totalDays = person.start && person.end ? dayDiff(person.start, person.end) + 1 : 0;
  const elapsed = person.start ? dayDiff(person.start, TODAY) + 1 : 0;
  return (
    <Modal
      title="Карточка сотрудника"
      testId="personnel-profile"
      onClose={onClose}
      containerClassName={styles.drawerContainer}
      panelClassName={`${styles.drawer} ${styles.theme}`}
    >
      <div className={styles.profileHero}>
        <Avatar person={person} large />
        <div>
          <span className={`${styles.badge} ${person.current ? styles.green : styles.neutral}`}>
            {person.current ? 'Проживает' : 'В оттоке'}
          </span>
          <h3>{person.name}</h3>
          <p>
            Т/н {person.number} <span>·</span> {person.role}
          </p>
        </div>
        <FavoriteButton person={person} />
      </div>
      <div className={styles.profileContact}>
        <span>
          <Icon name="phone" />
          {person.phone ?? 'Телефон не указан'}
        </span>
        {person.phone && (
          <button className={styles.textButton} onClick={() => onCopy(person.phone!)}>
            <Icon name="copy" />
            Копировать
          </button>
        )}
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Карточка сотрудника">
        {(
          [
            ['overview', 'Обзор'],
            ['history', 'История'],
            ['shifts', 'Вахты'],
            ['notes', 'Заметки'],
            ['next', 'Следующая вахта'],
          ] as const
        ).map(([id, title]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {title}
            {id === 'history' && <span>{person.history.length}</span>}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        aria-label={
          tab === 'overview'
            ? 'Обзор сотрудника'
            : tab === 'history'
              ? 'История сотрудника'
              : tab === 'notes'
                ? 'Заметки сотрудника'
                : tab === 'next'
                  ? 'Следующая вахта сотрудника'
                  : 'Вахты сотрудника'
        }
      >
        {tab === 'overview' && (
          <div className={styles.profileSections}>
            <section className={styles.locationCard}>
              <span className={styles.eyebrow}>
                {person.current ? 'Сейчас проживает' : 'Последнее место проживания'}
              </span>
              <h4>{dormName(person.dormitoryId)}</h4>
              <p>{person.room}</p>
              <small>{dormitories.find((d) => d.id === person.dormitoryId)?.client}</small>
            </section>
            <section className={styles.shiftCard}>
              <div className={styles.sectionHeading}>
                <h4>{person.current ? 'Текущая вахта' : 'Последняя вахта'}</h4>
                <span className={`${styles.badge} ${styles.sand}`}>{deadline(person)}</span>
              </div>
              <div className={styles.shiftDates}>
                <div>
                  <small>Начало</small>
                  <strong>{person.start ? dateLabel(person.start, true) : 'Не указано'}</strong>
                </div>
                <Icon name="arrow" />
                <div>
                  <small>Окончание</small>
                  <strong>{person.end ? dateLabel(person.end, true) : 'Не указано'}</strong>
                </div>
              </div>
              {totalDays > 0 && (
                <>
                  <div className={styles.progress}>
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, (elapsed / totalDays) * 100))}%`,
                      }}
                    />
                  </div>
                  <p>
                    {calendarDays(totalDays)}
                    {person.current
                      ? ` · прошло ${Math.max(0, Math.min(totalDays, elapsed))}`
                      : ' · вахта завершена'}
                  </p>
                </>
              )}
              {person.current && person.end && dayDiff(TODAY, person.end) < 0 && (
                <p className={styles.missing}>
                  Дата окончания прошла. Сотрудник остаётся в проживающих — нужно уточнить выезд или
                  продление.
                </p>
              )}
            </section>
            <section className={styles.historySummary}>
              <Icon name="history" />
              <div>
                <strong>
                  {outflow.length
                    ? `Был в оттоке: ${outflow.length} ${outflow.length === 1 ? 'раз' : 'раза'}`
                    : 'Записей в оттоке нет'}
                </strong>
                <p>
                  {outflow[0]
                    ? `${dateLabel(outflow[0].date, true)} · ${outflow[0].reason}`
                    : 'В истории пока только текущая вахта.'}
                </p>
              </div>
              {outflow.length > 0 && (
                <button
                  className={styles.iconButton}
                  onClick={() => {
                    setTab('history');
                    setHistoryFilter('outflow');
                  }}
                  aria-label="Показать события оттока"
                >
                  <Icon name="arrow" />
                </button>
              )}
            </section>
            <section>
              <div className={styles.sectionHeading}>
                <h4>Последние события</h4>
                <button className={styles.textButton} onClick={() => setTab('history')}>
                  Вся история <Icon name="arrow" />
                </button>
              </div>
              <History events={person.history.slice(0, 3)} />
            </section>
          </div>
        )}
        {tab === 'history' && (
          <>
            <div className={styles.filterChips}>
              {[
                ['all', 'Все события'],
                ['housing', 'Проживание'],
                ['outflow', 'Отток'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={historyFilter === id}
                  onClick={() => setHistoryFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className={styles.historyNote}>
              История сохраняет предыдущие общежития и причины оттока, даже если сотрудник снова
              заселился.
            </p>
            <History
              events={person.history.filter(
                (event) =>
                  historyFilter === 'all' ||
                  (historyFilter === 'housing'
                    ? ['arrival', 'transfer'].includes(event.kind)
                    : event.kind === 'outflow'),
              )}
            />
          </>
        )}
        {tab === 'shifts' && (
          <div className={styles.profileSections}>
            {person.shifts.map((shift, index) => (
              <section className={styles.shiftCard} key={shift.start}>
                <div className={styles.sectionHeading}>
                  <h4>{shift.complete ? 'Предыдущая вахта' : 'Текущая вахта'}</h4>
                  <span
                    className={`${styles.badge} ${shift.complete ? styles.neutral : styles.green}`}
                  >
                    {shift.complete ? 'Завершена' : 'В проживающих'}
                  </span>
                </div>
                <strong>
                  {dateLabel(shift.start, true)} — {dateLabel(shift.end, true)}
                </strong>
                <p>
                  {calendarDays(dayDiff(shift.start, shift.end) + 1)} ·{' '}
                  {dormName(shift.dormitoryId)}
                </p>
                {person.id === 'person-1' && index === 0 && (
                  <small>1–19 сентября: Центральное · с 20 сентября: Северное</small>
                )}
              </section>
            ))}
            {(!person.start || !person.end) && (
              <p className={styles.inlineNote}>Период текущей вахты не заполнен полностью.</p>
            )}
          </div>
        )}
        {tab === 'notes' && <PersonNotes person={person} />}
        {tab === 'next' && <NextShift person={person} />}
      </div>
      <div className={styles.demoFootnote}>
        <Icon name="info" />
        Демонстрационная карточка · данные вымышлены
      </div>
    </Modal>
  );
}

function BlockEditor({
  initial,
  days,
  dormitory,
  onSave,
  onClose,
}: {
  initial: Block | null;
  days: number;
  dormitory: string;
  onSave: (block: Block) => void;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Block>(
    initial ?? { ...initialBlocks[0], id: crypto.randomUUID(), scope: [] },
  );
  const { people, state } = usePersonnelOperations();
  const [selectedScope, setSelectedScope] = useState(Boolean(initial?.scope.length));
  const scopeReady = !selectedScope || draft.scope.length > 0;
  function update(changes: Partial<Block>): void {
    setDraft((old) => ({ ...old, ...changes }));
  }
  const count = people.filter(
    (p) =>
      scopeReady &&
      p.current &&
      inScope(p.dormitoryId, draft, dormitory) &&
      (draft.kind === 'ending'
        ? endingSoon(p, draft.days ?? days)
        : draft.kind === 'missing'
          ? needsData(p)
          : true),
  ).length;
  const outflowCount = people
    .flatMap((p) => p.history)
    .filter(
      (e) => scopeReady && e.kind === 'outflow' && inScope(e.dormitoryId, draft, dormitory),
    ).length;
  const savedList = state.lists.find((list) => list.id === draft.savedListId);
  const previewCount = !scopeReady
    ? 0
    : draft.kind === 'outflow'
      ? outflowCount
      : draft.kind === 'plans'
        ? state.plans.filter(
            (plan) =>
              inScope(plan.dormitoryId, draft, dormitory) &&
              plan.date >= TODAY &&
              dayDiff(TODAY, plan.date) <= 6,
          ).length
        : draft.kind === 'saved'
          ? savedList
            ? selectSavedList(savedList, people, state, dormitory).filter(
                (person) => !draft.scope.length || draft.scope.includes(person.dormitoryId),
              ).length
            : 0
          : count;
  return (
    <Modal
      title={initial ? 'Настроить блок' : 'Добавить блок'}
      testId="personnel-block-editor"
      onClose={onClose}
      panelClassName={`${styles.editor} ${styles.theme}`}
    >
      <p className={styles.dialogLead}>Выберите, что важно видеть на вашей рабочей поверхности.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.title.trim() && (!selectedScope || draft.scope.length))
            onSave({ ...draft, title: draft.title.trim() });
        }}
      >
        <div className={styles.editorGrid}>
          <div className={styles.editorFields}>
            <label className={styles.field}>
              Тип блока
              <select
                value={draft.kind}
                onChange={(event) => {
                  const kind = event.target.value as BlockKind;
                  update({
                    kind,
                    title: blockNames[kind],
                    showPhone: kind === 'ending' || kind === 'contacts',
                    savedListId: kind === 'saved' ? state.lists[0]?.id : undefined,
                  });
                }}
              >
                {Object.entries(blockNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {draft.kind === 'saved' && (
              <label className={styles.field}>
                Сохранённый список
                <select
                  required
                  value={draft.savedListId ?? ''}
                  onChange={(event) => update({ savedListId: event.target.value })}
                >
                  <option value="" disabled>
                    Выберите список
                  </option>
                  {state.lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
                {!state.lists.length && (
                  <small className={styles.missing}>
                    Сначала сохраните список во вкладке «Сотрудники».
                  </small>
                )}
              </label>
            )}
            <label className={styles.field}>
              Название
              <input
                value={draft.title}
                maxLength={70}
                required
                onChange={(event) => update({ title: event.target.value })}
              />
            </label>
            <fieldset className={styles.fieldset}>
              <legend>Общежития</legend>
              <label className={styles.checkLabel}>
                <input
                  type="radio"
                  name="scope"
                  checked={!selectedScope}
                  onChange={() => {
                    setSelectedScope(false);
                    update({ scope: [] });
                  }}
                />
                Все доступные
              </label>
              <label className={styles.checkLabel}>
                <input
                  type="radio"
                  name="scope"
                  checked={selectedScope}
                  onChange={() => setSelectedScope(true)}
                />
                Выбрать общежития
              </label>
              {selectedScope && (
                <div className={styles.dormChoices}>
                  {dormitories.map((d) => (
                    <label className={styles.checkLabel} key={d.id}>
                      <input
                        type="checkbox"
                        checked={draft.scope.includes(d.id)}
                        onChange={(event) =>
                          update({
                            scope: event.target.checked
                              ? [...draft.scope, d.id]
                              : draft.scope.filter((id) => id !== d.id),
                          })
                        }
                      />
                      {d.name}
                      <small>{d.client}</small>
                    </label>
                  ))}
                </div>
              )}
              {selectedScope && !draft.scope.length && (
                <small className={styles.missing}>Выберите хотя бы одно общежитие.</small>
              )}
            </fieldset>
            {draft.kind === 'residents' && (
              <label className={styles.field}>
                Отображение
                <select
                  value={draft.presentation}
                  onChange={(event) =>
                    update({ presentation: event.target.value as Block['presentation'] })
                  }
                >
                  <option value="distribution">Всего и по каждому общежитию</option>
                  <option value="total">Только общее количество</option>
                </select>
              </label>
            )}
            {draft.kind === 'ending' && (
              <>
                <label className={styles.field}>
                  Окончание вахты
                  <select
                    value={draft.days === null ? 'global' : 'custom'}
                    onChange={(event) =>
                      update({ days: event.target.value === 'global' ? null : days })
                    }
                  >
                    <option value="global">Период страницы: до {days} дней</option>
                    <option value="custom">Свой период для блока</option>
                  </select>
                </label>
                {draft.days !== null && (
                  <label className={styles.field}>
                    Количество дней после сегодня
                    <input
                      type="number"
                      min={0}
                      max={90}
                      required
                      value={draft.days}
                      onChange={(event) => update({ days: Number(event.target.value) })}
                    />
                  </label>
                )}
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={draft.showPhone}
                    onChange={(event) => update({ showPhone: event.target.checked })}
                  />
                  Показывать номера телефонов
                </label>
              </>
            )}
            <label className={styles.field}>
              Ширина блока
              <select
                value={draft.width}
                onChange={(event) => update({ width: event.target.value as Block['width'] })}
              >
                <option value="half">Половина рабочей поверхности</option>
                <option value="full">Вся ширина</option>
              </select>
            </label>
          </div>
          <div className={styles.editorPreview}>
            <span className={styles.eyebrow}>Предпросмотр</span>
            <article>
              <span className={styles.blockIcon}>
                <Icon name={blockIcons[draft.kind]} />
              </span>
              <h3>{draft.title || 'Название блока'}</h3>
              <p>{blockDescriptions[draft.kind]}</p>
              <strong className={styles.previewNumber}>{previewCount}</strong>
              <small>
                {draft.kind === 'outflow' || draft.kind === 'plans'
                  ? 'Всего событий'
                  : 'Всего сотрудников'}{' '}
                в выбранной области
              </small>
              {scopeReady &&
                draft.kind === 'residents' &&
                draft.presentation === 'distribution' && (
                  <div className={styles.previewDorms}>
                    {dormitories
                      .filter((d) => inScope(d.id, draft, dormitory))
                      .map((d) => (
                        <div key={d.id}>
                          <span>{d.name}</span>
                          <b>{people.filter((p) => p.current && p.dormitoryId === d.id).length}</b>
                        </div>
                      ))}
                  </div>
                )}
            </article>
            <p>
              <Icon name="info" />
              Фильтр общежития на странице дополнительно сужает выборку каждого блока.
            </p>
          </div>
        </div>
        <div className={styles.dialogFooter}>
          <span>Настройки сохраняются в этом браузере</span>
          <button className={styles.secondary} type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className={styles.primary}
            disabled={!draft.title.trim() || (selectedScope && !draft.scope.length)}
          >
            {initial ? 'Сохранить изменения' : 'Добавить на поверхность'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PersonnelPreviewContent(): JSX.Element {
  const { people, state, storageError: operationsStorageError } = usePersonnelOperations();
  const [blocks, setBlocks] = useState(readBlocks);
  const [storageError, setStorageError] = useState(false);
  const [view, setView] = useState<WorkspaceView>('workspace');
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<Block | null | undefined>(undefined);
  const [dormitory, setDormitory] = useState('all');
  const [days, setDays] = useState(5);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [listScope, setListScope] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ person: Person; tab: ProfileTab } | null>(null);
  const [toast, setToast] = useState('');
  const [guide, setGuide] = useState(false);
  const [reset, setReset] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [savingList, setSavingList] = useState(false);
  useEffect(() => {
    const old = document.title;
    document.title = 'Персонал — тестовая страница · Домовой';
    return () => {
      document.title = old;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(blockStorageKey, JSON.stringify(blocks));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [blocks]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  const modalOpen = editor !== undefined || !!selected || guide || reset || savingList;
  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [modalOpen]);
  const residents = people.filter(
    (p) => p.current && (dormitory === 'all' || p.dormitoryId === dormitory),
  );
  const soon = residents.filter((p) => endingSoon(p, days));
  const overdue = residents.filter((p) => p.end && dayDiff(TODAY, p.end) < 0);
  const missing = residents.filter(needsData);
  const listDraft: SavedList = {
    id: '',
    name: listNames[filter],
    filter,
    dormitory,
    scope: listScope,
    days,
    query,
  };
  const filtered = selectSavedList(listDraft, people, state).sort((a, b) =>
    filter === 'ending'
      ? (a.end ?? '').localeCompare(b.end ?? '')
      : Number(b.current) - Number(a.current),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1));
  const checkedPeople = filtered.filter((person) => selectedIds.includes(person.id));
  function openSavedList(list: SavedList): void {
    setFilter(list.filter);
    setDormitory(list.dormitory);
    setListScope(list.scope);
    setDays(list.days);
    setQuery(list.query);
    setPage(0);
    setSelectedIds([]);
    setView('list');
  }
  function showList(next: ListFilter, scope: string[] = [], period?: number): void {
    setFilter(next);
    setListScope(scope);
    if (period !== undefined) setDays(period);
    setQuery('');
    setPage(0);
    setView('list');
    setSelectedIds([]);
  }
  function openPerson(person: Person, tab: ProfileTab = 'overview'): void {
    setSelected({ person, tab });
  }
  async function copyPhone(text: string, message = 'Телефон скопирован'): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setToast(message);
    } catch {
      setToast('Не удалось скопировать. Номер можно выделить в карточке.');
    }
  }
  function moveBlock(index: number, delta: number): void {
    setBlocks((old) => {
      const result = [...old];
      [result[index], result[index + delta]] = [result[index + delta], result[index]];
      return result;
    });
  }
  return (
    <div className={`${styles.page} ${styles.theme}`}>
      {mobileMenu && (
        <button
          className={styles.mobileBackdrop}
          aria-label="Закрыть боковое меню"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={styles.sidebar} data-open={mobileMenu}>
        <Link to="/cabinet" className={styles.brand}>
          <span>
            <WorkspaceIcon name="house" />
          </span>
          Домовой
        </Link>
        <p className={styles.brandNote}>Учёт проживающих в общежитиях</p>
        <span className={styles.navLabel}>РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <nav aria-label="Основные разделы">
          <Link to="/cabinet">
            <WorkspaceIcon name="overview" />
            Обзор
          </Link>
          <Link to="/cabinet/dormitories">
            <WorkspaceIcon name="house" />
            Общежития
          </Link>
          <button
            aria-current="page"
            onClick={() => {
              setView('workspace');
              setMobileMenu(false);
            }}
          >
            <WorkspaceIcon name="people" />
            Персонал
            <span className={styles.navDot} />
          </button>
          <Link to="/cabinet/statistics">
            <WorkspaceIcon name="chart" />
            Статистика
          </Link>
        </nav>
        <div className={styles.sidebarNote}>
          <span className={styles.badge}>ПРОТОТИП</span>
          <strong>Место для ваших идей</strong>
          <p>Попробуйте настроить блоки и открыть историю сотрудника.</p>
          <button onClick={() => setGuide(true)}>
            Как это будет работать <Icon name="arrow" />
          </button>
        </div>
        <Link to="/cabinet/profile" className={styles.accountLink}>
          <WorkspaceIcon name="profile" />
          Личные данные
        </Link>
        <div className={styles.demoAccount}>
          <span>Д</span>
          <div>
            <strong>Демо-пространство</strong>
            <small>Тестовая страница</small>
          </div>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <button
            className={styles.mobileToggle}
            aria-label="Открыть боковое меню"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            <WorkspaceIcon name="menu" />
          </button>
          <div>
            Рабочее пространство <span>/</span> <strong>Персонал</strong>
          </div>
          <span className={styles.previewBadge}>
            <span />
            Интерактивный макет
          </span>
        </header>
        <main className={styles.main}>
          <div className={styles.heading}>
            <div>
              <div className={styles.eyebrow}>ЛЮДИ И ИХ ИСТОРИЯ</div>
              <h1>
                Персонал<span>{people.length}</span>
              </h1>
              <p>Проживание, вахты и контакты — в одном месте.</p>
            </div>
            <div className={styles.headingActions}>
              <button className={styles.secondary} onClick={() => setGuide(true)}>
                <Icon name="info" />О макете
              </button>
              <button
                className={styles.primary}
                onClick={() => {
                  setView('workspace');
                  setEditor(null);
                }}
                disabled={blocks.length >= 20}
              >
                <Icon name="plus" />
                Добавить блок
              </button>
            </div>
          </div>
          <div className={styles.pageTabs}>
            <div className={styles.tabs} role="tablist" aria-label="Раздел персонала">
              <button
                role="tab"
                aria-selected={view === 'workspace'}
                onClick={() => setView('workspace')}
              >
                <Icon name="grid" />
                Рабочая поверхность
              </button>
              <button role="tab" aria-selected={view === 'list'} onClick={() => showList('all')}>
                <Icon name="list" />
                Сотрудники<span>{people.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={view === 'planning'}
                onClick={() => setView('planning')}
              >
                <Icon name="calendar" />
                План заездов
              </button>
              <button
                role="tab"
                aria-selected={view === 'matches'}
                onClick={() => setView('matches')}
              >
                <Icon name="search" />
                Совпадения
                <span>{matches.filter((match) => !state.resolutions[match.id]).length}</span>
              </button>
            </div>
            <span className={styles.saved}>
              <Icon name={storageError || operationsStorageError ? 'alert' : 'check'} />
              {storageError || operationsStorageError
                ? 'Изменения только до закрытия страницы'
                : 'Сохранено в браузере'}
            </span>
          </div>
          <div className={styles.toolbar}>
            <div className={styles.filterFields}>
              <label>
                <WorkspaceIcon name="house" />
                <select
                  aria-label="Общежитие на странице"
                  value={dormitory}
                  onChange={(event) => {
                    setDormitory(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">Все общежития</option>
                  {dormitories.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <Icon name="calendar" />
                <select
                  aria-label="Период окончания вахты"
                  value={days}
                  onChange={(event) => {
                    setDays(Number(event.target.value));
                    setPage(0);
                  }}
                >
                  {[...new Set([5, 7, 14, 30, days])]
                    .sort((a, b) => a - b)
                    .map((n) => (
                      <option key={n} value={n}>
                        Вахта: до {n} дней
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {view === 'workspace' ? (
              <button
                className={`${styles.textButton} ${editing ? styles.activeText : ''}`}
                onClick={() => setEditing(!editing)}
              >
                <Icon name={editing ? 'check' : 'settings'} />
                {editing ? 'Готово' : 'Настроить поверхность'}
              </button>
            ) : (
              <span className={styles.smallMuted}>Нажмите на имя, чтобы открыть историю</span>
            )}
          </div>
          <div className={styles.snapshot}>
            <span>
              <span className={styles.liveDot} />
              Демонстрационный срез на 10 октября 2026
            </span>
            <span>Вымышленные сотрудники и телефоны</span>
          </div>
          <div className={styles.metrics}>
            <button onClick={() => showList('current')}>
              <span className={`${styles.metricIcon} ${styles.green}`}>
                <WorkspaceIcon name="people" />
              </span>
              <span>
                <strong>{residents.length}</strong>
                <small>Проживают сейчас</small>
              </span>
              <Icon name="arrow" />
            </button>
            <button onClick={() => showList('ending')}>
              <span className={`${styles.metricIcon} ${styles.sand}`}>
                <Icon name="calendar" />
              </span>
              <span>
                <strong>{soon.length}</strong>
                <small>Вахта заканчивается до {days} дней</small>
              </span>
              <Icon name="arrow" />
            </button>
            <button onClick={() => showList('overdue')}>
              <span className={`${styles.metricIcon} ${styles.peach}`}>
                <Icon name="history" />
              </span>
              <span>
                <strong>{overdue.length}</strong>
                <small>Дата окончания уже прошла</small>
              </span>
              <Icon name="arrow" />
            </button>
            <button onClick={() => showList('missing')}>
              <span className={`${styles.metricIcon} ${styles.neutral}`}>
                <Icon name="alert" />
              </span>
              <span>
                <strong>{missing.length}</strong>
                <small>Нужно дополнить данные</small>
              </span>
              <Icon name="arrow" />
            </button>
          </div>
          {view === 'workspace' ? (
            <>
              {editing && (
                <div className={styles.editBanner}>
                  <div>
                    <Icon name="settings" />
                    <span>
                      <strong>Настройка поверхности</strong> Меняйте порядок стрелками, выбирайте
                      ширину и состав блоков.
                    </span>
                  </div>
                  <button className={styles.textButton} onClick={() => setReset(true)}>
                    Вернуть начальный вид
                  </button>
                </div>
              )}
              <div className={styles.blockGrid}>
                {blocks.map((block, index) => (
                  <article
                    key={block.id}
                    className={`${styles.block} ${block.width === 'full' ? styles.fullWidth : ''}`}
                    data-testid={`personnel-block-${block.id}`}
                  >
                    {editing && (
                      <div className={styles.blockTools}>
                        <span>
                          Блок {index + 1} · {block.width === 'full' ? 'вся ширина' : '½ ширины'}
                        </span>
                        <button
                          className={styles.iconButton}
                          disabled={index === 0}
                          aria-label={`Поднять блок «${block.title}»`}
                          onClick={() => moveBlock(index, -1)}
                        >
                          <Icon name="up" />
                        </button>
                        <button
                          className={styles.iconButton}
                          disabled={index === blocks.length - 1}
                          aria-label={`Опустить блок «${block.title}»`}
                          onClick={() => moveBlock(index, 1)}
                        >
                          <Icon name="down" />
                        </button>
                        <button
                          className={styles.iconButton}
                          aria-label={`Убрать блок «${block.title}»`}
                          onClick={() => {
                            setBlocks((old) => old.filter((b) => b.id !== block.id));
                            setToast('Блок убран. Его можно добавить снова.');
                          }}
                        >
                          <Icon name="close" />
                        </button>
                      </div>
                    )}
                    <div className={styles.blockHeading}>
                      <span className={`${styles.blockIcon} ${styles[block.kind]}`}>
                        <Icon name={blockIcons[block.kind]} />
                      </span>
                      <div>
                        <h2>{block.title}</h2>
                        <Scope block={block} dormitory={dormitory} />
                      </div>
                      <button
                        className={styles.iconButton}
                        onClick={() => setEditor(block)}
                        aria-label={`Настроить блок «${block.title}»`}
                      >
                        <Icon name="settings" />
                      </button>
                    </div>
                    <BlockBody
                      block={block}
                      dormitory={dormitory}
                      days={days}
                      onPerson={openPerson}
                      onList={showList}
                      onCopy={(text) => void copyPhone(text)}
                      onView={setView}
                      onSaved={openSavedList}
                    />
                  </article>
                ))}
                <button
                  className={styles.addBlock}
                  onClick={() => setEditor(null)}
                  disabled={blocks.length >= 20}
                >
                  <span>
                    <Icon name="plus" />
                  </span>
                  <strong>Добавить свой блок</strong>
                  <small>Показатели, ближайшие вахты, контакты или история оттока</small>
                </button>
              </div>
            </>
          ) : view === 'planning' ? (
            <PlanningBoard dormitory={dormitory} onPerson={openPerson} />
          ) : view === 'matches' ? (
            <MatchesBoard dormitory={dormitory} onPerson={openPerson} />
          ) : (
            <section className={styles.roster}>
              <SavedListsBar onOpen={openSavedList} onSave={() => setSavingList(true)} />
              <div className={styles.rosterHeading}>
                <div>
                  <h2>
                    {listNames[filter]} <span>{filtered.length}</span>
                  </h2>
                  <p>
                    {filter === 'history'
                      ? 'Есть записи в оттоке, в том числе до повторного заселения.'
                      : filter === 'overdue'
                        ? 'Дата прошла, но сотрудник всё ещё числится в проживающих.'
                        : 'Карточка связывает все вахты и перемещения одного человека.'}
                  </p>
                </div>
                <label className={styles.search}>
                  <Icon name="search" />
                  <input
                    aria-label="Поиск сотрудника"
                    placeholder="Имя, табельный номер, телефон"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(0);
                    }}
                  />
                </label>
              </div>
              <div className={styles.filterChips}>
                {(Object.keys(listNames) as ListFilter[]).map((id) => (
                  <button
                    key={id}
                    aria-pressed={filter === id}
                    onClick={() => {
                      setFilter(id);
                      setPage(0);
                    }}
                  >
                    {listNames[id]}
                  </button>
                ))}
              </div>
              {listScope.length > 0 && (
                <div className={styles.scopeFilter}>
                  <span>Выбор из блока: {listScope.map(dormName).join(', ')}</span>
                  <button
                    className={styles.textButton}
                    onClick={() => {
                      setListScope([]);
                      setPage(0);
                    }}
                  >
                    Сбросить <Icon name="close" />
                  </button>
                </div>
              )}
              <div className={ops.bulkBar}>
                <div>
                  <strong>
                    {checkedPeople.length
                      ? `Выбрано: ${checkedPeople.length}`
                      : `Список: ${filtered.length}`}
                  </strong>
                  {checkedPeople.length > 0 && (
                    <button className={styles.textButton} onClick={() => setSelectedIds([])}>
                      Снять выбор
                    </button>
                  )}
                </div>
              </div>
              <div className={styles.tableScroll}>
                <table>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label={`Выбрать весь список: ${filtered.length}`}
                          checked={filtered.length > 0 && checkedPeople.length === filtered.length}
                          disabled={!filtered.length}
                          onChange={(event) =>
                            setSelectedIds(
                              event.target.checked ? filtered.map((person) => person.id) : [],
                            )
                          }
                        />
                      </th>
                      <th>Сотрудник</th>
                      <th>Проживание</th>
                      <th>Период вахты</th>
                      <th>Статус</th>
                      <th>Телефон</th>
                      <th>
                        <span className="visually-hidden">Карточка</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(currentPage * 10, currentPage * 10 + 10).map((person) => (
                      <tr key={person.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Выбрать сотрудника ${person.name}`}
                            checked={selectedIds.includes(person.id)}
                            onChange={(event) =>
                              setSelectedIds(
                                event.target.checked
                                  ? [...selectedIds.filter((id) => id !== person.id), person.id]
                                  : selectedIds.filter((id) => id !== person.id),
                              )
                            }
                          />
                        </td>
                        <td>
                          <div className={ops.rosterPerson}>
                            <FavoriteButton person={person} />
                            <PersonButton
                              person={person}
                              onClick={() => openPerson(person)}
                              subtitle={`Т/н ${person.number} · ${person.role}`}
                            />
                          </div>
                        </td>
                        <td>
                          <strong>{dormName(person.dormitoryId)}</strong>
                          <small>{person.current ? person.room : 'Последнее общежитие'}</small>
                        </td>
                        <td>
                          <span>
                            {person.start ? dateLabel(person.start) : 'Не указано'} —{' '}
                            {person.end ? dateLabel(person.end) : 'Не указано'}
                          </span>
                          <small>{person.current ? deadline(person) : 'Вахта завершена'}</small>
                        </td>
                        <td>
                          <span
                            className={`${styles.badge} ${person.current ? styles.green : styles.neutral}`}
                          >
                            {person.current ? 'Проживает' : 'В оттоке'}
                          </span>
                          {person.history.some((e) => e.kind === 'outflow') && person.current && (
                            <button
                              className={styles.historyLink}
                              onClick={() => openPerson(person, 'history')}
                            >
                              Есть история оттока
                            </button>
                          )}
                        </td>
                        <td>
                          {person.phone ? (
                            person.phone
                          ) : (
                            <span className={styles.missing}>Не указан</span>
                          )}
                        </td>
                        <td>
                          <button
                            className={styles.iconButton}
                            onClick={() => openPerson(person)}
                            aria-label={`Открыть карточку ${person.name}`}
                          >
                            <Icon name="arrow" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!filtered.length && <Empty>Сотрудники не найдены</Empty>}
              <div className={styles.pagination}>
                <span>
                  {filtered.length
                    ? `${currentPage * 10 + 1}–${Math.min(filtered.length, currentPage * 10 + 10)} из ${filtered.length}`
                    : '0 сотрудников'}
                </span>
                <div>
                  <button
                    className={styles.secondary}
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Назад
                  </button>
                  <button
                    className={styles.secondary}
                    disabled={(currentPage + 1) * 10 >= filtered.length}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Далее
                  </button>
                </div>
              </div>
            </section>
          )}
          <footer className={styles.pageFooter}>
            <span>Домовой / Персонал</span>
            <span>Демонстрационные изменения сохраняются в этом браузере</span>
          </footer>
        </main>
      </div>
      {editor !== undefined && (
        <BlockEditor
          key={editor?.id ?? 'new'}
          initial={editor}
          days={days}
          dormitory={dormitory}
          onClose={() => setEditor(undefined)}
          onSave={(block) => {
            setBlocks((old) =>
              editor ? old.map((b) => (b.id === block.id ? block : b)) : [...old, block],
            );
            setEditor(undefined);
            setToast(editor ? 'Настройки блока сохранены' : 'Блок добавлен на поверхность');
          }}
        />
      )}
      {selected && (
        <PersonDrawer
          key={selected.person.id}
          person={people.find((person) => person.id === selected.person.id) ?? selected.person}
          initialTab={selected.tab}
          onClose={() => setSelected(null)}
          onCopy={(text) => void copyPhone(text)}
        />
      )}
      {savingList && (
        <SaveListDialog
          draft={{ ...listDraft, id: crypto.randomUUID() }}
          onClose={() => setSavingList(false)}
          onSaved={(list, pin) => {
            if (pin && blocks.length < 20)
              setBlocks((old) => [
                ...old,
                {
                  id: crypto.randomUUID(),
                  kind: 'saved',
                  title: list.name,
                  savedListId: list.id,
                  scope: [],
                  width: 'half',
                  days: null,
                  showPhone: false,
                  presentation: 'distribution',
                },
              ]);
            setSavingList(false);
            setToast(
              pin && blocks.length >= 20
                ? 'Список сохранён. Для закрепления уберите один из 20 блоков.'
                : 'Список сохранён',
            );
          }}
        />
      )}
      {guide && (
        <Modal
          title="Как будет устроен «Персонал»"
          testId="personnel-guide"
          onClose={() => setGuide(false)}
          panelClassName={`${styles.guide} ${styles.theme}`}
        >
          <p className={styles.dialogLead}>
            Здесь можно проверить идею до подключения к рабочим данным.
          </p>
          <div className={styles.guideSteps}>
            <section>
              <span>01</span>
              <div>
                <h3>Ваша рабочая поверхность</h3>
                <p>
                  Вы выбираете блоки, общежития, период окончания вахты и порядок. Нажатие на число
                  открывает список людей, а на имя — карточку с историей.
                </p>
              </div>
            </section>
            <section>
              <span>02</span>
              <div>
                <h3>Одна постоянная карточка человека</h3>
                <p>
                  Проживание, вахты и события связываются по постоянному идентификатору сотрудника.
                  Совпадения ФИО недостаточно: существующие записи нужно сопоставить по проверенным
                  табельным номерам и отдельно разобрать неоднозначные.
                </p>
              </div>
            </section>
            <section>
              <span>03</span>
              <div>
                <h3>История не теряется при оттоке</h3>
                <p>
                  Заселение, перевод, продление вахты и отток сохраняются отдельными событиями с
                  датой, общежитием и причиной. Возвращение сотрудника добавляет новую вахту в ту же
                  карточку.
                </p>
              </div>
            </section>
            <section>
              <span>04</span>
              <div>
                <h3>Даты и статусы — явно</h3>
                <p>
                  «До 5 дней» включает сегодня и следующие пять дней. Прошедшая дата не означает
                  автоматический отток. Пустые даты и телефоны попадают в «Неполные данные».
                  Длительность вахты в календарных днях не заменяет количество рабочих смен.
                </p>
              </div>
            </section>
          </div>
          <div className={styles.guideNote}>
            <strong>При внедрении потребуется</strong>
            <p>
              Добавить постоянные карточки, периоды проживания, вахты и журнал событий; подключить
              их к действующим операциям заселения, перевода и оттока. Сохранённую историю переносим
              из имеющихся записей — утраченные события не выдумываем. Настройки поверхности
              сохраняем для пользователя, доступ к телефонам и общежитиям учитываем по его правам.
            </p>
          </div>
          <p className={styles.smallMuted}>
            Сейчас все записи вымышлены. Настройки блоков, заметки и планы сохраняются в этом
            браузере. Рабочие данные доступны в основном разделе «Персонал».
          </p>
          <button className={styles.primary} onClick={() => setGuide(false)}>
            Попробовать макет <Icon name="arrow" />
          </button>
        </Modal>
      )}
      {reset && (
        <Modal
          title="Вернуть начальную поверхность?"
          testId="personnel-reset"
          onClose={() => setReset(false)}
          panelClassName={styles.theme}
        >
          <p>Настройки демонстрационных блоков будут заменены шестью начальными блоками.</p>
          <div className={styles.dialogFooter}>
            <button className={styles.secondary} onClick={() => setReset(false)}>
              Отмена
            </button>
            <button
              className={styles.primary}
              onClick={() => {
                setBlocks(initialBlocks.map((b) => ({ ...b, scope: [] })));
                setReset(false);
                setToast('Начальный вид восстановлен');
              }}
            >
              Восстановить
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className={styles.toast} role="status">
          <Icon name="info" />
          {toast}
        </div>
      )}
    </div>
  );
}

export function PersonnelDesignPreview(): JSX.Element {
  return (
    <PersonnelOperationsProvider>
      <PersonnelPreviewContent />
    </PersonnelOperationsProvider>
  );
}
