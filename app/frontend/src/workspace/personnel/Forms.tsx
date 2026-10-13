import { useState } from 'react';
import type { ReactNode } from 'react';
import { personnelApi } from '../../api/personnel';
import type { Decision, Employee, PersonnelData, Source } from '../../api/personnel';
import { addDays, decisionNames, dormName, message, value } from './helpers';
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
              ? 'Проживание завершится после оформления оттока.'
              : 'Договорённости можно сохранить во вкладке «Заметки».'}
        </p>
      </SubmitForm>
    </section>
  );
}
