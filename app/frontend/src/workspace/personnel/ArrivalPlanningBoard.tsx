import { useState } from 'react';
import type { FormEvent } from 'react';
import { personnelApi } from '../../api/personnel';
import type { ArrivalPlan, PersonnelData } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import type { Mutate } from './Forms';
import { addDays, dateLabel, message } from './helpers';
import s from './Personnel.module.css';
import p from './ArrivalPlanningBoard.module.css';

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
  return (
    <section className={s.board} data-testid="personnel-planning">
      <div className={s.toolbar}>
        <div>
          <h2>План заездов</h2>
          <p className={s.hint}>Укажите количество приезжающих и, если известны, их ФИО.</p>
        </div>
        <button
          className={s.primary}
          disabled={!dormitories.length}
          onClick={() => setDraft({ dormitory_id: dormitories[0].id, date: start })}
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
          <button onClick={() => setStart(data.today)}>Сегодня</button>
        </div>
        <strong>Ожидается за период: {total} чел.</strong>
      </div>
      {dormitories.length ? (
        <div className={p.scroll}>
          <table className={p.table}>
            <caption className={p.caption}>Количество приезжающих по общежитиям и датам</caption>
            <thead>
              <tr>
                <th scope="col">Общежитие</th>
                {days.map((day) => (
                  <th scope="col" key={day} data-today={day === data.today}>
                    {dateLabel(day)}
                    <small>
                      {new Intl.DateTimeFormat('ru-RU', {
                        weekday: 'short',
                        timeZone: 'UTC',
                      }).format(new Date(`${day}T00:00:00Z`))}
                    </small>
                  </th>
                ))}
                <th scope="col">Всего</th>
              </tr>
            </thead>
            <tbody>
              {dormitories.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    {item.name}
                    <small>{item.client_name}</small>
                  </th>
                  {days.map((day) => {
                    const plan = cells.get(`${item.id}:${day}`);
                    return (
                      <td key={day} data-today={day === data.today}>
                        <button
                          className={p.cell}
                          data-filled={!!plan}
                          aria-label={`${plan ? 'Изменить' : 'Добавить'} заезд: ${item.name}, ${day}`}
                          onClick={() => setDraft({ dormitory_id: item.id, date: day, plan })}
                        >
                          <strong>{plan ? `${plan.count} чел.` : '+'}</strong>
                          {plan &&
                            (plan.names.length ? (
                              <small>
                                {plan.names.slice(0, 2).join(', ')}
                                {plan.names.length > 2 ? ` · ещё ${plan.names.length - 2}` : ''}
                              </small>
                            ) : (
                              <small>ФИО не указаны</small>
                            ))}
                        </button>
                      </td>
                    );
                  })}
                  <td className={p.total}>
                    {plans
                      .filter((plan) => plan.dormitory_id === item.id)
                      .reduce((sum, plan) => sum + plan.count, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Всего людей</th>
                {days.map((day) => (
                  <td key={day}>
                    {plans
                      .filter((plan) => plan.date === day)
                      .reduce((sum, plan) => sum + plan.count, 0)}
                  </td>
                ))}
                <td>{total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className={s.empty}>Нет действующих общежитий для планирования заездов.</p>
      )}
      <p className={s.hint}>
        Нажмите на дату в строке общежития, чтобы заполнить или изменить план. Данные доступны в
        «Общем отчёте» как источник «План заездов».
      </p>
      {draft && (
        <ArrivalDialog
          draft={draft}
          dormitories={dormitories}
          mutate={mutate}
          onClose={() => setDraft(null)}
          onSaved={(day) => {
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
