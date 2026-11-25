import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { personnelApi } from '../../api/personnel';
import type { ArrivalPlan, EmployeeProfileContext, PersonnelData } from '../../api/personnel';
import { FieldControl } from './arrivals/ArrivalFields';
import { initialSettings } from './arrivals/data';
import type { Field, Value } from './arrivals/data';
import { dateLabel, message } from './helpers';
import s from './Personnel.module.css';

export function EmployeeArrivalAction({
  employeeId,
  dormitories,
  settings,
  onBusy,
  onAdded,
}: {
  employeeId: string;
  dormitories: PersonnelData['dormitories'];
  settings: EmployeeProfileContext['arrival_settings'];
  onBusy: (busy: boolean) => void;
  onAdded: () => void;
}): JSX.Element {
  const active = dormitories.filter((dorm) => !dorm.is_archived);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [dormitory, setDormitory] = useState('');
  const [shiftCount, setShiftCount] = useState<Value>('');
  const [required, setRequired] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<{ created: boolean; plan: ArrivalPlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const numericPersonalFields = (settings?.fields ?? initialSettings().fields).filter(
    (field) => field.inForm && field.scope === 'person' && field.type === 'number',
  );
  const configuredShiftField =
    numericPersonalFields.find(({ id }) => id === 'shifts') ??
    numericPersonalFields.find(({ label }) =>
      /^(кол во смен|количество смен)$/.test(
        label
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_]+/gu, ' ')
          .trim(),
      ),
    );
  const shiftField =
    required.find(({ id }) => id === configuredShiftField?.id) ?? configuredShiftField;
  const extraFields = required.filter(({ id }) => id !== shiftField?.id);

  function resetFields(): void {
    setRequired([]);
    setValues({});
    setError('');
  }

  async function submit(form: HTMLFormElement): Promise<void> {
    if (pending.current || !date || !active.some((dorm) => String(dorm.id) === dormitory)) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const submitted = { ...values };
      if (shiftField && shiftCount !== '') submitted[shiftField.id] = shiftCount;
      const result = await personnelApi.addEmployeeToArrival(employeeId, {
        date,
        dormitory_id: Number(dormitory),
        ...(Object.keys(submitted).length ? { values: submitted } : {}),
      });
      if ('required_fields' in result) {
        setRequired(result.required_fields);
        return;
      }
      setOutcome(result);
      form.reset();
      if (result.created) onAdded();
    } catch (caught) {
      setError(message(caught));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  const plan = outcome?.plan;
  return (
    <section className={s.softCard}>
      {outcome && plan && (
        <div role="status">
          <p>
            {outcome.created ? 'Сотрудник внесён' : 'Сотрудник уже внесён'} в план заездов на{' '}
            {dateLabel(plan.date, true)}.
          </p>
          <Link
            to={`/cabinet/personnel?${new URLSearchParams({
              view: 'planning',
              date: plan.date,
              dormitory: String(plan.dormitory_id),
              arrival: plan.id,
            })}`}
          >
            Открыть план заездов
          </Link>
        </div>
      )}
      {open ? (
        <form
          className={s.form}
          onReset={() => setOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <fieldset className={s.arrivalActionFields} disabled={busy}>
            <div className={shiftField ? s.arrivalActionGrid : s.formGrid}>
              <label>
                Дата заезда
                <input
                  type="date"
                  autoFocus
                  value={date}
                  required
                  onChange={(event) => {
                    setDate(event.target.value);
                    resetFields();
                  }}
                />
              </label>
              <label>
                Общежитие
                <select
                  value={dormitory}
                  required
                  onChange={(event) => {
                    setDormitory(event.target.value);
                    resetFields();
                  }}
                >
                  <option value="">Выберите общежитие</option>
                  {active.map((dorm) => (
                    <option key={dorm.id} value={dorm.id}>
                      {dorm.client_name.trim()
                        ? `${dorm.name} (${dorm.client_name.trim()})`
                        : dorm.name}
                    </option>
                  ))}
                </select>
              </label>
              {shiftField && (
                <FieldControl field={shiftField} value={shiftCount} onChange={setShiftCount} />
              )}
            </div>
            {extraFields.length > 0 && (
              <div className={s.formGrid}>
                {extraFields.map((field) => (
                  <FieldControl
                    key={field.id}
                    field={field}
                    value={values[field.id]}
                    onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
                  />
                ))}
              </div>
            )}
          </fieldset>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.actions}>
            <button type="submit" className={s.primary} disabled={busy}>
              {busy ? 'Вносим…' : 'Внести в план заездов'}
            </button>
            <button type="reset" disabled={busy}>
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className={s.primary}
          disabled={!active.length}
          onClick={() => {
            setDate('');
            setDormitory('');
            setShiftCount('');
            resetFields();
            setOutcome(null);
            setOpen(true);
          }}
        >
          Внести в план заездов
        </button>
      )}
      {!active.length && <p className={s.hint}>Нет действующих общежитий.</p>}
    </section>
  );
}
