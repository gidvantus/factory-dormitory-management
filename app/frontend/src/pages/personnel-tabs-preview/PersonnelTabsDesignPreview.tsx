import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import { PersonnelBlockIcon as Icon } from '../../workspace/personnel/PersonnelBlockIcon';
import house from '../../assets/dorm-house.svg';
import resident from '../../assets/avatar-rezident.svg';
import manager from '../../assets/avatar-kadrovik.svg';
import commandant from '../../assets/avatar-komendant.svg';
import plant from '../../assets/plant.svg';
import context from '../DashboardTariffDesignPreview.module.css';
import lab from '../PricingDesignPreview.module.css';
import workspace from '../../workspace/Workspace.module.css';
import {
  TODAY,
  addDays,
  dateLabel,
  daysLeft,
  designs,
  dorms,
  employees,
  extraNames,
  initialArrivals,
  initials,
  monthLabel,
  weekday,
} from './data';
import type { Arrival, Employee, ExtraBlock, ExtraKind } from './data';
import s from './PersonnelTabsDesignPreview.module.css';

type Tab = 'employees' | 'planning';
const navigation: { icon: WorkspaceIconName; label: string }[] = [
  { icon: 'overview', label: 'Обзор' },
  { icon: 'house', label: 'Общежития' },
  { icon: 'chart', label: 'Тарифы' },
  { icon: 'info', label: 'Магазин улучшений' },
  { icon: 'document', label: 'Документы' },
  { icon: 'people', label: 'Персонал' },
  { icon: 'chart', label: 'Статистика' },
];

function Avatar({ person }: { person: Employee }): JSX.Element {
  return (
    <span className={s.avatar} data-tone={person.id % 3} aria-hidden="true">
      {initials(person.name)}
    </span>
  );
}
function Shift({ person, chart }: { person: Employee; chart: boolean }): JSX.Element {
  const left = daysLeft(person);
  return (
    <div className={s.shift}>
      <span>{person.current ? `1 окт. — ${dateLabel(person.end)}` : 'Вахта завершена'}</span>
      {chart && person.current && (
        <>
          <div className={s.track}>
            <i style={{ width: `${Math.min(100, (14 / (14 + Math.max(0, left))) * 100)}%` }} />
          </div>
          <small>{left === 0 ? 'Заканчивается сегодня' : `Осталось ${left} дн.`}</small>
        </>
      )}
    </div>
  );
}
function Profile({ person }: { person: Employee }): JSX.Element {
  return (
    <div className={s.profile} data-testid="preview-employee-detail">
      <img src={person.id % 2 ? resident : manager} alt="" />
      <span className={s.kicker}>Карточка сотрудника</span>
      <h3>{person.name}</h3>
      <p>Табельный № {String(person.id).padStart(3, '0')}</p>
      <dl>
        <div>
          <dt>Проживание</dt>
          <dd>{person.current ? person.dorm : 'Вне общежитий'}</dd>
        </div>
        <div>
          <dt>Комната</dt>
          <dd>{person.room}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd>{person.phone}</dd>
        </div>
        <div>
          <dt>Вахта до</dt>
          <dd>{dateLabel(person.end)}</dd>
        </div>
      </dl>
      <Shift person={person} chart />
    </div>
  );
}

