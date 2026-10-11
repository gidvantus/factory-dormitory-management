import { useState } from 'react';
import { personnelApi } from '../../api/personnel';
import type { Employee, Match, PersonnelData } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { SubmitForm, TaskForm } from './Forms';
import type { Mutate } from './Forms';
import { addDays, dateLabel, dormName, personName } from './helpers';
import type { ProfileTab } from './PersonnelProfile';
import s from './Personnel.module.css';

export type OpenPerson = (id: string, tab?: ProfileTab) => void;
export function PlanningBoard({
  data,
  dormitory,
  onPerson,
  mutate,
}: {
  data: PersonnelData;
  dormitory: number | null;
  onPerson: OpenPerson;
  mutate: Mutate;
}): JSX.Element {
  const [start, setStart] = useState(data.today);
  const [date, setDate] = useState<string | null>(null);
  const [kind, setKind] = useState('all');
  const [employeeId, setEmployeeId] = useState(data.employees[0]?.id ?? '');
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const plans = data.plans.filter(
    (plan) =>
      plan.date >= start &&
      plan.date <= week[6] &&
      (dormitory == null || plan.dormitory_id === dormitory) &&
      (kind === 'all' || plan.kind === kind),
  );
  const shown = plans.filter((plan) => !date || plan.date === date);
  return (
    <section className={s.board} data-testid="personnel-planning">
      <div className={s.toolbar}>
        <div>
          <span className={s.eyebrow}>ПЛАНИРОВАНИЕ</span>
          <h2>Заезды и выезды</h2>
          <p className={s.hint}>
            План на неделю помогает подготовить места и связаться с сотрудниками.
          </p>
        </div>
        <div className={s.actions}>
          <button
            aria-label="Предыдущая неделя"
            onClick={() => {
              setStart(addDays(start, -7));
              setDate(null);
            }}
          >
            ←
          </button>
          <strong>
            {dateLabel(start)} — {dateLabel(week[6])}
          </strong>
          <button
            aria-label="Следующая неделя"
            onClick={() => {
              setStart(addDays(start, 7));
              setDate(null);
            }}
          >
            →
          </button>
          <button
            onClick={() => {
              setStart(data.today);
              setDate(null);
            }}
          >
            Сегодня
          </button>
        </div>
      </div>
      <p className={s.notice}>
        Заезды: <b>{plans.filter((plan) => plan.kind === 'arrival').length}</b> · Выезды:{' '}
        <b>{plans.filter((plan) => plan.kind === 'departure').length}</b> · Ожидают подтверждения:{' '}
        <b>{plans.filter((plan) => !plan.confirmed).length}</b>
      </p>
      <div className={s.week}>
        {week.map((day) => {
          const events = plans.filter((plan) => plan.date === day);
          return (
            <button
              key={day}
              aria-pressed={date === day}
              data-today={day === data.today}
              onClick={() => setDate(date === day ? null : day)}
            >
              <small>
                {new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(
                  new Date(`${day}T00:00:00Z`),
                )}
                {day === data.today ? ' · Сегодня' : ''}
              </small>
              <strong>{dateLabel(day)}</strong>
              {events.length ? (
                <>
                  <small>↓ Заезды: {events.filter((plan) => plan.kind === 'arrival').length}</small>
                  <small>
                    ↑ Выезды: {events.filter((plan) => plan.kind === 'departure').length}
                  </small>
                </>
              ) : (
                <small>Нет событий</small>
              )}
            </button>
          );
        })}
      </div>
      <div className={s.toolbar}>
        <div className={s.chips}>
          {[
            ['all', 'Все события'],
            ['arrival', 'Заезды'],
            ['departure', 'Выезды'],
          ].map(([id, label]) => (
            <button key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>
              {label}
            </button>
          ))}
        </div>
        {date && <button onClick={() => setDate(null)}>Показать всю неделю ×</button>}
      </div>
      {shown.map((plan) => (
        <article key={plan.id} className={s.plan}>
          <time>{dateLabel(plan.date)}</time>
          <span className={s.badge}>{plan.kind === 'arrival' ? 'Заезд' : 'Выезд'}</span>
          <div>
            <button
              className={s.linkButton}
              onClick={() =>
                onPerson(plan.employee_id, plan.kind === 'arrival' ? 'next' : 'overview')
              }
            >
              {personName(data.employees.find((person) => person.id === plan.employee_id))}
            </button>
            <small>
              {dormName(data, plan.dormitory_id)} · {plan.comment || 'Без дополнительных сведений'}
            </small>
          </div>
          {plan.confirmed ? (
            <span className={s.badge}>Подтверждено</span>
          ) : (
            <button
              onClick={() =>
                void mutate(() => personnelApi.confirmPlan(plan.id, true)).catch(() => {})
              }
            >
              Подтвердить
            </button>
          )}
        </article>
      ))}
      {!shown.length && <p className={s.empty}>На выбранный период событий нет.</p>}
      <div className={s.softCard}>
        <h3>Подготовить следующую вахту</h3>
        <div className={s.actions}>
          <select
            aria-label="Сотрудник для следующей вахты"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
          >
            <option value="">Выберите сотрудника</option>
            {data.employees.map((person) => (
              <option key={person.id} value={person.id}>
                {personName(person)} · Т/н {person.personnel_number ?? '—'}
              </option>
            ))}
          </select>
          <button
            className={s.primary}
            disabled={!employeeId}
            onClick={() => onPerson(employeeId, 'next')}
          >
            Запланировать заезд
          </button>
        </div>
      </div>
    </section>
  );
}
export function TasksBoard({
  data,
  dormitory,
  onPerson,
  mutate,
}: {
  data: PersonnelData;
  dormitory: number | null;
  onPerson: OpenPerson;
  mutate: Mutate;
}): JSX.Element {
  const [filter, setFilter] = useState('open');
  const [assignee, setAssignee] = useState('all');
  const [creating, setCreating] = useState(false);
  const scoped = data.tasks.filter(
    (task) =>
      dormitory == null ||
      data.employees
        .find((person) => person.id === task.employee_id)
        ?.sources.some((source) => source.dormitory_id === dormitory),
  );
  const tasks = scoped.filter(
    (task) =>
      (filter === 'all' || filter === 'done'
        ? filter === 'all' || task.done
        : !task.done && (filter !== 'overdue' || task.due < data.today)) &&
      (assignee === 'all' || task.assignee_id === Number(assignee)),
  );
  return (
    <section className={s.board} data-testid="personnel-tasks">
      <div className={s.toolbar}>
        <div>
          <span className={s.eyebrow}>ДОГОВОРЁННОСТИ И ДЕЙСТВИЯ</span>
          <h2>Задачи по сотрудникам</h2>
          <p className={s.hint}>Срок, ответственный и результат сохраняются в истории.</p>
        </div>
        <button
          className={s.primary}
          disabled={!data.employees.length}
          onClick={() => setCreating((value) => !value)}
        >
          + Новая задача
        </button>
      </div>
      <p className={s.notice}>
        В работе: {scoped.filter((task) => !task.done).length} · На сегодня:{' '}
        {scoped.filter((task) => !task.done && task.due === data.today).length} · Просрочено:{' '}
        {scoped.filter((task) => !task.done && task.due < data.today).length}
      </p>
      <div className={s.toolbar}>
        <div className={s.chips}>
          {[
            ['open', 'В работе'],
            ['overdue', 'Просроченные'],
            ['done', 'Выполненные'],
            ['all', 'Все задачи'],
          ].map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <label>
          Ответственный
          <select
            aria-label="Ответственный по задачам"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
          >
            <option value="all">Все ответственные</option>
            {data.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {creating && (
        <section className={s.softCard}>
          <TaskForm data={data} mutate={mutate} onDone={() => setCreating(false)} />
        </section>
      )}
      {tasks.map((task) => (
        <article key={task.id} className={s.task} data-done={task.done}>
          <input
            type="checkbox"
            checked={task.done}
            aria-label={`${task.done ? 'Вернуть в работу' : 'Выполнить задачу'}: ${task.text}`}
            onChange={() =>
              void mutate(() => personnelApi.toggleTask(task.id, !task.done)).catch(() => {})
            }
          />
          <div>
            <strong>{task.text}</strong>
            <small>
              <button className={s.linkButton} onClick={() => onPerson(task.employee_id, 'work')}>
                {personName(data.employees.find((person) => person.id === task.employee_id))}
              </button>{' '}
              ·{' '}
              {data.users.find((user) => user.id === task.assignee_id)?.name ??
                'Ответственный не назначен'}
            </small>
          </div>
          <time className={!task.done && task.due < data.today ? s.warning : ''}>
            {dateLabel(task.due, true)}
          </time>
        </article>
      ))}
      {!tasks.length && <p className={s.empty}>Задач по выбранным условиям нет.</p>}
    </section>
  );
}
export function MatchesBoard({
  data,
  dormitory,
  onPerson,
  mutate,
}: {
  data: PersonnelData;
  dormitory: number | null;
  onPerson: OpenPerson;
  mutate: Mutate;
}): JSX.Element {
  const [review, setReview] = useState<Match | null>(null);
  const pairs = data.matches.filter(
    (match) =>
      dormitory == null ||
      data.employees.some(
        (person) =>
          [match.source_id, match.target_id].includes(person.id) &&
          person.sources.some((source) => source.dormitory_id === dormitory),
      ),
  );
  return (
    <section className={s.board} data-testid="personnel-matches">
      <div className={s.toolbar}>
        <div>
          <span className={s.eyebrow}>ЦЕЛОСТНАЯ ИСТОРИЯ</span>
          <h2>Проверка совпадений</h2>
          <p className={s.hint}>
            Сравните сведения перед связыванием. Одной фамилии или табельного номера недостаточно.
          </p>
        </div>
        <span className={s.badge}>Ожидают проверки: {pairs.length}</span>
      </div>
      <div className={s.comparison}>
        {pairs.map((match) => {
          const source = data.employees.find((person) => person.id === match.source_id);
          const target = data.employees.find((person) => person.id === match.target_id);
          if (!source || !target) return null;
          return (
            <article key={`${match.source_id}-${match.target_id}`}>
              <span className={s.badge}>
                {match.score >= 80 ? 'Несколько совпадающих признаков' : 'Нужна ручная проверка'}
              </span>
              <div className={s.comparisonPair}>
                {[source, target].map((person, index) => (
                  <div key={person.id}>
                    <button className={s.linkButton} onClick={() => onPerson(person.id)}>
                      {personName(person)}
                    </button>
                    <p>
                      Т/н {person.personnel_number ?? '—'} · {person.phone ?? 'Телефон не указан'}
                    </p>
                    <p>
                      {[
                        ...new Set(
                          person.sources.map((record) => dormName(data, record.dormitory_id)),
                        ),
                      ].join(' · ') || 'Есть сохранённая история'}
                    </p>
                    {index === 0 && <small>Первая карточка</small>}
                  </div>
                ))}
              </div>
              <p className={s.hint}>{match.evidence.join(' · ')}</p>
              {match.differences.length > 0 && (
                <p className={s.warning}>{match.differences.join(' · ')}</p>
              )}
              <button onClick={() => setReview(match)}>Сравнить карточки →</button>
            </article>
          );
        })}
      </div>
      {!pairs.length && <p className={s.empty}>Совпадений для проверки нет.</p>}
      {review && (
        <MatchDialog match={review} data={data} mutate={mutate} onClose={() => setReview(null)} />
      )}
    </section>
  );
}
function MatchDialog({
  match,
  data,
  mutate,
  onClose,
}: {
  match: Match;
  data: PersonnelData;
  mutate: Mutate;
  onClose: () => void;
}): JSX.Element | null {
  const left = data.employees.find((person) => person.id === match.source_id);
  const right = data.employees.find((person) => person.id === match.target_id);
  const [target, setTarget] = useState(match.target_id);
  const [action, setAction] = useState('merge');
  const identities: (keyof Pick<Employee, 'full_name' | 'personnel_number' | 'phone'>)[] = [
    'full_name',
    'personnel_number',
    'phone',
  ];
  if (!left || !right) return null;
  return (
    <Modal
      title="Сравнить карточки сотрудника"
      testId="personnel-match-review"
      onClose={onClose}
      panelClassName={s.modal}
    >
      <div className={s.tableScroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Данные</th>
              <th>Первая карточка</th>
              <th>Вторая карточка</th>
            </tr>
          </thead>
          <tbody>
            {identities.map((field, index) => (
              <tr key={field}>
                <th>{['ФИО', 'Табельный номер', 'Телефон'][index]}</th>
                {[left, right].map((person) => (
                  <td key={person.id}>
                    <strong>{person[field] || '—'}</strong>
                    {(person.variants[field]?.length ?? 0) > 1 && (
                      <small>Варианты: {person.variants[field]?.join(' · ')}</small>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th>Проживание</th>
              {[left, right].map((person) => (
                <td key={person.id}>
                  {person.current
                    .map((source) => dormName(data, source.dormitory_id))
                    .join(' · ') || 'Сейчас не проживает'}
                </td>
              ))}
            </tr>
            <tr>
              <th>Источники</th>
              {[left, right].map((person) => (
                <td key={person.id}>
                  {person.sources.map((source) => (
                    <small key={`${source.table_key}-${source.row_id}`}>
                      {dormName(data, source.dormitory_id)} · {source.source_name}
                    </small>
                  ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <SubmitForm
        label={action === 'merge' ? 'Связать карточки' : 'Подтвердить: разные сотрудники'}
        onDone={onClose}
        onSubmit={(form) =>
          mutate(() =>
            action === 'merge'
              ? personnelApi.merge(
                  {
                    ...match,
                    source_id: target === right.id ? left.id : right.id,
                    target_id: target,
                  },
                  String(form.get('reason')).trim(),
                )
              : personnelApi.separate(match, String(form.get('reason')).trim()),
          )
        }
      >
        <label>
          Результат проверки
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="merge">Это один человек — связать историю</option>
            <option value="separate">Это разные сотрудники</option>
          </select>
        </label>
        {action === 'merge' && (
          <>
            <label>
              Основная карточка
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                {[left, right].map((person) => (
                  <option key={person.id} value={person.id}>
                    {personName(person)} · Т/н {person.personnel_number ?? '—'} ·{' '}
                    {person.current
                      .map((source) => dormName(data, source.dormitory_id))
                      .join(', ') || 'Без текущего проживания'}
                  </option>
                ))}
              </select>
            </label>
            <p className={s.hint}>
              Исходные значения, история, задачи и планы сохранятся. Данные основной карточки
              останутся основными. Объединение можно отменить в её истории.
            </p>
          </>
        )}
        <label>
          Основание решения
          <textarea
            name="reason"
            maxLength={1000}
            required
            placeholder="Например, данные сверены с сотрудником"
          />
        </label>
      </SubmitForm>
    </Modal>
  );
}
