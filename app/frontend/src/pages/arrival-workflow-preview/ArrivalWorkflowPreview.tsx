import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import house from '../../assets/dorm-house.svg';
import { Modal, ModalCancelButton } from '../../components/Modal';
import type { Field, Settings } from '../../workspace/personnel/arrivals/data';
import { isEmpty } from '../../workspace/personnel/arrivals/data';
import { SettingsDialog } from '../../workspace/personnel/arrivals/SettingsDialog';
import { addDays, dateLabel } from '../../workspace/personnel/helpers';
import { PersonnelBlockIcon as Icon } from '../../workspace/personnel/PersonnelBlockIcon';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import base from '../arrival-settings-preview/ArrivalSettingsPreview.module.css';
import {
  asArrival,
  counts,
  DORMITORIES,
  initialWorkflow,
  markVisit,
  moveVisit,
  TODAY,
  validDate,
  workflowSettings,
} from './model';
import type { PlannedArrival, PlannedPerson } from './model';
import { FilledFields, PersonRow } from './PersonRow';
import type { OnPersonAction } from './PersonRow';
import { MoveDialog } from './WorkflowDialogs';
import s from './ArrivalWorkflowPreview.module.css';

type Dialog =
  | { kind: 'move'; arrivalId: string; personId: string }
  | { kind: 'details'; arrivalId: string }
  | { kind: 'settings'; tab: 'fields' | 'display' };
const navigation: { icon: WorkspaceIconName; label: string }[] = [
  { icon: 'overview', label: 'Обзор' },
  { icon: 'house', label: 'Общежития' },
  { icon: 'document', label: 'Документы' },
  { icon: 'people', label: 'Персонал' },
  { icon: 'chart', label: 'Статистика' },
];

