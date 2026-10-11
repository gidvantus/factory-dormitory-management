import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { TODAY, dateLabel, dayDiff, dormitories, dormName, people as originalPeople } from './data';
import type { Block, Person } from './data';
import {
  addDays,
  assignees,
  decisionNames,
  listNames,
  matches,
  MY_NAME,
  selectSavedList,
  usePersonnelOperations,
} from './operations';
import type { Decision, Plan, ProfileTab, SavedList, Task, WorkspaceView } from './operations';
import styles from './PersonnelDesignPreview.module.css';
import ops from './Operations.module.css';

type OpenPerson = (person: Person, tab?: ProfileTab) => void;
const weekday = (date: string): string =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );

export function FavoriteButton({ person }: { person: Person }): JSX.Element {
  const { state, toggleFavorite } = usePersonnelOperations();
  const active = state.favorites.includes(person.id);
  return (
    <button
      className={ops.favorite}
      aria-label={`${active ? 'Убрать из моих сотрудников' : 'Добавить в мои сотрудники'}: ${person.name}`}
      aria-pressed={active}
      onClick={() => toggleFavorite(person.id)}
      title={active ? 'В моих сотрудниках' : 'Добавить в мои сотрудники'}
    >
      {active ? '★' : '☆'}
    </button>
  );
}
export function DecisionBadge({ personId }: { personId: string }): JSX.Element {
  const { state } = usePersonnelOperations();
  const decision = state.decisions[personId];
  return (
    <span
      className={`${styles.badge} ${decision?.status === 'extend' ? styles.green : decision?.status === 'departure' ? styles.peach : styles.sand}`}
    >
      {decisionNames[decision?.status ?? 'waiting']}
    </span>
  );
}
export function DecisionCard({ person }: { person: Person }): JSX.Element {
  const { state, saveDecision } = usePersonnelOperations();
  const current = state.decisions[person.id] ?? {
    status: 'waiting' as const,
    date: '',
    comment: '',
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Decision>(current);
  const originalEnd = originalPeople.find((p) => p.id === person.id)?.end;
  const minExtend = originalEnd && originalEnd >= TODAY ? addDays(originalEnd, 1) : TODAY;
  if (!person.current)
    return (
      <section className={ops.softCard}>
        <h4>Подготовка возвращения</h4>
        <p>Следующую вахту можно запланировать во вкладке «Следующая вахта».</p>
      </section>
    );
  return (
    <section className={ops.decisionCard}>
      <div className={styles.sectionHeading}>
        <h4>Решение по окончанию вахты</h4>
        <DecisionBadge personId={person.id} />
      </div>
      {!editing ? (
        <>
          <p>
            {current.status === 'extend'
              ? `Вахта продлена до ${dateLabel(current.date, true)}`
              : current.status === 'departure'
                ? `Выезд запланирован на ${dateLabel(current.date, true)}`
                : 'Свяжитесь с сотрудником и уточните выезд или продление.'}
          </p>
          {current.comment && <small>{current.comment}</small>}
          <button
            className={styles.textButton}
            onClick={() => {
              setDraft(current);
              setEditing(true);
            }}
          >
            Изменить решение →
          </button>
        </>
      ) : (
        <form
          className={ops.form}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            saveDecision(person, {
              ...draft,
              date: draft.status === 'waiting' ? '' : String(form.get('decisionDate')),
            });
            setEditing(false);
          }}
        >
          <label className={styles.field}>
            Решение
            <select
              value={draft.status}
              onChange={(event) => {
                const status = event.target.value as Decision['status'];
                setDraft({
                  ...draft,
                  status,
                  date:
                    status === 'extend'
                      ? addDays(minExtend, 13)
                      : status === 'departure'
                        ? person.end && person.end >= TODAY
                          ? person.end
                          : TODAY
                        : '',
                });
              }}
            >
              {Object.entries(decisionNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {draft.status !== 'waiting' && (
            <label className={styles.field}>
              {draft.status === 'extend' ? 'Новая дата окончания' : 'Дата выезда'}
              <input
                type="date"
                name="decisionDate"
                required
                min={draft.status === 'extend' ? minExtend : TODAY}
                value={draft.date}
                onChange={(event) => setDraft({ ...draft, date: event.target.value })}
              />
            </label>
          )}
          <label className={styles.field}>
            Комментарий
            <textarea
              maxLength={1000}
              value={draft.comment}
              placeholder="Что согласовано с сотрудником"
              onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
            />
          </label>
          <p className={ops.hint}>
            {draft.status === 'extend'
              ? 'Согласованная дата обновит период текущей вахты и списки ближайших окончаний.'
              : draft.status === 'departure'
                ? 'Выезд появится в плане. Фактическое проживание продолжается до оформления оттока.'
                : 'Задачу на уточнение можно добавить во вкладке «Задачи и заметки».'}
          </p>
          <div className={ops.actions}>
            <button className={styles.secondary} type="button" onClick={() => setEditing(false)}>
              Отмена
            </button>
            <button className={styles.primary}>Сохранить решение</button>
          </div>
        </form>
      )}
    </section>
  );
}

function TaskForm({ personId, onDone }: { personId?: string; onDone?: () => void }): JSX.Element {
  const { people, addTask } = usePersonnelOperations();
  const [employee, setEmployee] = useState(personId ?? people[0].id);
  const [text, setText] = useState('');
  const [due, setDue] = useState(TODAY);
  const [assignee, setAssignee] = useState(MY_NAME);
  return (
    <form
      className={ops.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        const form = new FormData(event.currentTarget);
        addTask({ personId: employee, text: text.trim(), due: String(form.get('due')), assignee });
        setText('');
        onDone?.();
      }}
    >
      {!personId && (
        <label className={styles.field}>
          Сотрудник
          <select value={employee} onChange={(event) => setEmployee(event.target.value)}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.number}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={styles.field}>
        Что нужно сделать
        <input
          required
          maxLength={300}
          value={text}
          placeholder="Например, уточнить дату выезда"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className={ops.formRow}>
        <label className={styles.field}>
          Срок
          <input
            type="date"
            name="due"
            required
            min={TODAY}
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          Ответственный
          <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            {assignees.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>
      <button className={styles.primary} disabled={!text.trim()}>
        Добавить задачу
      </button>
    </form>
  );
}
function TaskItem({ task, onPerson }: { task: Task; onPerson?: OpenPerson }): JSX.Element {
  const { people, toggleTask } = usePersonnelOperations();
  const person = people.find((p) => p.id === task.personId)!;
  return (
    <div className={ops.taskRow} data-done={task.done}>
      <input
        type="checkbox"
        checked={task.done}
        aria-label={`${task.done ? 'Вернуть в работу' : 'Выполнить задачу'}: ${task.text}`}
        onChange={() => toggleTask(task.id)}
      />
      <div>
        <strong>{task.text}</strong>
        <div className={ops.taskMeta}>
          {onPerson && (
            <button onClick={() => onPerson(person, 'work')}>
              {person.name.split(' ').slice(0, 2).join(' ')}
            </button>
          )}
          <span>{task.assignee}</span>
          <span className={task.due < TODAY && !task.done ? ops.danger : ''}>
            {dateLabel(task.due)}
            {task.due < TODAY && !task.done
              ? ' · просрочено'
              : task.due === TODAY && !task.done
                ? ' · сегодня'
                : ''}
          </span>
        </div>
      </div>
      {task.done && <span className={`${styles.badge} ${styles.green}`}>Выполнена</span>}
    </div>
  );
}
export function PersonWork({ person }: { person: Person }): JSX.Element {
  const { state, addNote } = usePersonnelOperations();
  const [note, setNote] = useState('');
  const [newTask, setNewTask] = useState(false);
  const tasks = state.tasks
    .filter((t) => t.personId === person.id)
    .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due));
  return (
    <div className={styles.profileSections}>
      <section>
        <div className={styles.sectionHeading}>
          <h4>
            Задачи <span className={ops.counter}>{tasks.filter((t) => !t.done).length}</span>
          </h4>
          <button className={styles.textButton} onClick={() => setNewTask(!newTask)}>
            {newTask ? 'Скрыть форму' : '+ Новая задача'}
          </button>
        </div>
        {newTask && (
          <div className={ops.softCard}>
            <TaskForm personId={person.id} onDone={() => setNewTask(false)} />
          </div>
        )}
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} />
        ))}
        {!tasks.length && (
          <p className={ops.hint}>Задач пока нет. Добавьте первое поручение по сотруднику.</p>
        )}
      </section>
      <section>
        <h4>Заметки</h4>
        <form
          className={ops.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!note.trim()) return;
            addNote(person.id, note.trim());
            setNote('');
          }}
        >
          <label className={styles.field}>
            <span className="visually-hidden">Текст заметки</span>
            <textarea
              maxLength={1500}
              rows={3}
              placeholder="Результат разговора, договорённости, важные детали…"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button className={styles.secondary} disabled={!note.trim()}>
            Сохранить заметку
          </button>
        </form>
        <div className={ops.notes}>
          {state.notes
            .filter((n) => n.personId === person.id)
            .map((n) => (
              <article key={n.id}>
                <div>
                  <strong>{n.author}</strong>
                  <time>{dateLabel(n.date, true)}</time>
                </div>
                <p>{n.text}</p>
              </article>
            ))}
        </div>
      </section>
    </div>
  );
}

