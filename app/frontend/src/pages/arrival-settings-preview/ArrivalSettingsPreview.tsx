import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import { PersonnelBlockIcon as Icon } from '../../workspace/personnel/PersonnelBlockIcon';
import { addDays, dateLabel } from '../../workspace/personnel/helpers';
import house from '../../assets/dorm-house.svg';
import { ArrivalCard, FieldControl } from './ArrivalFields';
import { SettingsDialog } from './SettingsDialog';
import { PeopleEditor } from './PeopleEditor';
import { ArrivalDetailsDialog } from './ArrivalDetailsDialog';
import type { Arrival, Field, Settings, Value } from './data';
import {
  DORMITORIES,
  TODAY,
  PEOPLE_PAGE_SIZE,
  hasPersonData,
  initialArrivals,
  initialSettings,
  isEmpty,
  newArrival,
  peopleAtCount,
  personCount,
  reconfigureArrival,
} from './data';
import s from './ArrivalSettingsPreview.module.css';

const navigation: { icon: WorkspaceIconName; label: string }[] = [
  { icon: 'overview', label: 'Обзор' },
  { icon: 'house', label: 'Общежития' },
  { icon: 'document', label: 'Документы' },
  { icon: 'people', label: 'Персонал' },
  { icon: 'chart', label: 'Статистика' },
];
type SettingsTab = 'fields' | 'display';

