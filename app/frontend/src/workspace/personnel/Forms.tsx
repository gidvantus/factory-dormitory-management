import { useState } from 'react';
import type { ReactNode } from 'react';
import { personnelApi } from '../../api/personnel';
import type { Decision, Employee, PersonnelData, Source } from '../../api/personnel';
import { addDays, decisionNames, dormName, message, personName, value } from './helpers';
import s from './Personnel.module.css';

export type Mutate = (action: () => Promise<unknown>) => Promise<void>;
export function SubmitForm({
  children,
  label,
  onSubmit,
  onDone,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onSubmit: (data: FormData) => Promise<unknown>;
  onDone?: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className={s.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        const fields = new FormData(form);
        setBusy(true);
        setError('');
        void onSubmit(fields)
          .then(() => {
            form.reset();
            onDone?.();
          })
          .catch((caught) => setError(message(caught)))
          .finally(() => setBusy(false));
      }}
    >
      <fieldset
        disabled={busy || disabled}
        style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}
      >
        {children}
      </fieldset>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.actions}>
        <button className={s.primary} disabled={busy || disabled}>
          {busy ? 'Сохраняем…' : label}
        </button>
      </div>
    </form>
  );
}
export function TaskForm({
  data,
  employeeId,
  mutate,
  onDone,
}: {
  data: PersonnelData;
  employeeId?: string;
  mutate: Mutate;
  onDone?: () => void;
}): JSX.Element {
  return (
    <SubmitForm
      label="Добавить задачу"
      disabled={!data.employees.length}
      onDone={onDone}
      onSubmit={(form) =>
        mutate(() =>
          personnelApi.addTask(employeeId ?? String(form.get('employee')), {
            text: String(form.get('text')).trim(),
            due: String(form.get('due')),
            assignee_id: Number(form.get('assignee')) || null,
          }),
        )
      }
    >
      {!employeeId && (
        <label>
          Сотрудник
          <select name="employee" required>
            {data.employees.map((person) => (
              <option key={person.id} value={person.id}>
                {personName(person)} · Т/н {person.personnel_number ?? '—'}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Что нужно сделать
        <input name="text" required maxLength={300} placeholder="Например, уточнить дату выезда" />
      </label>
      <div className={s.formGrid}>
        <label>
          Срок
          <input type="date" name="due" required defaultValue={data.today} />
        </label>
        <label>
          Ответственный
          <select name="assignee" defaultValue={data.user_id}>
            <option value="">Не назначен</option>
            {data.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </SubmitForm>
  );
}
export function NoteForm({
  employeeId,
  mutate,
}: {
  employeeId: string;
  mutate: Mutate;
}): JSX.Element {
  return (
    <SubmitForm
      label="Сохранить заметку"
      onSubmit={(form) =>
        mutate(() => personnelApi.addNote(employeeId, String(form.get('text')).trim()))
      }
    >
      <label>
        Текст заметки
        <textarea
          name="text"
          required
          maxLength={1500}
          placeholder="Результат разговора, договорённости, важные детали…"
        />
      </label>
    </SubmitForm>
  );
}
export function EmployeeEditForm({
  employee,
  mutate,
  onDone,
}: {
  employee: Employee;
  mutate: Mutate;
  onDone: () => void;
}): JSX.Element {
  return (
    <SubmitForm
      label="Сохранить данные карточки"
      onDone={onDone}
      onSubmit={(form) =>
        mutate(() =>
          personnelApi.updateEmployee(employee.id, {
            full_name: String(form.get('full_name')).trim() || null,
            personnel_number: String(form.get('personnel_number')).trim() || null,
            phone: String(form.get('phone')).trim() || null,
            identity_status: form.get('confirmed') ? 'confirmed' : 'pending',
          }),
        )
      }
    >
      <p className={s.hint}>
        Основные данные используются в общей карточке. Исходные значения в таблицах и предыдущие
        варианты сохраняются в истории.
      </p>
      <label>
        ФИО
        <input name="full_name" maxLength={255} defaultValue={employee.full_name ?? ''} />
      </label>
      <div className={s.formGrid}>
        <label>
          Табельный номер
          <input
            name="personnel_number"
            maxLength={40}
            defaultValue={employee.personnel_number ?? ''}
          />
        </label>
        <label>
          Телефон
          <input name="phone" maxLength={30} defaultValue={employee.phone ?? ''} />
        </label>
      </div>
      <label className={s.radio}>
        <input
          type="checkbox"
          name="confirmed"
          defaultChecked={employee.identity_status === 'confirmed'}
        />
        Данные сотрудника проверены
      </label>
    </SubmitForm>
  );
}
export function DecisionForm({
  employee,
  source,
  data,
  mutate,
}: {
  employee: Employee;
  source: Source;
  data: PersonnelData;
  mutate: Mutate;
}): JSX.Element {
  const current = data.decisions.find((decision) => decision.resident_id === source.row_id);
  const [status, setStatus] = useState<Decision['status']>(current?.status ?? 'waiting');
  const sourceEnd = value(source, 'shift_end');
  const defaultDate =
    current?.status === status && current.date
      ? current.date
      : status === 'extend'
        ? addDays(sourceEnd >= data.today ? sourceEnd : data.today, 14)
        : sourceEnd >= data.today
          ? sourceEnd
          : data.today;
  return (
    <section className={s.softCard}>
      <h4>Решение по окончанию вахты · {dormName(data, source.dormitory_id)}</h4>
      <SubmitForm
        label="Сохранить решение"
        onSubmit={(form) =>
          mutate(() =>
            personnelApi.saveDecision(employee.id, {
              resident_id: source.row_id,
              status,
              date: status === 'waiting' ? null : String(form.get('date')),
              comment: String(form.get('comment')).trim(),
            }),
          )
        }
      >
        <label>
          Решение
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as Decision['status'])}
          >
            {Object.entries(decisionNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {status !== 'waiting' && (
          <label>
            {status === 'extend' ? 'Новая дата окончания' : 'Дата выезда'}
            <input
              key={`${status}-${defaultDate}`}
              type="date"
              name="date"
              required
              min={data.today}
              defaultValue={defaultDate}
            />
          </label>
        )}
        <label>
          Комментарий
          <textarea name="comment" maxLength={1000} defaultValue={current?.comment ?? ''} />
        </label>
        <p className={s.hint}>
          {status === 'extend'
            ? 'Дата изменится в исходной строке «Проживающих» и в списках ближайших окончаний.'
            : status === 'departure'
              ? 'Выезд появится в календаре. Проживание завершится после оформления оттока.'
              : 'Задачу на уточнение можно добавить во вкладке «Задачи и заметки».'}
        </p>
      </SubmitForm>
    </section>
  );
}
export function NextShiftForm({
  employee,
  data,
  mutate,
}: {
  employee: Employee;
  data: PersonnelData;
  mutate: Mutate;
}): JSX.Element {
  const plans = data.plans.filter(
    (plan) => plan.employee_id === employee.id && plan.kind === 'arrival',
  );
  const current = plans[0];
  const earliest = employee.current
    .map((source) => value(source, 'shift_end'))
    .filter(Boolean)
    .reduce((result, end) => (end >= result ? addDays(end, 1) : result), data.today);
  const available = data.dormitories.filter((dorm) => !dorm.is_archived);
  const activeDorm = current?.dormitory_id ?? employee.current[0]?.dormitory_id ?? available[0]?.id;
  return (
    <section className={s.softCard}>
      <h4>Следующая вахта</h4>
      {plans.map((plan) => (
        <div className={s.source} key={plan.id}>
          <strong>
            {plan.date} — {plan.end}
          </strong>
          <p>
            {dormName(data, plan.dormitory_id)} ·{' '}
            {plan.confirmed ? 'Приезд подтверждён' : 'Ожидаем подтверждение'}
          </p>
          {plan.comment && <p>{plan.comment}</p>}
          <div className={s.actions}>
            <button
              type="button"
              onClick={() =>
                void mutate(() => personnelApi.confirmPlan(plan.id, !plan.confirmed)).catch(
                  () => {},
                )
              }
            >
              {plan.confirmed ? 'Снять подтверждение' : 'Подтвердить приезд'}
            </button>
            <button
              type="button"
              onClick={() => void mutate(() => personnelApi.cancelPlan(plan.id)).catch(() => {})}
            >
              Отменить план
            </button>
          </div>
        </div>
      ))}
      {plans.length > 1 && (
        <p className={s.warning}>
          У сотрудника несколько планов после связывания карточек. Отмените лишние перед
          редактированием.
        </p>
      )}
      <SubmitForm
        key={current?.id ?? employee.id}
        label={current ? 'Обновить следующую вахту' : 'Запланировать следующую вахту'}
        disabled={!available.length || plans.length > 1}
        onSubmit={(form) =>
          mutate(() =>
            personnelApi.savePlan(employee.id, {
              date: String(form.get('date')),
              end: String(form.get('end')),
              dormitory_id: Number(form.get('dormitory')),
              confirmed: !!form.get('confirmed'),
              comment: String(form.get('comment')).trim(),
            }),
          )
        }
      >
        <div className={s.formGrid}>
          <label>
            Дата заезда
            <input
              type="date"
              name="date"
              min={earliest}
              required
              defaultValue={current?.date ?? addDays(earliest, 2)}
            />
          </label>
          <label>
            Окончание вахты
            <input
              type="date"
              name="end"
              min={earliest}
              required
              defaultValue={current?.end ?? addDays(earliest, 46)}
            />
          </label>
        </div>
        <label>
          Планируемое общежитие
          <select name="dormitory" required defaultValue={activeDorm}>
            {available.map((dorm) => (
              <option key={dorm.id} value={dorm.id}>
                {dorm.name} · {dorm.client_name}
              </option>
            ))}
          </select>
        </label>
        <label className={s.radio}>
          <input name="confirmed" type="checkbox" defaultChecked={current?.confirmed} />
          Сотрудник подтвердил приезд
        </label>
        <label>
          Детали приезда
          <textarea name="comment" maxLength={1000} defaultValue={current?.comment ?? ''} />
        </label>
        <p className={s.hint}>
          {available.length
            ? 'План появится в календаре и списке «Ожидают заезда». Фактическое заселение оформляется в общежитии.'
            : 'Сначала создайте действующее общежитие.'}
        </p>
      </SubmitForm>
    </section>
  );
}