export function NextShift({ person }: { person: Person }): JSX.Element {
  const { state, savePlan, confirmPlan, removePlan } = usePersonnelOperations();
  const current = state.plans.find((p) => p.personId === person.id && p.kind === 'arrival');
  const [editing, setEditing] = useState(!current);
  const earliest =
    person.current && person.end && person.end >= TODAY ? addDays(person.end, 1) : TODAY;
  const suggested = earliest > addDays(TODAY, 2) ? earliest : addDays(TODAY, 2);
  const makeDraft = (): Plan =>
    current ?? {
      id: `arrival-${person.id}`,
      personId: person.id,
      kind: 'arrival',
      date: suggested,
      end: addDays(suggested, 44),
      dormitoryId: person.dormitoryId,
      confirmed: false,
      comment: '',
    };
  const [draft, setDraft] = useState<Plan>(makeDraft);
  const [error, setError] = useState('');
  return (
    <section className={ops.nextShift}>
      <div className={styles.sectionHeading}>
        <h4>Следующая вахта</h4>
        {current && (
          <span className={`${styles.badge} ${current.confirmed ? styles.green : styles.sand}`}>
            {current.confirmed ? 'Приезд подтверждён' : 'Ожидаем подтверждение'}
          </span>
        )}
      </div>
      {current && !editing ? (
        <>
          <div className={ops.nextDates}>
            <strong>
              {dateLabel(current.date, true)} — {dateLabel(current.end, true)}
            </strong>
            <span>{dormName(current.dormitoryId)}</span>
          </div>
          {current.comment && <p>{current.comment}</p>}
          <div className={ops.actions}>
            <button className={styles.primary} onClick={() => confirmPlan(current.id)}>
              {current.confirmed ? 'Снять подтверждение' : 'Подтвердить приезд'}
            </button>
            <button
              className={styles.secondary}
              onClick={() => {
                setDraft(makeDraft());
                setEditing(true);
              }}
            >
              Изменить
            </button>
            <button
              className={styles.textButton}
              onClick={() => {
                removePlan(current.id);
                setEditing(true);
              }}
            >
              Отменить план
            </button>
          </div>
        </>
      ) : (
        <form
          className={ops.form}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const date = String(form.get('arrivalDate'));
            const end = String(form.get('shiftEnd'));
            if (date < earliest || end < date) {
              setError(
                'Проверьте даты: следующая вахта должна начинаться после текущей, а окончание — после заезда.',
              );
              return;
            }
            setError('');
            savePlan({ ...draft, date, end });
            setEditing(false);
          }}
        >
          <div className={ops.formRow}>
            <label className={styles.field}>
              Дата заезда
              <input
                type="date"
                name="arrivalDate"
                required
                min={earliest}
                value={draft.date}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    date: event.target.value,
                    end:
                      draft.end < event.target.value ? addDays(event.target.value, 44) : draft.end,
                  })
                }
              />
            </label>
            <label className={styles.field}>
              Окончание вахты
              <input
                type="date"
                name="shiftEnd"
                required
                min={draft.date}
                value={draft.end}
                onChange={(event) => setDraft({ ...draft, end: event.target.value })}
              />
            </label>
          </div>
          {error && (
            <p role="alert" className={ops.hint}>
              {error}
            </p>
          )}
          <label className={styles.field}>
            Планируемое общежитие
            <select
              value={draft.dormitoryId}
              onChange={(event) => setDraft({ ...draft, dormitoryId: event.target.value })}
            >
              {dormitories.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.client}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={draft.confirmed}
              onChange={(event) => setDraft({ ...draft, confirmed: event.target.checked })}
            />
            Сотрудник подтвердил приезд
          </label>
          <label className={styles.field}>
            Детали приезда
            <textarea
              maxLength={1000}
              value={draft.comment}
              placeholder="Билет, время прибытия, договорённости"
              onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
            />
          </label>
          <p className={ops.hint}>
            Заезд появится в календаре и списке «Ожидают заезда». Текущее проживание изменится после
            фактического заселения.
          </p>
          <div className={ops.actions}>
            {current && (
              <button type="button" className={styles.secondary} onClick={() => setEditing(false)}>
                Отмена
              </button>
            )}
            <button className={styles.primary}>Сохранить следующую вахту</button>
          </div>
        </form>
      )}
    </section>
  );
}