export function PersonnelTabsDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('variant') ?? 1);
  const design = Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : 1;
  const tab: Tab = params.get('tab') === 'planning' ? 'planning' : 'employees';
  const [query, setQuery] = useState('');
  const [dorm, setDorm] = useState('all');
  const [filter, setFilter] = useState('all');
  const [empty, setEmpty] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [focusPerson, setFocusPerson] = useState(1);
  const [personDialog, setPersonDialog] = useState<Employee | null>(null);
  const [arrivals, setArrivals] = useState(initialArrivals);
  const [start, setStart] = useState(TODAY);
  const [focusDate, setFocusDate] = useState(TODAY);
  const [arrivalDraft, setArrivalDraft] = useState<Arrival | null>(null);
  const [extras, setExtras] = useState<Record<Tab, ExtraBlock[]>>({ employees: [], planning: [] });
  const [blockDraft, setBlockDraft] = useState<ExtraBlock | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const previous = document.title;
    document.title = 'Сотрудники и План заездов — 5 вариантов — Домовой';
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    if (!personDialog && !arrivalDraft && !blockDraft) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, [personDialog, arrivalDraft, blockDraft]);
  const change = (key: 'tab' | 'variant', value: string): void => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { preventScrollReset: true });
  };
  const people = (empty ? [] : employees).filter(
    (p) =>
      (dorm === 'all' || p.dorm === dorm) &&
      (filter === 'all' ||
        (filter === 'current' && p.current) ||
        (filter === 'ending' && p.current && daysLeft(p) <= 5)) &&
      `${p.name} ${p.id} ${p.phone}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru').trim()),
  );
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const plans = (empty ? [] : arrivals).filter(
    (p) => (dorm === 'all' || p.dorm === dorm) && p.date >= start && p.date <= days[6],
  );
  const total = plans.reduce((sum, p) => sum + p.count, 0);
  const currentDorms = dorm === 'all' ? dorms : [dorm];
  const currentExtras = extras[tab];
  const focused = people.find((p) => p.id === focusPerson) ?? people[0];
  const selectedDay = days.includes(focusDate) ? focusDate : start;
  function updateExtras(value: ExtraBlock[]): void {
    setExtras((previous) => ({ ...previous, [tab]: value }));
  }
  function newExtra(kind: ExtraKind = tab === 'employees' ? 'saved' : 'plans'): ExtraBlock {
    return { id: crypto.randomUUID(), kind, title: extraNames[kind], wide: false };
  }
  function presetExtras(count: number): void {
    updateExtras(
      Array.from({ length: count }, (_, i) =>
        newExtra((['saved', 'ending', 'contacts', 'plans', 'residents'] as const)[i % 5]),
      ),
    );
  }
  function openPerson(person: Employee): void {
    setFocusPerson(person.id);
    if (design !== 5) setPersonDialog(person);
  }
  function togglePerson(id: number): void {
    setSelected((value) =>
      value.includes(id) ? value.filter((item) => item !== id) : [...value, id],
    );
  }
  function addArrival(date = start, location = dorm === 'all' ? dorms[0] : dorm): void {
    setArrivalDraft({ id: 0, date, dorm: location, count: 1, names: '' });
  }
  function moveExtra(index: number, step: number): void {
    const next = [...currentExtras];
    if (index + step < 0 || index + step >= next.length) return;
    [next[index], next[index + step]] = [next[index + step], next[index]];
    updateExtras(next);
  }
  const personName = (p: Employee): JSX.Element => (
    <button className={s.personName} onClick={() => openPerson(p)}>
      <Avatar person={p} />
      <span>
        <strong>{p.name}</strong>
        <small>Т/н {String(p.id).padStart(3, '0')}</small>
      </span>
    </button>
  );
  const employeeRows = (rows: Employee[], compact = false): JSX.Element =>
    design === 3 || compact ? (
      <div className={s.peopleList}>
        {rows.map((p) => (
          <div
            className={s.personRow}
            key={p.id}
            data-active={design === 5 && focused?.id === p.id}
          >
            <input
              type="checkbox"
              aria-label={`Выбрать ${p.name}`}
              checked={selected.includes(p.id)}
              onChange={() => togglePerson(p.id)}
            />
            {personName(p)}
            <span className={s.rowDorm}>
              {p.current ? p.dorm : 'Вне общежитий'}
              <small>{p.current ? p.room : 'Вахта завершена'}</small>
            </span>
            {!compact && <Shift person={p} chart />}
            <span className={s.badge} data-warning={p.current && daysLeft(p) <= 5}>
              {p.current
                ? daysLeft(p) <= 5
                  ? `Ещё ${daysLeft(p)} дн.`
                  : 'Проживает'
                : 'Вне общежитий'}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <div className={s.tableScroll}>
        <table className={s.employeeTable}>
          <thead>
            <tr>
              <th scope="col">Сотрудник</th>
              <th scope="col">Проживание</th>
              <th scope="col">Период вахты</th>
              <th scope="col">Статус</th>
              <th scope="col">Телефон</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className={s.identity}>
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${p.name}`}
                      checked={selected.includes(p.id)}
                      onChange={() => togglePerson(p.id)}
                    />
                    {personName(p)}
                  </div>
                </td>
                <td data-label="Проживание">
                  {p.current ? p.dorm : 'Вне общежитий'}
                  <small>{p.room}</small>
                </td>
                <td data-label="Вахта">
                  <Shift person={p} chart={design === 2} />
                </td>
                <td data-label="Статус">
                  <span className={s.badge} data-warning={p.current && daysLeft(p) <= 5}>
                    {p.current ? 'Проживает' : 'Вне общежитий'}
                  </span>
                </td>
                <td data-label="Телефон">{p.phone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const arrivalItem = (plan: Arrival): JSX.Element => (
    <button key={plan.id} className={s.arrivalItem} onClick={() => setArrivalDraft({ ...plan })}>
      <span className={s.dateTile}>
        <strong>{Number(plan.date.slice(-2))}</strong>
        <small>{monthLabel(plan.date)}</small>
      </span>
      <span>
        <strong>{plan.dorm}</strong>
        <small>{plan.names || 'ФИО пока не указаны'}</small>
      </span>
      <b>{plan.count} чел.</b>
    </button>
  );
  const dayList = (date: string): JSX.Element => (
    <div className={s.dayList}>
      {plans.filter((p) => p.date === date).map(arrivalItem)}
      <button className={s.addInline} onClick={() => addArrival(date)}>
        <Icon name="plus" /> Добавить заезд
      </button>
    </div>
  );
  const agenda = (): JSX.Element => (
    <div className={s.timeline}>
      {days.map((day) => (
        <section className={s.timelineDay} key={day}>
          <div className={s.timelineDate}>
            <strong>{Number(day.slice(-2))}</strong>
            <span>
              {monthLabel(day)} · {weekday(day)}
            </span>
          </div>
          {dayList(day)}
        </section>
      ))}
    </div>
  );
  const weekMatrix = (): JSX.Element => (
    <>
      <div className={`${s.tableScroll} ${s.desktopCalendar}`}>
        <table className={s.calendar}>
          <caption className={s.srOnly}>План заездов по общежитиям и датам</caption>
          <thead>
            <tr>
              <th scope="col">Общежитие</th>
              {days.map((day) => (
                <th key={day} scope="col" data-today={day === TODAY}>
                  <strong>{Number(day.slice(-2))}</strong>
                  <small>
                    {monthLabel(day)} · {weekday(day)}
                  </small>
                </th>
              ))}
              <th scope="col">Всего</th>
            </tr>
          </thead>
          <tbody>
            {currentDorms.map((location) => (
              <tr key={location}>
                <th scope="row">
                  <WorkspaceIcon name="house" />
                  {location}
                </th>
                {days.map((day) => {
                  const cell = plans.filter((p) => p.dorm === location && p.date === day);
                  return (
                    <td key={day} data-filled={cell.length > 0} data-today={day === TODAY}>
                      {cell.length ? (
                        cell.map((plan) => (
                          <button
                            className={s.calendarCell}
                            key={plan.id}
                            onClick={() => setArrivalDraft({ ...plan })}
                            aria-label={`${location}, ${dateLabel(day)}, ${plan.count} человек`}
                          >
                            <strong>{plan.count}</strong>
                            <small>{plan.names.split(',')[0] || 'Без ФИО'}</small>
                          </button>
                        ))
                      ) : (
                        <button
                          className={`${s.calendarCell} ${s.emptyCell}`}
                          aria-label={`Добавить заезд: ${location}, ${day}`}
                          onClick={() => addArrival(day, location)}
                        >
                          +
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className={s.total}>
                  {plans.filter((p) => p.dorm === location).reduce((sum, p) => sum + p.count, 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.mobileCalendar}>{agenda()}</div>
    </>
  );
  function extraBody(block: ExtraBlock): JSX.Element {
    if (block.kind === 'plans')
      return (
        <div>
          {plans.slice(0, 2).map(arrivalItem)}
          {!plans.length && <p className={s.muted}>За этот период заездов нет</p>}
        </div>
      );
    if (block.kind === 'residents')
      return (
        <div className={s.distribution}>
          {currentDorms.map((location) => {
            const count = people.filter((p) => p.current && p.dorm === location).length;
            return (
              <div key={location}>
                <span>
                  <WorkspaceIcon name="house" />
                  {location}
                  <b>{count}</b>
                </span>
                <div className={s.track}>
                  <i style={{ width: `${(count / Math.max(1, people.length)) * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      );
    const rows = (
      block.kind === 'ending' ? people.filter((p) => p.current && daysLeft(p) <= 5) : people
    ).slice(0, 2);
    return (
      <div>
        {rows.map((p) => (
          <div className={s.extraPerson} key={p.id}>
            {personName(p)}
            <span>
              {block.kind === 'contacts'
                ? p.phone
                : block.kind === 'ending'
                  ? `${daysLeft(p)} дн.`
                  : p.dorm}
            </span>
          </div>
        ))}
        {!rows.length && <p className={s.muted}>Нет сотрудников по выбранным условиям</p>}
      </div>
    );
  }
  return (
    <div className={`${context.page} ${s.page}`} data-testid="personnel-tabs-preview">
      <header className={lab.lab}>
        <div className={context.container}>
          <div className={lab.labTop}>
            <Link className={context.labBrand} to="/">
              <WorkspaceIcon name="house" />
              Домовой<span>/ Дизайн-примерочная</span>
            </Link>
            <span className={lab.testBadge}>Тестовая страница</span>
          </div>
          <div className={lab.labHeading}>
            <div>
              <h1>Сотрудники и План заездов</h1>
              <p>Пять вариантов оформления. Переключайте подвкладки и добавляйте свои блоки.</p>
            </div>
          </div>
          <nav className={`${lab.variantNav} ${s.designNav}`} aria-label="Варианты оформления">
            {designs.map((item, index) => (
              <button
                key={item.name}
                type="button"
                className={`btn btn--sm ${design === index + 1 ? 'btn--ink' : 'btn--outline'}`}
                aria-pressed={design === index + 1}
                onClick={() => change('variant', String(index + 1))}
              >
                <span className={lab.navNumber}>0{index + 1}</span>
                {item.name}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className={context.container}>
        <div className={context.stateBar}>
          <div className={context.stateButtons}>
            <span>Дополнительные блоки:</span>
            {[0, 4, 8].map((count) => (
              <button
                key={count}
                className={`btn btn--compact ${currentExtras.length === count ? 'btn--ink' : 'btn--outline'}`}
                onClick={() => presetExtras(count)}
              >
                {count === 0 ? 'Без блоков' : `${count} блоков`}
              </button>
            ))}
            <button
              className={`btn btn--compact ${empty ? 'btn--ink' : 'btn--ghost'}`}
              aria-pressed={empty}
              onClick={() => setEmpty(!empty)}
            >
              Без данных
            </button>
          </div>
          <span className={context.snapshot}>Демонстрационные данные · 15 октября 2026</span>
        </div>
        <div className={`${workspace.shell} ${context.frame} ${s.frame}`}>
          <aside className={context.sidebar}>
            <div className={context.sidebarBrand}>
              <WorkspaceIcon name="house" />
              <strong>Домовой</strong>
            </div>
            <p className={context.sidebarCaption}>Рабочее пространство</p>
            <ul>
              {navigation.map((item) => (
                <li
                  key={item.label}
                  className={context.contextNav}
                  data-active={item.label === 'Персонал'}
                >
                  <WorkspaceIcon name={item.icon} />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </aside>
          <div className={context.workspace}>
            <div className={context.topbar}>
              <span>
                Рабочее пространство / <strong>Персонал</strong>
              </span>
              <span className={context.contextBadge}>Предпросмотр</span>
            </div>
            <div className={s.content} data-design={design}>
              <div className={s.pageHeading}>
                <div>
                  <span className={s.kicker}>Люди и их история</span>
                  <h2>Персонал</h2>
                  <p>Проживание, вахты и контакты — в одном месте.</p>
                </div>
                <button
                  className="btn btn--outline btn--compact"
                  onClick={() => setBlockDraft(newExtra())}
                  disabled={currentExtras.length >= 20}
                >
                  <Icon name="plus" /> Добавить блок
                </button>
              </div>
              <div className={s.tabs} role="tablist" aria-label="Подвкладки персонала">
                {(['employees', 'planning'] as const).map((value) => (
                  <button
                    className={s.tabButton}
                    key={value}
                    id={`preview-tab-${value}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    aria-controls="personnel-tab-content"
                    onClick={() => change('tab', value)}
                  >
                    {value === 'employees' ? (
                      <WorkspaceIcon name="people" />
                    ) : (
                      <Icon name="plans" />
                    )}
                    {value === 'employees' ? 'Сотрудники' : 'План заездов'}
                    {value === 'employees' && <b>{employees.length}</b>}
                  </button>
                ))}
              </div>
              <div className={s.designNote}>
                <strong>{designs[design - 1].name}</strong>
                <span>{designs[design - 1].note}</span>
              </div>
              <section
                id="personnel-tab-content"
                role="tabpanel"
                aria-labelledby={`preview-tab-${tab}`}
                data-testid={`preview-${tab}`}
              >
                <div className={s.sectionHero}>
                  <div>
                    <h3>{tab === 'employees' ? 'Сотрудники' : 'План заездов'}</h3>
                    <p>
                      {tab === 'employees'
                        ? 'Люди, контакты и сроки вахт'
                        : 'Заезды по общежитиям на ближайшую неделю'}
                    </p>
                    <div className={s.inlineStats}>
                      {tab === 'employees' ? (
                        <>
                          <span>
                            <b>{people.length}</b> в списке
                          </span>
                          <span>
                            <i />
                            <b>{people.filter((p) => p.current).length}</b> проживают
                          </span>
                          <span>
                            <Icon name="ending" />
                            <b>{people.filter((p) => p.current && daysLeft(p) <= 5).length}</b>{' '}
                            завершают вахту
                          </span>
                        </>
                      ) : (
                        <>
                          <span>
                            <b>{total}</b> человек ожидается
                          </span>
                          <span>
                            <b>{plans.length}</b> заездов
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={s.heroArt} aria-hidden="true">
                    {tab === 'employees' ? (
                      <>
                        <img src={resident} alt="" />
                        <img src={manager} alt="" />
                        <img src={commandant} alt="" />
                      </>
                    ) : (
                      <>
                        <div className={s.paperCalendar}>
                          <span>{monthLabel(start, true).toLocaleUpperCase('ru')}</span>
                          <strong>{Number(start.slice(-2))}</strong>
                        </div>
                        <img className={s.house} src={house} alt="" />
                      </>
                    )}
                  </div>
                </div>
                <div className={s.toolbar}>
                  <label>
                    Общежитие
                    <select value={dorm} onChange={(event) => setDorm(event.target.value)}>
                      <option value="all">Все общежития</option>
                      {dorms.map((location) => (
                        <option key={location}>{location}</option>
                      ))}
                    </select>
                  </label>
                  {tab === 'employees' ? (
                    <>
                      <label className={s.search}>
                        Поиск
                        <input
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder="Имя, табельный номер, телефон"
                        />
                      </label>
                      <button
                        className="btn btn--outline btn--compact"
                        disabled={currentExtras.length >= 20}
                        onClick={() =>
                          setBlockDraft({
                            ...newExtra('saved'),
                            title: query ? `Список: ${query}` : 'Мой список сотрудников',
                          })
                        }
                      >
                        <Icon name="saved" /> Сохранить список
                      </button>
                    </>
                  ) : (
                    <button className="btn btn--primary btn--compact" onClick={() => addArrival()}>
                      <Icon name="plus" /> Добавить заезд
                    </button>
                  )}
                </div>
                {tab === 'employees' ? (
                  <>
                    <div className={s.filters}>
                      {[
                        ['all', 'Все сотрудники'],
                        ['current', 'Проживают'],
                        ['ending', 'Вахта заканчивается'],
                      ].map(([value, label]) => (
                        <button
                          className={s.filterChip}
                          key={value}
                          aria-pressed={filter === value}
                          onClick={() => setFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                      <span>
                        {selected.length
                          ? `Выбрано: ${selected.length}`
                          : 'Нажмите на имя, чтобы открыть карточку'}
                      </span>
                      {selected.length > 0 && (
                        <button className={s.filterChip} onClick={() => setSelected([])}>
                          Снять выбор
                        </button>
                      )}
                    </div>
                    {!people.length ? (
                      <div className={s.empty}>
                        <img src={plant} alt="" />
                        <h3>Сотрудники не найдены</h3>
                        <p>Измените поиск или фильтры.</p>
                      </div>
                    ) : design === 4 ? (
                      <div className={s.folders}>
                        {currentDorms.map((location, index) => (
                          <section className={s.folder} data-tone={index} key={location}>
                            <h4>
                              <WorkspaceIcon name="house" />
                              {location}
                              <b>{people.filter((p) => p.dorm === location).length}</b>
                            </h4>
                            {people
                              .filter((p) => p.dorm === location)
                              .map((p) => (
                                <article className={s.personCard} key={p.id}>
                                  <div className={s.cardIdentity}>
                                    {personName(p)}
                                    <input
                                      type="checkbox"
                                      aria-label={`Выбрать ${p.name}`}
                                      checked={selected.includes(p.id)}
                                      onChange={() => togglePerson(p.id)}
                                    />
                                  </div>
                                  <p>{p.current ? p.room : 'Вне общежитий'}</p>
                                  <Shift person={p} chart />
                                  <small>{p.phone}</small>
                                </article>
                              ))}
                          </section>
                        ))}
                      </div>
                    ) : design === 5 ? (
                      <div className={s.focusLayout}>
                        <div>{employeeRows(people, true)}</div>
                        {focused && <Profile person={focused} />}
                      </div>
                    ) : (
                      employeeRows(people)
                    )}
                  </>
                ) : (
                  <>
                    <div className={s.period}>
                      <button
                        className="btn btn--outline btn--compact"
                        aria-label="Предыдущая неделя"
                        onClick={() => setStart(addDays(start, -7))}
                      >
                        ←
                      </button>
                      <label>
                        С даты
                        <input
                          type="date"
                          aria-label="Начало недели"
                          value={start}
                          onChange={(event) => {
                            if (event.target.value) setStart(event.target.value);
                          }}
                        />
                      </label>
                      <span>по {dateLabel(days[6])}</span>
                      <button
                        className="btn btn--outline btn--compact"
                        aria-label="Следующая неделя"
                        onClick={() => setStart(addDays(start, 7))}
                      >
                        →
                      </button>
                      <button
                        className="btn btn--ghost btn--compact"
                        onClick={() => setStart(TODAY)}
                      >
                        Сегодня
                      </button>
                    </div>
                    {design === 2 && (
                      <div className={s.weekBars} aria-label="Количество приезжающих по дням">
                        {days.map((day) => {
                          const count = plans
                            .filter((p) => p.date === day)
                            .reduce((sum, p) => sum + p.count, 0);
                          const maximum = Math.max(
                            1,
                            ...days.map((date) =>
                              plans
                                .filter((p) => p.date === date)
                                .reduce((sum, p) => sum + p.count, 0),
                            ),
                          );
                          return (
                            <button
                              className={s.chartDay}
                              key={day}
                              onClick={() => {
                                setFocusDate(day);
                                setNotice(`${dateLabel(day)}: ожидается ${count} человек`);
                              }}
                            >
                              <b>{count}</b>
                              <span>
                                <i style={{ height: `${(count / maximum) * 100}%` }} />
                              </span>
                              <small>{dateLabel(day)}</small>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {design === 3 ? (
                      agenda()
                    ) : design === 4 ? (
                      <div className={s.folders}>
                        {currentDorms.map((location, index) => (
                          <section className={s.folder} data-tone={index} key={location}>
                            <h4>
                              <WorkspaceIcon name="house" />
                              {location}
                              <b>
                                {plans
                                  .filter((p) => p.dorm === location)
                                  .reduce((sum, p) => sum + p.count, 0)}
                              </b>
                            </h4>
                            <div className={s.folderPlans}>
                              {plans.filter((p) => p.dorm === location).map(arrivalItem)}
                              <button
                                className={s.addInline}
                                onClick={() => addArrival(start, location)}
                              >
                                <Icon name="plus" />
                                Добавить заезд
                              </button>
                            </div>
                          </section>
                        ))}
                      </div>
                    ) : design === 5 ? (
                      <div className={s.focusLayout}>
                        <div className={s.focusDays}>
                          {days.map((day) => (
                            <button
                              className={s.focusDate}
                              key={day}
                              aria-pressed={selectedDay === day}
                              onClick={() => setFocusDate(day)}
                            >
                              <span className={s.dateTile}>
                                <strong>{Number(day.slice(-2))}</strong>
                                <small>{weekday(day)}</small>
                              </span>
                              <span>
                                <strong>{dateLabel(day)}</strong>
                                <small>
                                  {plans
                                    .filter((p) => p.date === day)
                                    .map((p) => p.dorm)
                                    .join(' · ') || 'Нет заездов'}
                                </small>
                              </span>
                              <b>
                                {plans
                                  .filter((p) => p.date === day)
                                  .reduce((sum, p) => sum + p.count, 0)}{' '}
                                чел.
                              </b>
                            </button>
                          ))}
                        </div>
                        <div className={s.dayDetail}>
                          <span className={s.kicker}>Выбранная дата</span>
                          <h3>{dateLabel(selectedDay)}</h3>
                          {dayList(selectedDay)}
                        </div>
                      </div>
                    ) : (
                      weekMatrix()
                    )}
                  </>
                )}
              </section>
              <div className={s.extraHeading}>
                <h3>
                  Дополнительные блоки <small>{currentExtras.length} / 20</small>
                </h3>
                {currentExtras.length > 0 && (
                  <button
                    className="btn btn--ghost btn--compact"
                    aria-pressed={configuring}
                    onClick={() => setConfiguring(!configuring)}
                  >
                    <Icon name="settings" />
                    {configuring ? 'Готово' : 'Настроить блоки'}
                  </button>
                )}
              </div>
              <div className={s.extraGrid}>
                {currentExtras.map((block, index) => (
                  <article
                    key={block.id}
                    className={s.extra}
                    data-kind={block.kind}
                    data-wide={block.wide}
                    data-testid="additional-block"
                  >
                    <header>
                      <Icon name={block.kind} />
                      <h4>{block.title}</h4>
                    </header>
                    {configuring && (
                      <div className={s.blockControls}>
                        <button
                          className={s.blockControl}
                          disabled={index === 0}
                          aria-label={`Выше: ${block.title}`}
                          onClick={() => moveExtra(index, -1)}
                        >
                          <Icon name="up" />
                        </button>
                        <button
                          className={s.blockControl}
                          disabled={index === currentExtras.length - 1}
                          aria-label={`Ниже: ${block.title}`}
                          onClick={() => moveExtra(index, 1)}
                        >
                          <Icon name="down" />
                        </button>
                        <button
                          className={s.blockControl}
                          aria-pressed={block.wide}
                          onClick={() =>
                            updateExtras(
                              currentExtras.map((item) =>
                                item.id === block.id ? { ...item, wide: !item.wide } : item,
                              ),
                            )
                          }
                        >
                          На всю ширину
                        </button>
                        <button
                          className={s.blockControl}
                          aria-label={`Удалить: ${block.title}`}
                          onClick={() =>
                            updateExtras(currentExtras.filter((item) => item.id !== block.id))
                          }
                        >
                          <Icon name="remove" />
                        </button>
                      </div>
                    )}
                    <div className={s.extraBody}>{extraBody(block)}</div>
                  </article>
                ))}
              </div>
              <button
                className={s.addBlock}
                onClick={() => setBlockDraft(newExtra())}
                disabled={currentExtras.length >= 20}
              >
                <Icon name="plus" />
                <strong>Добавить свой блок</strong>
                <span>Список, контакты или заезды</span>
                <img src={plant} alt="" />
              </button>
              <p className={s.notice} role="status">
                {notice ||
                  'Демонстрационные данные. Изменения сохраняются в макете до обновления страницы.'}
              </p>
            </div>
          </div>
        </div>
      </main>
      {personDialog && (
        <Modal
          title="Сотрудник"
          testId="personnel-preview-person"
          onClose={() => setPersonDialog(null)}
        >
          <Profile person={personDialog} />
        </Modal>
      )}
      {arrivalDraft && (
        <Modal
          title={arrivalDraft.id ? 'Изменить заезд' : 'Добавить заезд'}
          testId="personnel-preview-arrival"
          onClose={() => setArrivalDraft(null)}
        >
          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              const value = {
                ...arrivalDraft,
                id: arrivalDraft.id || Math.max(0, ...arrivals.map((p) => p.id)) + 1,
              };
              setArrivals((old) =>
                arrivalDraft.id ? old.map((p) => (p.id === value.id ? value : p)) : [...old, value],
              );
              setArrivalDraft(null);
              setNotice('Заезд сохранён в тестовом макете');
            }}
          >
            <label>
              Общежитие
              <select
                value={arrivalDraft.dorm}
                onChange={(event) => setArrivalDraft({ ...arrivalDraft, dorm: event.target.value })}
              >
                {dorms.map((location) => (
                  <option key={location}>{location}</option>
                ))}
              </select>
            </label>
            <label>
              Дата
              <input
                required
                type="date"
                value={arrivalDraft.date}
                onChange={(event) => setArrivalDraft({ ...arrivalDraft, date: event.target.value })}
              />
            </label>
            <label>
              Количество человек
              <input
                required
                type="number"
                min="1"
                max="1000"
                value={arrivalDraft.count}
                onChange={(event) =>
                  setArrivalDraft({ ...arrivalDraft, count: Number(event.target.value) })
                }
              />
            </label>
            <label>
              ФИО, если известны
              <textarea
                value={arrivalDraft.names}
                onChange={(event) =>
                  setArrivalDraft({ ...arrivalDraft, names: event.target.value })
                }
              />
            </label>
            <button className="btn btn--primary" type="submit">
              Сохранить в макете
            </button>
            {arrivalDraft.id > 0 && (
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => {
                  setArrivals((old) => old.filter((p) => p.id !== arrivalDraft.id));
                  setArrivalDraft(null);
                }}
              >
                Удалить заезд из макета
              </button>
            )}
          </form>
        </Modal>
      )}
      {blockDraft && (
        <Modal
          title="Добавить блок"
          testId="personnel-preview-extra"
          onClose={() => setBlockDraft(null)}
        >
          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (currentExtras.length < 20)
                updateExtras([
                  ...currentExtras,
                  { ...blockDraft, title: blockDraft.title.trim() || extraNames[blockDraft.kind] },
                ]);
              setBlockDraft(null);
              setNotice('Блок добавлен. Его оформление меняется вместе с выбранным вариантом.');
            }}
          >
            <label>
              Тип блока
              <select
                value={blockDraft.kind}
                onChange={(event) => {
                  const kind = event.target.value as ExtraKind;
                  setBlockDraft({ ...blockDraft, kind, title: extraNames[kind] });
                }}
              >
                {Object.entries(extraNames).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Название
              <input
                required
                maxLength={100}
                value={blockDraft.title}
                onChange={(event) => setBlockDraft({ ...blockDraft, title: event.target.value })}
              />
            </label>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={blockDraft.wide}
                onChange={(event) => setBlockDraft({ ...blockDraft, wide: event.target.checked })}
              />
              На всю ширину
            </label>
            <button className="btn btn--primary" type="submit">
              Добавить в макет
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