export function ArrivalSettingsPreview(): JSX.Element {
  const [settings, setSettings] = useState(initialSettings);
  const [arrivals, setArrivals] = useState(initialArrivals);
  const [start, setStart] = useState(TODAY);
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const [dorm, setDorm] = useState('all');
  const [arrivalDraft, setArrivalDraft] = useState<Arrival | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [personPage, setPersonPage] = useState(0);
  const [allowTrim, setAllowTrim] = useState(false);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const activeDay = days.includes(selectedDate) ? selectedDate : start;
  const dorms = dorm === 'all' ? DORMITORIES : [dorm];
  const plans = arrivals.filter(
    (item) => dorms.includes(item.dorm) && item.date >= start && item.date <= days[6],
  );
  const dayPlans = plans.filter((item) => item.date === activeDay);
  const total = plans.reduce((sum, item) => sum + Number(item.count), 0);
  const dayTotal = dayPlans.reduce((sum, item) => sum + Number(item.count), 0);
  const detailedArrival = arrivals.find((arrival) => arrival.id === detailsId);
  const modalOpen = !!arrivalDraft || settingsTab !== null || !!detailedArrival;
  const draftCount = arrivalDraft ? personCount(arrivalDraft.count) : 0;
  const extraPeople =
    arrivalDraft && draftCount
      ? arrivalDraft.people.slice(draftCount).filter(hasPersonData).length
      : 0;
  const personalFields = settings.fields.filter(
    (field) => field.inForm && field.scope === 'person',
  );
  const sharedFields = settings.fields.filter((field) => field.inForm && field.scope === 'arrival');

  useEffect(() => {
    const oldTitle = document.title;
    document.title = 'Настройка плана заездов — тестовая страница — Домовой';
    return () => {
      document.title = oldTitle;
    };
  }, []);
  useEffect(() => {
    if (!modalOpen) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [modalOpen]);

  function openArrival(location = dorms[0]): void {
    const existing = arrivals.find((item) => item.date === activeDay && item.dorm === location);
    setError('');
    setPersonPage(0);
    setAllowTrim(false);
    setArrivalDraft(existing ? structuredClone(existing) : newArrival(location, activeDay));
  }
  function editArrival(arrival: Arrival): void {
    setError('');
    setPersonPage(0);
    setAllowTrim(false);
    setArrivalDraft(structuredClone(arrival));
  }
  function updateDraft(values: Partial<Arrival>): void {
    if (values.count !== undefined) setAllowTrim(false);
    setArrivalDraft((old) => {
      if (!old) return old;
      const count = values.count === undefined ? 0 : personCount(values.count);
      return {
        ...old,
        ...values,
        ...(count > old.people.length ? { people: peopleAtCount(old.people, count) } : {}),
      };
    });
    setError('');
  }
  function saveArrival(event: FormEvent): void {
    event.preventDefault();
    if (!arrivalDraft) return;
    if (!draftCount) {
      setError('Укажите целое количество человек от 1 до 10 000.');
      return;
    }
    if (extraPeople && !allowTrim) {
      setError(
        'Подтвердите удаление заполненных строк за пределами нового количества или увеличьте количество человек.',
      );
      return;
    }
    if (
      arrivals.some(
        (item) =>
          item.id !== arrivalDraft.id &&
          item.date === arrivalDraft.date &&
          item.dorm === arrivalDraft.dorm,
      )
    ) {
      setError(
        'Заезд на эту дату в выбранное общежитие уже есть. Откройте его через «Изменить заезд».',
      );
      return;
    }
    function missing(field: Field, value: Value | undefined): boolean {
      return field.type === 'checkbox'
        ? value !== true
        : isEmpty(value) || (typeof value === 'string' && !value.trim());
    }
    for (let index = 0; index < draftCount; index++) {
      const field = personalFields.find(
        (item) => item.required && missing(item, arrivalDraft.people[index].values[item.id]),
      );
      if (field) {
        setPersonPage(Math.floor(index / PEOPLE_PAGE_SIZE));
        setError(`Заполните поле «${field.label}» у человека № ${index + 1}.`);
        return;
      }
    }
    const saved = {
      ...arrivalDraft,
      values: {
        ...arrivalDraft.values,
        ...Object.fromEntries(
          settings.fields
            .filter(
              (field) => field.inForm && field.scope === 'arrival' && field.type === 'checkbox',
            )
            .map((field) => [field.id, arrivalDraft.values[field.id] === true]),
        ),
      },
      people: arrivalDraft.people.slice(0, draftCount).map((person) => ({
        ...person,
        name: person.name.trim(),
        values: {
          ...person.values,
          ...Object.fromEntries(
            personalFields
              .filter((field) => field.type === 'checkbox')
              .map((field) => [field.id, person.values[field.id] === true]),
          ),
        },
      })),
      id: arrivalDraft.id || crypto.randomUUID(),
    };
    setArrivals((old) => [...old.filter((item) => item.id !== saved.id), saved]);
    setSelectedDate(saved.date);
    if (!days.includes(saved.date)) setStart(saved.date);
    if (!dorms.includes(saved.dorm)) setDorm('all');
    setNotice('Заезд сохранён в макете. Сведения справа обновлены.');
    setArrivalDraft(null);
  }
  function applySettings(next: Settings): void {
    const changed = next.fields
      .filter((field) =>
        settings.fields.some(
          (old) => old.id === field.id && (old.type !== field.type || old.scope !== field.scope),
        ),
      )
      .map((field) => field.id);
    const clean = (item: Arrival): Arrival => reconfigureArrival(item, settings, next);
    if (changed.length) {
      setArrivals((old) => old.map(clean));
      setArrivalDraft((old) => (old ? clean(old) : null));
    }
    setSettings(next);
    setSettingsTab(null);
    setNotice('Настройки применены в макете к добавлению, изменению и правой панели.');
  }
  function reset(): void {
    setDetailsId(null);
    setSettings(initialSettings());
    setArrivals(initialArrivals());
    setStart(TODAY);
    setSelectedDate(TODAY);
    setDorm('all');
    setNotice('Исходный пример восстановлен.');
  }

  return (
    <div className={s.page} data-testid="arrival-settings-preview">
      <div className={s.demoBar}>
        <span>
          <b>Тестовая страница</b>
          <span className={s.demoDetail}>
            Демонстрационные данные. Изменения действуют до обновления страницы.
          </span>
        </span>
        <button className="btn btn--ghost btn--compact" onClick={reset}>
          Сбросить пример
        </button>
      </div>
      <header className={s.header}>
        <div className={s.brand}>
          <img src={house} alt="" />
          <strong>Домовой</strong>
        </div>
        <span className={s.headerCaption}>Управление общежитиями</span>
        <span className={s.demoUser}>Демо-кабинет</span>
      </header>
      <div className={s.shell}>
        <aside className={s.sidebar} aria-label="Контекст кабинета">
          <span className={s.sidebarTitle}>Рабочее пространство</span>
          {navigation.map((item) => (
            <div key={item.label} className={s.navItem} data-active={item.label === 'Персонал'}>
              <WorkspaceIcon name={item.icon} />
              {item.label}
            </div>
          ))}
          <div className={s.sidebarNote}>
            <Icon name="plans" />
            <p>Поля под ваши задачи</p>
            <small>Настройте форму заезда и сведения в карточке выбранного дня.</small>
          </div>
        </aside>
        <main className={s.main}>
          <div className={s.pageHeading}>
            <div>
              <p className={s.breadcrumb}>Рабочее пространство / Персонал</p>
              <h1>Персонал</h1>
            </div>
            <label className={s.dormFilter}>
              Общежитие
              <select value={dorm} onChange={(e) => setDorm(e.target.value)}>
                <option value="all">Все общежития</option>
                {DORMITORIES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
          <nav className={s.tabs} aria-label="Подвкладки персонала">
            <Link to="/preview/personnel-workspace">Рабочая поверхность</Link>
            <Link to="/preview/personnel-tabs?tab=employees&variant=5">Сотрудники</Link>
            <span aria-current="page">План заездов</span>
          </nav>
          <div className={s.sectionHeading}>
            <div>
              <h2>План заездов</h2>
              <p className={s.muted}>Количество, ФИО и дополнительные сведения о приезжающих.</p>
            </div>
            <div className={s.actions}>
              <button
                className="btn btn--ghost btn--compact"
                onClick={() => setSettingsTab('fields')}
              >
                <Icon name="settings" />
                Поля заезда
              </button>
              <button
                className="btn btn--primary btn--compact"
                onClick={() =>
                  editArrival(
                    newArrival(
                      dorms.find((location) => !dayPlans.some((item) => item.dorm === location)) ??
                        dorms[0],
                      activeDay,
                    ),
                  )
                }
              >
                <Icon name="plus" />
                Добавить заезд
              </button>
            </div>
          </div>
          <div className={s.periodBar}>
            <div className={s.actions}>
              <button
                className="btn btn--ghost btn--compact"
                aria-label="Предыдущие 7 дней"
                onClick={() => setStart(addDays(start, -7))}
              >
                ←
              </button>
              <label className={s.dateFilter}>
                С даты
                <input
                  type="date"
                  aria-label="Начало периода"
                  value={start}
                  onChange={(e) => {
                    if (e.target.value) setStart(e.target.value);
                  }}
                />
              </label>
              <span>по {dateLabel(days[6], true)}</span>
              <button
                className="btn btn--ghost btn--compact"
                aria-label="Следующие 7 дней"
                onClick={() => setStart(addDays(start, 7))}
              >
                →
              </button>
              <button
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
              За период <strong>{total} чел.</strong>
            </span>
          </div>
          {notice && (
            <p role="status" className={s.notice}>
              {notice}
            </p>
          )}
          <div className={s.board}>
            <section className={s.days} aria-label="Даты заездов">
              {days.map((day) => {
                const items = plans.filter((item) => item.date === day);
                const count = items.reduce((sum, item) => sum + Number(item.count), 0);
                return (
                  <button
                    className={`btn btn--ghost btn--compact ${s.dayChoice}`}
                    key={day}
                    aria-pressed={day === activeDay}
                    onClick={() => setSelectedDate(day)}
                  >
                    <span className={s.dateTile}>
                      <b>{Number(day.slice(-2))}</b>
                      <small>
                        {new Intl.DateTimeFormat('ru-RU', {
                          month: 'short',
                          timeZone: 'UTC',
                        }).format(new Date(`${day}T00:00:00Z`))}
                      </small>
                    </span>
                    <span className={s.dayText}>
                      <strong>
                        {new Intl.DateTimeFormat('ru-RU', {
                          weekday: 'long',
                          timeZone: 'UTC',
                        }).format(new Date(`${day}T00:00:00Z`))}
                        {day === TODAY && <small className={s.today}>Сегодня</small>}
                      </strong>
                      <small>
                        {items.length
                          ? items.map((item) => item.dorm).join(' · ')
                          : 'Заезды не запланированы'}
                      </small>
                    </span>
                    <b className={s.dayCount}>{count ? `${count} чел.` : '—'}</b>
                  </button>
                );
              })}
              <p className={s.footnote}>
                Выберите день, чтобы посмотреть заезды и дополнительные сведения справа.
              </p>
            </section>
            <aside className={s.dayPanel} aria-label="Заезды на выбранную дату">
              <div className={s.panelHeading}>
                <div>
                  <span className={s.muted}>Выбранный день</span>
                  <h3>{dateLabel(activeDay, true)}</h3>
                </div>
                <button
                  className="btn btn--ghost btn--compact"
                  onClick={() => setSettingsTab('display')}
                >
                  <Icon name="settings" />
                  Настроить вид
                </button>
              </div>
              {settings.display.summary && (
                <div className={s.daySummary}>
                  <strong>{dayTotal}</strong>
                  <span>
                    человек ожидается
                    <small>
                      {dayPlans.length
                        ? `Общежитий с заездами: ${dayPlans.length}`
                        : 'Добавьте первый заезд на эту дату'}
                    </small>
                  </span>
                </div>
              )}
              {dorms.map((location) => {
                const arrival = dayPlans.find((item) => item.dorm === location);
                return arrival ? (
                  <ArrivalCard
                    key={location}
                    arrival={arrival}
                    settings={settings}
                    onOpen={() => setDetailsId(arrival.id)}
                    onEdit={() => editArrival(arrival)}
                  />
                ) : (
                  <div key={location} className={s.emptyArrival}>
                    <div>
                      <strong>{location}</strong>
                      <small>Заезд не запланирован</small>
                    </div>
                    <button
                      className="btn btn--ghost btn--compact"
                      onClick={() => openArrival(location)}
                    >
                      <Icon name="plus" />
                      Добавить заезд
                    </button>
                  </div>
                );
              })}
            </aside>
          </div>
          <p className={s.demoHint}>
            <Icon name="settings" />
            <span>
              В «Поля заезда» выберите размещение «Напротив каждого ФИО», чтобы заполнять поле
              отдельно у каждого человека. Например, одному укажите 15 смен, другому — 30.
            </span>
          </p>
        </main>
      </div>
      {arrivalDraft && settingsTab === null && (
        <Modal
          title={arrivalDraft.id ? 'Изменить заезд' : 'Добавить заезд'}
          testId="preview-arrival-dialog"
          onClose={() => setArrivalDraft(null)}
          panelClassName={`${s.dialog} ${s.arrivalDialog}`}
        >
          <form onSubmit={saveArrival}>
            <div className={s.formIntro}>
              <span>Заполните сведения о заезде.</span>
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                onClick={() => setSettingsTab('fields')}
              >
                <Icon name="settings" />
                Настроить поля
              </button>
            </div>
            <div className={s.formFields}>
              <div className={s.arrivalCore}>
                <label className={s.inputField}>
                  Общежитие{' '}
                  <select
                    required
                    value={arrivalDraft.dorm}
                    onChange={(e) => updateDraft({ dorm: e.target.value })}
                  >
                    {DORMITORIES.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className={s.inputField}>
                  Дата заезда
                  <input
                    type="date"
                    required
                    value={arrivalDraft.date}
                    onChange={(e) => updateDraft({ date: e.target.value })}
                  />
                </label>
                <label className={s.inputField}>
                  Количество человек
                  <input
                    type="number"
                    required
                    min={1}
                    max={10000}
                    step={1}
                    value={arrivalDraft.count}
                    onChange={(e) => updateDraft({ count: e.target.value })}
                  />
                </label>
              </div>
              <PeopleEditor
                people={arrivalDraft.people}
                count={draftCount}
                fields={personalFields}
                page={personPage}
                onPage={setPersonPage}
                onChange={(index, person) =>
                  updateDraft({
                    people: arrivalDraft.people.map((old, i) => (i === index ? person : old)),
                  })
                }
              />
              {extraPeople > 0 && (
                <div className={s.trimNotice}>
                  <p>
                    Количество уменьшено. За пределами списка осталось заполненных строк:{' '}
                    {extraPeople}. При увеличении количества они снова появятся.
                  </p>
                  <label className={s.checkField}>
                    <input
                      type="checkbox"
                      checked={allowTrim}
                      onChange={(e) => setAllowTrim(e.target.checked)}
                    />
                    Убрать эти строки при сохранении заезда
                  </label>
                </div>
              )}
              {sharedFields.length > 0 && (
                <div className={s.extraFieldsHeading}>
                  <h3>Общие сведения о заезде</h3>
                  <span className={s.muted}>Заполняются один раз для всей группы</span>
                </div>
              )}
              <div className={s.customFields}>
                {sharedFields.map((field) => (
                  <div key={field.id} data-wide={field.type === 'textarea'}>
                    <FieldControl
                      field={field}
                      value={arrivalDraft.values[field.id]}
                      onChange={(value) =>
                        updateDraft({ values: { ...arrivalDraft.values, [field.id]: value } })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
            <div className={`dialog-actions ${s.dialogActions}`}>
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                onClick={() => setArrivalDraft(null)}
              >
                Отмена
              </button>
              <button type="submit" className="btn btn--primary btn--compact">
                Сохранить в макете
              </button>
            </div>
            <p className={s.previewNote}>
              Это тестовая запись. Данные рабочего кабинета не меняются.
            </p>
          </form>
        </Modal>
      )}
      {detailedArrival && !arrivalDraft && settingsTab === null && (
        <ArrivalDetailsDialog
          arrival={detailedArrival}
          fields={settings.fields}
          onClose={() => setDetailsId(null)}
          onEdit={() => editArrival(detailedArrival)}
        />
      )}
      {settingsTab !== null && (
        <SettingsDialog
          settings={settings}
          initialTab={settingsTab}
          sample={arrivalDraft ?? dayPlans[0] ?? arrivals[0]}
          onClose={() => setSettingsTab(null)}
          onSave={applySettings}
        />
      )}
    </div>
  );
}