export function PlanningBoard({
  dormitory,
  onPerson,
}: {
  dormitory: string;
  onPerson: OpenPerson;
}): JSX.Element {
  const { state, people, confirmPlan } = usePersonnelOperations();
  const [start, setStart] = useState(TODAY);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [kind, setKind] = useState('all');
  const [personId, setPersonId] = useState('person-29');
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const plans = state.plans
    .filter(
      (p) =>
        (dormitory === 'all' || p.dormitoryId === dormitory) &&
        p.date >= start &&
        p.date <= week[6] &&
        (kind === 'all' || p.kind === kind),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const shown = plans.filter((p) => !selectedDate || p.date === selectedDate);
  return (
    <section className={ops.board} data-testid="personnel-planning">
      <div className={ops.boardHeading}>
        <div>
          <span className={styles.eyebrow}>ПЛАНИРОВАНИЕ</span>
          <h2>Заезды и выезды</h2>
          <p>План на неделю помогает заранее подготовить места и связаться с сотрудниками.</p>
        </div>
        <div className={ops.actions}>
          <button
            className={styles.secondary}
            aria-label="Предыдущая неделя"
            onClick={() => {
              setStart(addDays(start, -7));
              setSelectedDate(null);
            }}
          >
            ←
          </button>
          <strong>
            {dateLabel(start)} — {dateLabel(week[6])}
          </strong>
          <button
            className={styles.secondary}
            aria-label="Следующая неделя"
            onClick={() => {
              setStart(addDays(start, 7));
              setSelectedDate(null);
            }}
          >
            →
          </button>
          <button
            className={styles.textButton}
            onClick={() => {
              setStart(TODAY);
              setSelectedDate(null);
            }}
          >
            Сегодня
          </button>
        </div>
      </div>
      <div className={ops.planTotals}>
        <span>
          Заезды: <b>{plans.filter((p) => p.kind === 'arrival').length}</b>
        </span>
        <span>
          Выезды: <b>{plans.filter((p) => p.kind === 'departure').length}</b>
        </span>
        <span>
          Ожидают подтверждения: <b>{plans.filter((p) => !p.confirmed).length}</b>
        </span>
      </div>
      <div className={ops.week}>
        {week.map((date) => {
          const events = plans.filter((p) => p.date === date);
          return (
            <button
              key={date}
              aria-pressed={selectedDate === date}
              className={date === TODAY ? ops.today : ''}
              onClick={() => setSelectedDate(selectedDate === date ? null : date)}
            >
              <span>{weekday(date)}</span>
              <strong>{dateLabel(date)}</strong>
              <div>
                {events.length ? (
                  <>
                    <small className={ops.arrival}>
                      ↓ Заезды: {events.filter((p) => p.kind === 'arrival').length}
                    </small>
                    <small className={ops.departure}>
                      ↑ Выезды: {events.filter((p) => p.kind === 'departure').length}
                    </small>
                  </>
                ) : (
                  <small>Нет событий</small>
                )}
              </div>
              {date === TODAY && <i>Сегодня</i>}
            </button>
          );
        })}
      </div>
      <div className={ops.boardToolbar}>
        <div className={styles.filterChips}>
          {[
            ['all', 'Все события'],
            ['arrival', 'Заезды'],
            ['departure', 'Выезды'],
          ].map(([id, name]) => (
            <button key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>
              {name}
            </button>
          ))}
        </div>
        {selectedDate && (
          <button className={styles.textButton} onClick={() => setSelectedDate(null)}>
            Показать всю неделю ×
          </button>
        )}
      </div>
      <div className={ops.planList}>
        {shown.map((plan) => {
          const person = people.find((p) => p.id === plan.personId)!;
          return (
            <article key={plan.id}>
              <time>{dateLabel(plan.date)}</time>
              <span
                className={`${styles.badge} ${plan.kind === 'arrival' ? styles.green : styles.peach}`}
              >
                {plan.kind === 'arrival' ? 'Заезд' : 'Выезд'}
              </span>
              <div>
                <button
                  className={ops.nameButton}
                  onClick={() => onPerson(person, plan.kind === 'arrival' ? 'next' : 'overview')}
                >
                  {person.name}
                </button>
                <small>
                  {dormName(plan.dormitoryId)}
                  {plan.end ? ` · до ${dateLabel(plan.end)}` : ''}
                </small>
                {plan.comment && <p>{plan.comment}</p>}
              </div>
              <span className={`${styles.badge} ${plan.confirmed ? styles.green : styles.sand}`}>
                {plan.confirmed ? 'Подтверждено' : 'Ожидаем подтверждение'}
              </span>
              {plan.kind === 'arrival' && (
                <button className={styles.textButton} onClick={() => confirmPlan(plan.id)}>
                  {plan.confirmed ? 'Снять подтверждение' : 'Подтвердить'}
                </button>
              )}
            </article>
          );
        })}
        {!shown.length && <p className={ops.empty}>На выбранные даты событий нет.</p>}
      </div>
      <div className={ops.quickPlan}>
        <div>
          <h3>Подготовить следующую вахту</h3>
          <p>
            Выберите сотрудника и укажите даты, общежитие и подтверждение приезда в его карточке.
          </p>
        </div>
        <select
          aria-label="Сотрудник для следующей вахты"
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
        >
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className={styles.primary}
          onClick={() =>
            onPerson(
              people.find((p) => p.id === personId)!,
              'next',
            )
          }
        >
          Запланировать заезд
        </button>
      </div>
    </section>
  );
}

export function TasksBoard({
  dormitory,
  onPerson,
}: {
  dormitory: string;
  onPerson: OpenPerson;
}): JSX.Element {
  const { state, people } = usePersonnelOperations();
  const [filter, setFilter] = useState('open');
  const [assignee, setAssignee] = useState('all');
  const [adding, setAdding] = useState(false);
  const scoped = state.tasks.filter(
    (t) =>
      dormitory === 'all' || people.find((p) => p.id === t.personId)?.dormitoryId === dormitory,
  );
  const tasks = scoped
    .filter(
      (t) =>
        (assignee === 'all' || t.assignee === assignee) &&
        (filter === 'all' ||
          (filter === 'done' ? t.done : !t.done && (filter !== 'overdue' || t.due < TODAY))),
    )
    .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due));
  return (
    <section className={ops.board} data-testid="personnel-tasks">
      <div className={ops.boardHeading}>
        <div>
          <span className={styles.eyebrow}>ЕЖЕДНЕВНАЯ РАБОТА</span>
          <h2>Задачи по сотрудникам</h2>
          <p>Договорённости, сроки и ответственные. Выполненные задачи остаются в истории.</p>
        </div>
        <button className={styles.primary} onClick={() => setAdding(!adding)}>
          {adding ? 'Скрыть форму' : '+ Добавить задачу'}
        </button>
      </div>
      <div className={ops.planTotals}>
        <span>
          <b>{scoped.filter((t) => !t.done).length}</b> открытых
        </span>
        <span>
          <b>{scoped.filter((t) => !t.done && t.due === TODAY).length}</b> на сегодня
        </span>
        <span className={ops.danger}>
          <b>{scoped.filter((t) => !t.done && t.due < TODAY).length}</b> просроченных
        </span>
      </div>
      {adding && (
        <div className={ops.taskFormCard}>
          <TaskForm onDone={() => setAdding(false)} />
        </div>
      )}
      <div className={ops.boardToolbar}>
        <div className={styles.filterChips}>
          {[
            ['open', 'В работе'],
            ['overdue', 'Просрочены'],
            ['done', 'Выполнены'],
            ['all', 'Все задачи'],
          ].map(([id, name]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {name}
            </button>
          ))}
        </div>
        <select
          aria-label="Ответственный за задачи"
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
        >
          <option value="all">Все ответственные</option>
          {assignees.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} onPerson={onPerson} />
      ))}
      {!tasks.length && <p className={ops.empty}>Задач по выбранным условиям нет.</p>}
      <p className={ops.boardFootnote}>
        «Мои сотрудники» — ваш закреплённый список людей. Ответственный за задачу выбирается
        отдельно.
      </p>
    </section>
  );
}

