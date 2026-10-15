import { useState } from 'react';
import type { FormEvent } from 'react';
import { personnelApi } from '../../api/personnel';
import type { ArrivalPlan, PersonnelData } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import type { Mutate } from './Forms';
import { addDays, dateLabel, message } from './helpers';
import s from './Personnel.module.css';
import p from './ArrivalPlanningBoard.module.css';
import f from './PersonnelFocus.module.css';

type Draft = { dormitory_id: number; date: string; plan?: ArrivalPlan };

export function ArrivalPlanningBoard({
  data,
  dormitory,
  mutate,
}: {
  data: PersonnelData;
  dormitory: number | null;
  mutate: Mutate;
}): JSX.Element {
  const [start, setStart] = useState(data.today);
  const [selectedDate, setSelectedDate] = useState(data.today);
  const [draft, setDraft] = useState<Draft | null>(null);
  const dormitories = data.dormitories.filter(
    (item) => !item.is_archived && (dormitory == null || item.id === dormitory),
  );
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const allowed = new Set(dormitories.map((item) => item.id));
  const plans = data.arrival_plans.filter(
    (plan) => allowed.has(plan.dormitory_id) && plan.date >= start && plan.date <= days[6],
  );
  const cells = new Map(plans.map((plan) => [`${plan.dormitory_id}:${plan.date}`, plan]));
  const total = plans.reduce((sum, plan) => sum + plan.count, 0);
  const activeDay = days.includes(selectedDate) ? selectedDate : start;
  const dayPlans = plans.filter((plan) => plan.date === activeDay);
  const dayTotal = dayPlans.reduce((sum, plan) => sum + plan.count, 0);
  return (
    <section className={f.planning} data-testid="personnel-planning">
      <div className={s.toolbar}>
        <div>
          <h2>План заездов</h2>
          <p className={s.hint}>Укажите количество приезжающих и, если известны, их ФИО.</p>
        </div>
        <button
          className="btn btn--primary btn--compact"
          disabled={!dormitories.length}
          onClick={() => setDraft({ dormitory_id: dormitories[0].id, date: activeDay })}
        >
          Добавить заезд
        </button>
      </div>
      <div className={s.toolbar}>
        <div className={s.actions}>
          <button aria-label="Предыдущие 7 дней" onClick={() => setStart(addDays(start, -7))}>
            ←
          </button>
          <label className={p.period}>
            С даты
            <input
              aria-label="Начало периода плана"
              type="date"
              value={start}
              onChange={(event) => {
                if (event.target.value) setStart(event.target.value);
              }}
            />
          </label>
          <span>по {dateLabel(days[6], true)}</span>
          <button aria-label="Следующие 7 дней" onClick={() => setStart(addDays(start, 7))}>
            →
          </button>
          <button
            onClick={() => {
              setStart(data.today);
              setSelectedDate(data.today);
            }}
          >
            Сегодня
          </button>
        </div>
        <strong>Ожидается за период: {total} чел.</strong>
      </div>
      {dormitories.length ? (
        <div className={f.focusLayout}>
          <div className={f.days} role="group" aria-label="Даты заездов">
            {days.map((day) => {
              const arrivals = plans.filter((plan) => plan.date === day);
              const count = arrivals.reduce((sum, plan) => sum + plan.count, 0);
              const weekday = new Intl.DateTimeFormat('ru-RU', {
                weekday: 'long',
                timeZone: 'UTC',
              }).format(new Date(`${day}T00:00:00Z`));
              return (
                <button
                  type="button"
                  key={day}
                  className={f.dayChoice}
                  aria-label={`Выбрать дату: ${day}`}
                  aria-pressed={activeDay === day}
                  onClick={() => setSelectedDate(day)}
                >
                  <span className={f.dateTile}>
                    <b>{Number(day.slice(8))}</b>
                    <small>
                      {new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' }).format(
                        new Date(`${day}T00:00:00Z`),
                      )}
                    </small>
                  </span>
                  <span>
                    <strong>
                      {weekday}
                      {day === data.today ? ' · сегодня' : ''}
                    </strong>
                    <small>
                      {arrivals.length
                        ? arrivals
                            .map(
                              (plan) =>
                                dormitories.find((item) => item.id === plan.dormitory_id)?.name,
                            )
                            .join(' · ')
                        : 'Заезды не запланированы'}
                    </small>
                  </span>
                  <b>{count ? `${count} чел.` : '—'}</b>
                </button>
              );
            })}
          </div>
          <aside className={f.dayDetail} aria-label="Заезды на выбранную дату">
            <span className={f.kicker}>ВЫБРАННЫЙ ДЕНЬ</span>
            <h3>{dateLabel(activeDay, true)}</h3>
            <div className={f.daySummary}>
              <strong>{dayTotal}</strong>
              <span>
                человек ожидается
                <br />
                {dayPlans.length
                  ? `Общежитий: ${dayPlans.length}`
                  : 'Добавьте первый заезд на эту дату'}
              </span>
            </div>
            {dormitories.map((item) => {
              const plan = cells.get(`${item.id}:${activeDay}`);
              return (
                <article key={item.id} className={plan ? f.arrival : f.emptyArrival}>
                  <div className={f.arrivalHead}>
                    <h4>{item.name}</h4>
                    {plan && <b>{plan.count} чел.</b>}
                  </div>
                  {plan ? (
                    <>
                      {plan.names.length ? (
                        <ul>
                          {plan.names.slice(0, 5).map((name, index) => (
                            <li key={index}>{name}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>ФИО не указаны</p>
                      )}
                      {plan.names.length > 5 && (
                        <p>Ещё {plan.names.length - 5} — в записи заезда</p>
                      )}
                      {plan.count > plan.names.length && plan.names.length > 0 && (
                        <p>Без ФИО: {plan.count - plan.names.length} чел.</p>
                      )}
                    </>
                  ) : (
                    <p>Заезд пока не запланирован</p>
                  )}
                  <button
                    type="button"
                    className={`btn btn--outline btn--compact ${f.arrivalAction}`}
                    aria-label={`${plan ? 'Изменить' : 'Добавить'} заезд: ${item.name}, ${activeDay}`}
                    onClick={() => setDraft({ dormitory_id: item.id, date: activeDay, plan })}
                  >
                    {plan ? 'Изменить заезд' : '+ Добавить заезд'}
                  </button>
                </article>
              );
            })}
          </aside>
        </div>
      ) : (
        <p className={s.empty}>Нет действующих общежитий для планирования заездов.</p>
      )}
      <p className={s.hint}>
        Выберите дату, чтобы заполнить или изменить план. Данные доступны в «Общем отчёте» как
        источник «План заездов».
      </p>
      {draft && (
        <ArrivalDialog
          draft={draft}
          dormitories={dormitories}
          mutate={mutate}
          onClose={() => setDraft(null)}
          onSaved={(day) => {
            setSelectedDate(day);
            if (day < start || day > days[6]) setStart(day);
            setDraft(null);
          }}
        />
      )}
    </section>
  );
}

function ArrivalDialog({
  draft,
  dormitories,
  mutate,
  onClose,
  onSaved,
}: {
  draft: Draft;
  dormitories: PersonnelData['dormitories'];
  mutate: Mutate;
  onClose: () => void;
  onSaved: (day: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const plan = draft.plan;
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const values = {
      dormitory_id: Number(fields.get('dormitory_id')),
      date: String(fields.get('date')),
      count: Number(fields.get('count')),
      names: String(fields.get('names'))
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean),
    };
    if (values.names.length > values.count) {
      setError('Количество ФИО не должно превышать количество приезжающих.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await mutate(() =>
        plan
          ? personnelApi.updateArrival(plan.id, { ...values, revision: plan.revision })
          : personnelApi.createArrival(values),
      );
      onSaved(values.date);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  async function remove(): Promise<void> {
    if (!plan || busy) return;
    setBusy(true);
    setError('');
    try {
      await mutate(() => personnelApi.deleteArrival(plan.id, plan.revision));
      onClose();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={plan ? 'Изменить заезд' : 'Добавить заезд'}
      testId="arrival-dialog"
      onClose={onClose}
      closeDisabled={busy}
      panelClassName={s.modal}
    >
      <form className={s.form} onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className={p.fields}>
          <label>
            Общежитие
            <select name="dormitory_id" defaultValue={draft.dormitory_id} required>
              {dormitories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className={s.formGrid}>
            <label>
              Дата заезда
              <input name="date" type="date" defaultValue={draft.date} required />
            </label>
            <label>
              Количество человек
              <input
                name="count"
                type="number"
                min={1}
                max={10000}
                step={1}
                defaultValue={plan?.count ?? 1}
                required
              />
            </label>
          </div>
          <label>
            ФИО (необязательно)
            <textarea
              name="names"
              rows={6}
              defaultValue={plan?.names.join('\n') ?? ''}
              placeholder="Каждое ФИО с новой строки"
            />
          </label>
          <p className={s.hint}>
            Количество укажите вручную. ФИО можно заполнить для части приезжающих или оставить
            пустыми.
          </p>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.actions}>
            <button className={s.primary} type="submit">
              {busy ? 'Сохраняем…' : 'Сохранить заезд'}
            </button>
            <button type="button" onClick={onClose}>
              Отмена
            </button>
            {plan && !deleting && (
              <button type="button" onClick={() => setDeleting(true)}>
                Удалить заезд
              </button>
            )}
          </div>
          {deleting && (
            <div className={s.notice}>
              <p>Удалить этот заезд? Его количество перестанет учитываться в отчёте.</p>
              <div className={s.actions}>
                <button type="button" onClick={() => void remove()}>
                  Да, удалить
                </button>
                <button type="button" onClick={() => setDeleting(false)}>
                  Оставить запись
                </button>
              </div>
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
