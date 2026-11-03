import { useEffect, useRef, useState } from 'react';
import { personnelApi } from '../../../api/personnel';
import { ApiError } from '../../../api/client';
import type { ArrivalPlan, ArrivalWorkflowResult, IdentityChoice } from '../../../api/personnel';
import { Modal, ModalCancelButton } from '../../../components/Modal';
import { IdentityDialog } from '../IdentityDialog';
import { addDays, dateLabel, message } from '../helpers';
import type { Field, Person } from './data';
import { WorkflowValues } from './WorkflowPeople';
import a from './Arrivals.module.css';
import s from './Workflow.module.css';

export function ArrivalMoveDialog({
  plan,
  person,
  dorm,
  onClose,
  onSave,
}: {
  plan: ArrivalPlan;
  person: Person;
  dorm: string;
  onClose: () => void;
  onSave: (date: string) => Promise<void>;
}): JSX.Element {
  const [date, setDate] = useState(addDays(plan.date, 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  return (
    <Modal
      title="Перенести заезд человека"
      testId="arrival-move-dialog"
      onClose={onClose}
      closeDisabled={busy}
      panelClassName={a.dialog}
    >
      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError('');
          void onSave(date)
            .catch((caught) => setError(message(caught)))
            .finally(() => {
              pending.current = false;
              setBusy(false);
            });
        }}
      >
        <p>
          {person.name} · {dorm} · {dateLabel(plan.date, true)}
        </p>
        <label className={a.inputField}>
          Новая дата заезда
          <input
            type="date"
            required
            disabled={busy}
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setError('');
            }}
          />
        </label>
        <p className={a.previewNote}>
          На выбранную дату появится ожидаемый приезд этого человека со всеми личными полями. Если
          заезд в это общежитие уже есть, человек будет добавлен к нему. В исходной дате сохранится
          отметка о переносе.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <ModalCancelButton
            onClick={onClose}
            disabled={busy}
            className="btn btn--ghost btn--compact"
          />
          <button disabled={busy} className="btn btn--primary btn--compact">
            {busy ? 'Переносим…' : 'Перенести заезд'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ArrivalSettlementDialog({
  plan,
  person,
  fields,
  today,
  onClose,
  onSave,
  onSaved,
}: {
  plan: ArrivalPlan;
  person: Person;
  fields: Field[];
  today: string;
  onClose: () => void;
  onSave: (save: () => Promise<ArrivalWorkflowResult>) => Promise<ArrivalWorkflowResult>;
  onSaved: () => void;
}): JSX.Element {
  const [date, setDate] = useState(plan.workflow?.[person.id]?.arrived_on ?? today);
  const [hostel, setHostel] = useState('');
  const [hostels, setHostels] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const initialShifts = String(person.values.shifts ?? '');
  const [shifts, setShifts] = useState(/^\d+$/.test(initialShifts) ? initialShifts : '');
  const initialStart = String(person.values.workdate ?? '');
  const [start, setStart] = useState(
    /^\d{4}-\d{2}-\d{2}$/.test(initialStart) ? initialStart : date,
  );
  const [end, setEnd] = useState('');
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setLoading(true);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void personnelApi
      .arrivalHostels(plan.id, date, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setHostels(result.hostels);
          setHostel((old) => (result.hostels.some((item) => String(item.id) === old) ? old : ''));
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(message(caught));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [plan.id, date, attempt]);
  async function saveRecord(identity: IdentityChoice): Promise<string> {
    if (loading || error) throw new ApiError(422, 'Дождитесь загрузки действующих хостелов.');
    if (!hostel) throw new ApiError(422, 'Выберите место проживания.');
    const result = await onSave(() =>
      personnelApi.settleArrival(plan.id, person.id, {
        revision: plan.revision,
        identity,
        hostel_id: Number(hostel),
        settlement_date: date,
        shift_start: start,
        shift_end: end || null,
        shift_count: shifts === '' ? null : Number(shifts),
      }),
    );
    return (
      result.plans.find((item) => item.id === plan.id)?.workflow?.[person.id]?.employee_id ?? ''
    );
  }
  return (
    <IdentityDialog
      dormitoryId={String(plan.dormitory_id)}
      tableKey="residents"
      title="Оформить в проживающие"
      submitLabel="Оформить в проживающие"
      initial={{ full_name: person.name }}
      onClose={onClose}
      onSaved={onSaved}
      saveRecord={saveRecord}
      panelClassName={a.arrivalDialog}
      renderFields={(identity, busy, onChange) => (
        <>
          <p className={s.notice}>
            Прибытие отмечено. Выберите существующую карточку ниже или оформите нового сотрудника.
          </p>
          <div className={s.formGrid}>
            <label>
              ФИО
              <input value={person.name} readOnly />
            </label>
            <label>
              Дата заселения
              <input
                type="date"
                value={date}
                required
                disabled={busy}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              Место проживания
              <select
                required
                value={hostel}
                disabled={busy || loading}
                onChange={(event) => setHostel(event.target.value)}
              >
                <option value="">Выберите хостел / корпус</option>
                {hostels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Табельный номер
              <input
                value={identity.personnel_number ?? ''}
                maxLength={40}
                disabled={busy}
                placeholder="Из карточки или вручную"
                onChange={(event) => onChange('personnel_number', event.target.value || null)}
              />
            </label>
            <label>
              Телефон
              <input
                type="tel"
                value={identity.phone ?? ''}
                maxLength={30}
                disabled={busy}
                placeholder="Из карточки или вручную"
                onChange={(event) => onChange('phone', event.target.value || null)}
              />
            </label>
            <label>
              Количество смен
              <input
                type="number"
                min={0}
                max={1000000}
                step={1}
                value={shifts}
                disabled={busy}
                onChange={(event) => setShifts(event.target.value)}
              />
            </label>
            <label>
              Начало вахты
              <input
                type="date"
                required
                value={start}
                disabled={busy}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label>
              Окончание вахты
              <input
                type="date"
                value={end}
                min={start}
                disabled={busy}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </div>
          {loading && <p role="status">Загружаем действующие хостелы…</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Повторить
              </button>
            </p>
          )}
          {!loading && !error && !hostels.length && (
            <p role="alert">
              В месяце заселения нет действующих хостелов. Добавьте их в «Размещении персонала» или
              выберите другую дату.
            </p>
          )}
          <p className={s.muted}>
            Для выбранной карточки пустые телефон и табельный номер заполнятся из её данных.
            Количество смен не заменяет даты вахты.
          </p>
          <details>
            <summary>Личные сведения из плана</summary>
            <WorkflowValues
              fields={fields.filter((field) => field.scope === 'person')}
              values={person.values}
            />
          </details>
        </>
      )}
    />
  );
}