export function MatchesBoard({
  dormitory,
  onPerson,
}: {
  dormitory: string;
  onPerson: OpenPerson;
}): JSX.Element {
  const { state, people, resolveMatch } = usePersonnelOperations();
  const [review, setReview] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const candidates = matches.filter(
    (m) =>
      (dormitory === 'all' ||
        m.dormitoryId === dormitory ||
        people.find((p) => p.id === m.personId)?.dormitoryId === dormitory) &&
      (showResolved || !state.resolutions[m.id]),
  );
  const candidate = matches.find((m) => m.id === review);
  const person = people.find((p) => p.id === candidate?.personId);
  return (
    <section className={ops.board} data-testid="personnel-matches">
      <div className={ops.boardHeading}>
        <div>
          <span className={styles.eyebrow}>ЦЕЛОСТНАЯ ИСТОРИЯ</span>
          <h2>Проверка совпадений</h2>
          <p>
            Архивная запись может принадлежать уже знакомому сотруднику. Сравните данные перед
            связыванием.
          </p>
        </div>
        <span className={`${styles.badge} ${styles.sand}`}>
          Ожидают проверки: {matches.filter((m) => !state.resolutions[m.id]).length}
        </span>
      </div>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
        />
        Показывать проверенные
      </label>
      <div className={ops.matches}>
        {candidates.map((m) => {
          const employee = people.find((p) => p.id === m.personId)!;
          return (
            <article key={m.id}>
              <div className={ops.matchHeading}>
                <span
                  className={`${styles.badge} ${m.id === 'match-1' ? styles.green : styles.sand}`}
                >
                  {m.id === 'match-1' ? 'Сильное совпадение' : 'Нужна ручная проверка'}
                </span>
                {state.resolutions[m.id] && (
                  <span className={`${styles.badge} ${styles.neutral}`}>
                    {state.resolutions[m.id] === 'linked' ? 'Запись связана' : 'Разные сотрудники'}
                  </span>
                )}
              </div>
              <div className={ops.matchPair}>
                <div>
                  <small>Существующая карточка</small>
                  <button className={ops.nameButton} onClick={() => onPerson(employee)}>
                    {employee.name}
                  </button>
                  <span>
                    Т/н {employee.number} · {dormName(employee.dormitoryId)}
                  </span>
                </div>
                <span>↔</span>
                <div>
                  <small>{m.source}</small>
                  <strong>{m.name}</strong>
                  <span>
                    Т/н {m.number} · {dormName(m.dormitoryId)}
                  </span>
                </div>
              </div>
              <div className={ops.matchFooter}>
                <p>{m.evidence}</p>
                {!state.resolutions[m.id] && (
                  <button className={styles.secondary} onClick={() => setReview(m.id)}>
                    Сравнить записи →
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {!candidates.length && <p className={ops.empty}>Все совпадения проверены.</p>}
      </div>
      {candidate && person && (
        <Modal
          title="Сравнить записи сотрудника"
          testId="personnel-match-review"
          onClose={() => setReview(null)}
          panelClassName={`${styles.theme} ${ops.matchDialog}`}
        >
          <p className={ops.hint}>
            {candidate.evidence}. Сравнение касается архивной записи от{' '}
            {dateLabel(candidate.date, true)}
          </p>
          <div className={styles.tableScroll}>
            <table>
              <thead>
                <tr>
                  <th>Данные</th>
                  <th>Карточка</th>
                  <th>Архивная запись</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['ФИО', person.name, candidate.name],
                  ['Табельный номер', person.number, candidate.number],
                  ['Телефон', person.phone ?? 'Не указан', candidate.phone ?? 'Не указан'],
                  ['Общежитие', dormName(person.dormitoryId), dormName(candidate.dormitoryId)],
                ].map(([name, left, right]) => (
                  <tr key={name} className={left !== right ? ops.different : ''}>
                    <th>{name}</th>
                    <td>{left}</td>
                    <td>{right}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={ops.softCard}>
            <strong>Что произойдёт при связывании</strong>
            <p>
              Источник, архивные сведения и причина «{candidate.reason}» добавятся в историю
              существующего сотрудника. Его текущий телефон, табельный номер и проживание
              сохранятся.
            </p>
          </div>
          <div className={ops.actions}>
            <button
              className={styles.secondary}
              onClick={() => {
                resolveMatch(candidate.id, 'separate');
                setReview(null);
              }}
            >
              Это разные сотрудники
            </button>
            <button
              className={styles.primary}
              onClick={() => {
                resolveMatch(candidate.id, 'linked');
                setReview(null);
              }}
            >
              Связать с карточкой
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function SavedListsBar({
  onOpen,
  onSave,
}: {
  onOpen: (list: SavedList) => void;
  onSave: () => void;
}): JSX.Element {
  const { state, people, removeList } = usePersonnelOperations();
  return (
    <div className={ops.savedLists}>
      <span>МОИ СПИСКИ</span>
      {state.lists.map((list) => (
        <div key={list.id}>
          <button onClick={() => onOpen(list)}>
            {list.name}
            <b>{selectSavedList(list, people, state).length}</b>
          </button>
          <button
            aria-label={`Убрать сохранённый список «${list.name}»`}
            onClick={() => removeList(list.id)}
          >
            ×
          </button>
        </div>
      ))}
      <button className={styles.textButton} onClick={onSave}>
        + Сохранить текущий список
      </button>
    </div>
  );
}
export function SaveListDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: SavedList;
  onClose: () => void;
  onSaved: (list: SavedList, pin: boolean) => void;
}): JSX.Element {
  const [name, setName] = useState(draft.name);
  const [pin, setPin] = useState(true);
  const { state, people, saveList } = usePersonnelOperations();
  return (
    <Modal
      title="Сохранить свой список"
      testId="personnel-save-list"
      onClose={onClose}
      panelClassName={styles.theme}
    >
      <form
        className={ops.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          const list = { ...draft, name: name.trim() };
          saveList(list);
          onSaved(list, pin);
        }}
      >
        <label className={styles.field}>
          Название списка
          <input
            required
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className={ops.softCard}>
          <strong>
            {listNames[draft.filter]} · {selectSavedList(draft, people, state).length} в выборке
          </strong>
          <p>
            {draft.dormitory === 'all' ? 'Все общежития' : dormName(draft.dormitory)}
            {draft.scope.length ? ` · ${draft.scope.map(dormName).join(', ')}` : ''}
            {draft.filter === 'ending' ? ` · до ${draft.days} дней` : ''}
            {draft.query ? ` · поиск: ${draft.query}` : ''}
          </p>
          <small>Сохраняются условия. Состав сотрудников обновляется автоматически.</small>
        </div>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={pin} onChange={(event) => setPin(event.target.checked)} />
          Закрепить блоком на рабочей поверхности
        </label>
        <button className={styles.primary} disabled={!name.trim()}>
          Сохранить список
        </button>
      </form>
    </Modal>
  );
}

const exportColumns = [
  { id: 'name', name: 'ФИО', value: (p: Person) => p.name },
  { id: 'number', name: 'Табельный номер', value: (p: Person) => p.number },
  { id: 'dormitory', name: 'Общежитие', value: (p: Person) => dormName(p.dormitoryId) },
  { id: 'phone', name: 'Телефон', value: (p: Person) => p.phone ?? '' },
  { id: 'start', name: 'Начало вахты', value: (p: Person) => p.start ?? '' },
  { id: 'end', name: 'Окончание вахты', value: (p: Person) => p.end ?? '' },
  {
    id: 'status',
    name: 'Статус проживания',
    value: (p: Person) => (p.current ? 'Проживает' : 'В оттоке'),
  },
];
export function ExportDialog({
  people,
  mode,
  onClose,
  onDone,
}: {
  people: Person[];
  mode: 'all' | 'departure';
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { state } = usePersonnelOperations();
  const [columns, setColumns] = useState(['name', 'number', 'dormitory', 'phone', 'end']);
  const rows =
    mode === 'departure'
      ? people.filter((p) =>
          state.plans.some(
            (plan) => plan.personId === p.id && plan.kind === 'departure' && plan.date >= TODAY,
          ),
        )
      : people;
  function download(): void {
    const active = exportColumns.filter((c) => columns.includes(c.id));
    const cell = (value: string): string =>
      `"${(/^[=+@-]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const header = [
      ...active.map((c) => c.name),
      ...(mode === 'departure' ? ['Плановый выезд'] : []),
    ];
    const body = [
      header.map(cell).join(';'),
      ...rows.map((p) =>
        [
          ...active.map((c) => c.value(p)),
          ...(mode === 'departure'
            ? [
                state.plans.find((plan) => plan.personId === p.id && plan.kind === 'departure')
                  ?.date ?? '',
              ]
            : []),
        ]
          .map(cell)
          .join(';'),
      ),
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', body], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Персонал-${mode === 'departure' ? 'план-выездов-' : ''}${TODAY}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onDone();
  }
  return (
    <Modal
      title={mode === 'departure' ? 'Подготовить список выездов' : 'Экспорт для Excel'}
      testId="personnel-export"
      onClose={onClose}
      panelClassName={styles.theme}
    >
      <p className={ops.hint}>
        Записей: {rows.length}. Файл CSV откроется в Excel; можно выбрать нужные столбцы.
      </p>
      <div className={ops.exportColumns}>
        {exportColumns.map((c) => (
          <label className={styles.checkLabel} key={c.id}>
            <input
              type="checkbox"
              checked={columns.includes(c.id)}
              onChange={(event) =>
                setColumns(
                  event.target.checked ? [...columns, c.id] : columns.filter((id) => id !== c.id),
                )
              }
            />
            {c.name}
          </label>
        ))}
      </div>
      {mode === 'departure' && !rows.length && (
        <p className={ops.danger}>В выбранном списке нет сотрудников с плановым выездом.</p>
      )}
      <button
        className={styles.primary}
        disabled={!columns.length || !rows.length}
        onClick={download}
      >
        Скачать CSV · {rows.length}
      </button>
    </Modal>
  );
}

export function OperationsBlock({
  block,
  dormitory,
  onPerson,
  onView,
  onSaved,
}: {
  block: Block;
  dormitory: string;
  onPerson: OpenPerson;
  onView: (view: WorkspaceView) => void;
  onSaved: (list: SavedList) => void;
}): JSX.Element {
  const { state, people, toggleTask } = usePersonnelOperations();
  const scope = (id: string): boolean =>
    (dormitory === 'all' || id === dormitory) && (!block.scope.length || block.scope.includes(id));
  if (block.kind === 'plans') {
    const plans = state.plans
      .filter((p) => scope(p.dormitoryId) && p.date >= TODAY && dayDiff(TODAY, p.date) <= 6)
      .sort((a, b) => a.date.localeCompare(b.date));
    return (
      <>
        <p className={styles.blockNote}>
          Ближайшие 7 дней · {dateLabel(TODAY)} — {dateLabel(addDays(TODAY, 6))}
        </p>
        <div className={ops.widgetRows}>
          {plans.slice(0, 3).map((plan) => {
            const person = people.find((p) => p.id === plan.personId)!;
            return (
              <button
                key={plan.id}
                onClick={() => onPerson(person, plan.kind === 'arrival' ? 'next' : 'overview')}
              >
                <span
                  className={`${styles.badge} ${plan.kind === 'arrival' ? styles.green : styles.peach}`}
                >
                  {plan.kind === 'arrival' ? '↓ Заезд' : '↑ Выезд'}
                </span>
                <span>
                  <strong>{person.name.split(' ').slice(0, 2).join(' ')}</strong>
                  <small>
                    {dormName(plan.dormitoryId)} ·{' '}
                    {plan.confirmed ? 'подтверждено' : 'ждём подтверждение'}
                  </small>
                </span>
                <time>{dateLabel(plan.date)}</time>
              </button>
            );
          })}
          {!plans.length && <p className={ops.empty}>На неделю событий нет.</p>}
        </div>
        <div className={styles.cardFooter}>
          <span>Плановых событий: {plans.length}</span>
          <button onClick={() => onView('planning')}>Открыть календарь →</button>
        </div>
      </>
    );
  }
  if (block.kind === 'tasks') {
    const tasks = state.tasks
      .filter((t) => !t.done && scope(people.find((p) => p.id === t.personId)!.dormitoryId))
      .sort((a, b) => a.due.localeCompare(b.due));
    return (
      <>
        <p className={styles.blockNote}>Сначала просроченные и ближайшие задачи</p>
        <div className={ops.widgetTasks}>
          {tasks.slice(0, 3).map((task) => {
            const person = people.find((p) => p.id === task.personId)!;
            return (
              <div key={task.id}>
                <input
                  type="checkbox"
                  checked={task.done}
                  aria-label={`Выполнить задачу: ${task.text}`}
                  onChange={() => toggleTask(task.id)}
                />
                <button onClick={() => onPerson(person, 'work')}>
                  <strong>{task.text}</strong>
                  <small>
                    {person.name.split(' ').slice(0, 2).join(' ')} · {task.assignee}
                  </small>
                </button>
                <span className={task.due < TODAY ? ops.danger : ''}>{dateLabel(task.due)}</span>
              </div>
            );
          })}
          {!tasks.length && <p className={ops.empty}>Все задачи выполнены.</p>}
        </div>
        <div className={styles.cardFooter}>
          <span>В работе: {tasks.length}</span>
          <button onClick={() => onView('tasks')}>Все задачи →</button>
        </div>
      </>
    );
  }
  const list = state.lists.find((l) => l.id === block.savedListId);
  const effectiveScope = block.scope.length
    ? list?.scope.length
      ? block.scope.filter((id) => list.scope.includes(id))
      : block.scope
    : (list?.scope ?? []);
  const incompatibleScope = Boolean(
    block.scope.length && list?.scope.length && !effectiveScope.length,
  );
  const rows =
    list && !incompatibleScope
      ? selectSavedList({ ...list, scope: effectiveScope }, people, state, dormitory)
      : [];
  return (
    <>
      <p className={styles.blockNote}>
        {list
          ? `Условия: ${listNames[list.filter]}`
          : 'Сохранённый список удалён. Выберите другой в настройках блока.'}
      </p>
      <div className={ops.widgetRows}>
        {rows.slice(0, 3).map((person) => (
          <button key={person.id} onClick={() => onPerson(person)}>
            <span aria-hidden="true">{state.favorites.includes(person.id) ? '★' : '○'}</span>
            <span>
              <strong>{person.name.split(' ').slice(0, 2).join(' ')}</strong>
              <small>
                {dormName(person.dormitoryId)} · Т/н {person.number}
              </small>
            </span>
            <span>→</span>
          </button>
        ))}
        {list && !rows.length && <p className={ops.empty}>Сотрудников по условиям пока нет.</p>}
      </div>
      <div className={styles.cardFooter}>
        <span>Всего сотрудников: {rows.length}</span>
        <button
          disabled={!list || !rows.length}
          onClick={() =>
            list &&
            onSaved({
              ...list,
              dormitory: dormitory !== 'all' ? dormitory : list.dormitory,
              scope: effectiveScope,
            })
          }
        >
          Открыть список →
        </button>
      </div>
    </>
  );
}