export function ArrivalWorkflowPreview(): JSX.Element {
  const [state, setState] = useState(initialWorkflow);
  const [settings, setSettings] = useState(workflowSettings);
  const [retiredFields, setRetiredFields] = useState<Field[]>([]);
  const [dorm, setDorm] = useState('Северное');
  const [start, setStart] = useState(TODAY);
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState('');
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const activeDay = days.includes(selectedDate) ? selectedDate : start;
  const matching = state.arrivals.filter((arrival) => dorm === 'all' || arrival.dorm === dorm);
  const periodPlans = matching.filter(
    (arrival) => arrival.date >= start && arrival.date <= days[6],
  );
  const dayPlans = periodPlans.filter((arrival) => arrival.date === activeDay);
  const periodCounts = counts(periodPlans);
  const dayCounts = counts(dayPlans);
  const allFields = [
    ...settings.fields,
    ...retiredFields.filter((field) => !settings.fields.some((item) => item.id === field.id)),
  ];
  const visibleFields = settings.display.order.flatMap((id) => {
    const field = settings.fields.find((item) => item.id === id);
    return field && settings.display.visible.includes(id) ? [field] : [];
  });
  const personalFields = visibleFields.filter((field) => field.scope === 'person');
  const commonFields = visibleFields.filter((field) => field.scope === 'arrival');
  const currentArrival =
    dialog && 'arrivalId' in dialog
      ? state.arrivals.find((arrival) => arrival.id === dialog.arrivalId)
      : undefined;
  const currentPerson =
    currentArrival && dialog && 'personId' in dialog
      ? currentArrival.people.find((person) => person.id === dialog.personId)
      : undefined;

  useEffect(() => {
    const old = document.title;
    document.title = 'Отметки заезда — тестовая страница — Домовой';
    return () => {
      document.title = old;
    };
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, [dialog]);
  useEffect(() => {
    if (highlight && !dialog)
      document
        .getElementById(`visit-${highlight}`)
        ?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  }, [highlight, dialog, activeDay]);

  function tell(message: string): void {
    setNotice(message);
    setError('');
  }
  const onAction: OnPersonAction = (action, arrival, person) => {
    setError('');
    try {
      if (action === 'details') {
        setDialog({ kind: 'details', arrivalId: arrival.id });
        return;
      }
      if (action === 'move') {
        setDialog({ kind: action, arrivalId: arrival.id, personId: person.id });
        return;
      }
      if (action === 'arrive' || action === 'no_show' || action === 'restore') {
        const status =
          action === 'arrive' ? 'arrived' : action === 'no_show' ? 'no_show' : 'expected';
        setState(markVisit(state, arrival.id, person.id, status));
        tell(
          action === 'arrive'
            ? `${person.name}: прибытие отмечено.`
            : action === 'no_show'
              ? `${person.name}: не приехал. Можно вернуть в ожидаемые или перенести на другой день.`
              : `${person.name} снова ожидается.`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить действие.');
    }
  };
  function saveSettings(next: Settings): void {
    setRetiredFields((old) => [
      ...old,
      ...settings.fields.filter((field) => !next.fields.some((item) => item.id === field.id)),
    ]);
    setSettings(structuredClone(next));
    setDialog(null);
    tell('Отображение обновлено. Все заполненные поля доступны в полной информации.');
  }
  function reset(): void {
    setState(initialWorkflow());
    setSettings(workflowSettings());
    setRetiredFields([]);
    setDorm('Северное');
    setStart(TODAY);
    setSelectedDate(TODAY);
    setDialog(null);
    setHighlight('');
    tell('Пример сброшен. Все люди снова ожидаются.');
  }
  function cardClick(event: MouseEvent<HTMLElement>, arrival: PlannedArrival): void {
    if ((event.target as HTMLElement).closest('button,a,input,select,summary')) return;
    setDialog({ kind: 'details', arrivalId: arrival.id });
  }
  function row(arrival: PlannedArrival, person: PlannedPerson, full = false): JSX.Element {
    return (
      <PersonRow
        key={person.id}
        arrival={arrival}
        person={person}
        fields={full ? allFields : personalFields}
        full={full}
        onAction={onAction}
        hideEmpty={full || settings.display.hideEmpty}
        highlighted={!full && highlight === person.id}
      />
    );
  }

  return (
    <div className={base.page}>
      <div className={base.demoBar}>
        <span>
          <strong>Тестовая страница · этап 2</strong>
          <span className={base.demoDetail}>
            Прибытие, неявка или перенос на другую дату. Данные учебные, изменения действуют до
            обновления страницы.
          </span>
        </span>
        <button type="button" className="btn btn--ghost btn--compact" onClick={reset}>
          Сбросить пример
        </button>
      </div>
      <header className={base.header}>
        <div className={base.brand}>
          <img src={house} alt="" />
          Домовой
        </div>
        <span className={base.headerCaption}>Управление общежитиями</span>
        <span className={base.demoUser}>Демо-организация</span>
      </header>
      <div className={base.shell}>
        <aside className={base.sidebar}>
          <small className={base.sidebarTitle}>ЛИЧНЫЙ КАБИНЕТ</small>
          {navigation.map((item) => (
            <div key={item.label} className={base.navItem} data-active={item.label === 'Персонал'}>
              <WorkspaceIcon name={item.icon} />
              <span>{item.label}</span>
            </div>
          ))}
          <div className={base.sidebarNote}>
            <Icon name="plans" />
            <p>От плана к заселению</p>
            <span>У каждого человека — своя отметка, дата и история.</span>
          </div>
        </aside>
        <main className={base.main}>
          <div className={base.pageHeading}>
            <div>
              <span className={base.breadcrumb}>Личный кабинет / Персонал</span>
              <h1>Персонал</h1>
            </div>
            <label className={base.dormFilter}>
              Общежитие
              <select
                aria-label="Общежитие"
                value={dorm}
                onChange={(event) => setDorm(event.target.value)}
              >
                <option value="all">Все общежития</option>
                {DORMITORIES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
          <div className={base.sectionHeading}>
            <div>
              <h2>План заездов</h2>
              <p className={base.muted}>Отмечайте прибытие, неявку или перенос каждого человека.</p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => setDialog({ kind: 'settings', tab: 'fields' })}
            >
              <Icon name="settings" />
              Поля заезда
            </button>
          </div>
          {notice && (
            <p className={base.notice} role="status" aria-live="polite">
              {notice}
            </p>
          )}
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
          <>
            <div className={base.periodBar}>
              <div className={base.actions}>
                <button
                  type="button"
                  className="btn btn--ghost btn--compact"
                  aria-label="Предыдущие 7 дней"
                  onClick={() => setStart(addDays(start, -7))}
                >
                  ←
                </button>
                <label className={base.dateFilter}>
                  С даты
                  <input
                    type="date"
                    aria-label="Начало периода"
                    value={start}
                    onChange={(event) => {
                      if (validDate(event.target.value)) setStart(event.target.value);
                    }}
                  />
                </label>
                <span>по {dateLabel(days[6], true)}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--compact"
                  aria-label="Следующие 7 дней"
                  onClick={() => setStart(addDays(start, 7))}
                >
                  →
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--compact"
                  onClick={() => {
                    setStart(TODAY);
                    setSelectedDate(TODAY);
                  }}
                >
                  Сегодня
                </button>
              </div>
              <span>
                Ожидаются за период <strong>{periodCounts.expected} чел.</strong>
              </span>
            </div>
            <div className={s.board}>
              <section className={`${base.days} ${s.calendar}`} aria-label="Даты заездов">
                {days.map((day) => {
                  const items = periodPlans.filter((arrival) => arrival.date === day);
                  const totals = counts(items);
                  return (
                    <button
                      type="button"
                      key={day}
                      className={`btn btn--ghost btn--compact ${base.dayChoice}`}
                      aria-pressed={day === activeDay}
                      aria-label={`${dateLabel(day, true)}: ожидаются ${totals.expected}`}
                      onClick={() => {
                        setSelectedDate(day);
                        setHighlight('');
                      }}
                    >
                      <span className={base.dateTile}>
                        <b>{Number(day.slice(-2))}</b>
                        <small>
                          {new Intl.DateTimeFormat('ru-RU', {
                            month: 'short',
                            timeZone: 'UTC',
                          }).format(new Date(`${day}T00:00:00Z`))}
                        </small>
                      </span>
                      <span className={base.dayText}>
                        <strong>
                          {new Intl.DateTimeFormat('ru-RU', {
                            weekday: 'long',
                            timeZone: 'UTC',
                          }).format(new Date(`${day}T00:00:00Z`))}
                          {day === TODAY && <small className={base.today}>Сегодня</small>}
                        </strong>
                        <small>
                          {items.length
                            ? `${items.map((item) => item.dorm).join(' · ')}${totals.arrived ? ` · прибыли ${totals.arrived}` : ''}`
                            : 'Заезды не запланированы'}
                        </small>
                      </span>
                      <span className={s.dayExpected}>
                        <b>{totals.expected || '—'}</b>
                        <small>ожидаются</small>
                      </span>
                    </button>
                  );
                })}
                <p className={base.footnote}>
                  В счётчике — только ожидаемые приезды. Перенесённый человек учитывается в новой
                  дате.
                </p>
                <div className={s.guide}>
                  <strong>Как попробовать</strong>
                  <ol>
                    <li>Отметьте «Прибыл» у любого человека.</li>
                    <li>Нажмите «Изменить статус», чтобы снова выбрать один из трёх вариантов.</li>
                    <li>Другого человека перенесите на 29 октября — там уже есть заезд.</li>
                  </ol>
                </div>
              </section>
              <aside className={base.dayPanel} aria-label="Заезды на выбранную дату">
                <div className={base.panelHeading}>
                  <div>
                    <span className={base.muted}>Выбранный день</span>
                    <h3>{dateLabel(activeDay, true)}</h3>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    onClick={() => setDialog({ kind: 'settings', tab: 'display' })}
                  >
                    <Icon name="settings" />
                    Настроить вид
                  </button>
                </div>
                {settings.display.summary && (
                  <dl className={s.metrics}>
                    <div>
                      <dt>В плане</dt>
                      <dd>
                        {dayPlans.reduce((total, arrival) => total + arrival.people.length, 0)}
                      </dd>
                    </div>
                    <div data-tone="expected">
                      <dt>Ожидаются</dt>
                      <dd>{dayCounts.expected}</dd>
                    </div>
                    <div data-tone="arrived">
                      <dt>Прибыли</dt>
                      <dd>{dayCounts.arrived}</dd>
                    </div>
                    <div>
                      <dt>Не приехали</dt>
                      <dd>{dayCounts.no_show}</dd>
                    </div>
                  </dl>
                )}
                {dayPlans.length === 0 && (
                  <div className={base.emptyArrival}>
                    На этот день заездов нет. Перенесите сюда человека из другой даты.
                  </div>
                )}
                {dayPlans.map((arrival) => (
                  <article
                    key={arrival.id}
                    className={s.arrivalCard}
                    data-compact={settings.display.compact}
                    onClick={(event) => cardClick(event, arrival)}
                  >
                    <div className={s.cardHeading}>
                      <h4>{arrival.dorm}</h4>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setDialog({ kind: 'details', arrivalId: arrival.id })}
                      >
                        Полная информация ↗
                      </button>
                    </div>
                    <FilledFields
                      fields={commonFields}
                      values={arrival.values}
                      hideEmpty={settings.display.hideEmpty}
                    />
                    {settings.display.visible.includes('names') ? (
                      <>
                        <ul className={s.people} aria-label={`Люди: ${arrival.dorm}`}>
                          {arrival.people
                            .slice(0, settings.display.namesLimit)
                            .map((person) => row(arrival, person))}
                        </ul>
                        {arrival.people.length > settings.display.namesLimit && (
                          <button
                            type="button"
                            className={`btn btn--ghost btn--compact ${s.showAll}`}
                            onClick={() => setDialog({ kind: 'details', arrivalId: arrival.id })}
                          >
                            Все люди и отметки · {arrival.people.length}
                          </button>
                        )}
                      </>
                    ) : (
                      <p className={s.subtle}>
                        ФИО скрыты в настройках. Откройте полную информацию, чтобы поставить
                        отметки.
                      </p>
                    )}
                  </article>
                ))}
                {dayCounts.no_show > 0 && (
                  <p className={s.dayFootnote}>Не приехали: {dayCounts.no_show}</p>
                )}
              </aside>
            </div>
          </>
        </main>
      </div>
      {dialog?.kind === 'move' && currentArrival && currentPerson && (
        <MoveDialog
          arrival={currentArrival}
          person={currentPerson}
          onClose={() => setDialog(null)}
          onSave={(date) => {
            const next = moveVisit(state, currentArrival.id, currentPerson.id, date);
            setState(next);
            setDialog(null);
            setHighlight('');
            setNotice('');
          }}
        />
      )}
      {dialog?.kind === 'details' && currentArrival && (
        <Modal
          title={`Заезд · ${currentArrival.dorm} · ${dateLabel(currentArrival.date, true)}`}
          testId="workflow-details-dialog"
          onClose={() => setDialog(null)}
          panelClassName={`${s.dialog} ${s.detailsDialog}`}
          initialFocus="panel"
        >
          <p className={s.subtle}>Все заполненные сведения, включая скрытые в правом блоке.</p>
          <FilledFields
            fields={allFields.filter((field) => field.scope === 'arrival')}
            values={currentArrival.values}
          />
          <ul className={s.people}>
            {currentArrival.people.map((person) => row(currentArrival, person, true))}
          </ul>
          <div className="dialog-actions">
            <ModalCancelButton
              className="btn btn--primary btn--compact"
              onClick={() => setDialog(null)}
            >
              Закрыть
            </ModalCancelButton>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog
          settings={settings}
          initialTab={dialog.tab}
          sample={asArrival(dayPlans[0] ?? state.arrivals[0])}
          onClose={() => setDialog(null)}
          onSave={saveSettings}
          preview
          usedFields={allFields
            .filter((field) =>
              state.arrivals.some(
                (arrival) =>
                  !isEmpty(arrival.values[field.id]) ||
                  arrival.people.some((person) => !isEmpty(person.values[field.id])),
              ),
            )
            .map((field) => field.id)}
        />
      )}
    </div>
  );
}
