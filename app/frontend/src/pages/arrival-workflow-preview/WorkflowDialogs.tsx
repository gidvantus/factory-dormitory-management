import { useState } from 'react';
import type { FormEvent } from 'react';
import { Modal, ModalCancelButton } from '../../components/Modal';
import type { Field } from '../../workspace/personnel/arrivals/data';
import { addDays, dateLabel } from '../../workspace/personnel/helpers';
import type {
  PlannedArrival,
  PlannedPerson,
  Residence,
  SettlementInput,
  WorkflowState,
} from './model';
import { HOSTELS, settlementDefaults, validDate } from './model';
import { FilledFields } from './PersonRow';
import s from './ArrivalWorkflowPreview.module.css';

export function MoveDialog({
  arrival,
  person,
  state,
  onClose,
  onSave,
}: {
  arrival: PlannedArrival;
  person: PlannedPerson;
  state: WorkflowState;
  onClose: () => void;
  onSave: (date: string) => void;
}): JSX.Element {
  const [date, setDate] = useState(addDays(arrival.date, 1));
  const [error, setError] = useState('');
  const target = state.arrivals.find((item) => item.date === date && item.dorm === arrival.dorm);
  function submit(event: FormEvent): void {
    event.preventDefault();
    try {
      onSave(date);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось перенести заезд.');
    }
  }
  return (
    <Modal
      title="Перенести заезд человека"
      testId="workflow-move-dialog"
      onClose={onClose}
      panelClassName={s.dialog}
    >
      <form onSubmit={submit} className={s.form}>
        <div className={s.personSummary}>
          <strong>{person.name}</strong>
          <span>
            {arrival.dorm} · {dateLabel(arrival.date, true)}
          </span>
        </div>
        <label className={s.input}>
          Новая дата заезда
          <input
            type="date"
            required
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setError('');
            }}
          />
        </label>
        <div className={s.explanation}>
          <strong>
            {validDate(date) ? `${arrival.dorm} · ${dateLabel(date, true)}` : 'Выберите новую дату'}
          </strong>
          <p>
            {target
              ? `В этом дне уже запланировано ${target.people.length} чел. После переноса в плане будет ${target.people.length + 1} чел.`
              : 'В выбранном дне появится новый ожидаемый заезд этого человека.'}
          </p>
          <p>ФИО и все личные поля сохранятся. В исходной дате останется отметка о переносе.</p>
          {target && <small>Общие сведения существующего заезда останутся прежними.</small>}
        </div>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <ModalCancelButton className="btn btn--ghost btn--compact" onClick={onClose} />
          <button className="btn btn--primary btn--compact">Перенести заезд</button>
        </div>
      </form>
    </Modal>
  );
}

export function SettlementDialog({
  arrival,
  person,
  fields,
  onClose,
  onSave,
}: {
  arrival: PlannedArrival;
  person: PlannedPerson;
  fields: Field[];
  onClose: () => void;
  onSave: (input: SettlementInput) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => settlementDefaults(person));
  const [error, setError] = useState('');
  const change = (key: keyof SettlementInput, value: string): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError('');
  };
  function submit(event: FormEvent): void {
    event.preventDefault();
    try {
      onSave(draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось оформить проживание.');
    }
  }
  return (
    <Modal
      title="Оформить в проживающие"
      testId="workflow-settlement-dialog"
      onClose={onClose}
      panelClassName={s.dialog}
    >
      <form onSubmit={submit} className={s.form}>
        <div className={s.personSummary}>
          <strong>{person.name}</strong>
          <span>{arrival.dorm} · прибытие отмечено</span>
        </div>
        <p className={s.identity}>
          {person.card
            ? `Используется существующая карточка сотрудника · Т/н ${person.card.number}`
            : 'Будет создана новая карточка сотрудника'}
        </p>
        <div className={s.formGrid}>
          <label className={s.input}>
            Место проживания
            <select
              required
              value={draft.hostel}
              onChange={(event) => change('hostel', event.target.value)}
            >
              <option value="">Выберите хостел / корпус</option>
              {HOSTELS[arrival.dorm].map((hostel) => (
                <option key={hostel}>{hostel}</option>
              ))}
            </select>
          </label>
          <label className={s.input}>
            Дата заселения
            <input
              type="date"
              required
              value={draft.settlementDate}
              onChange={(event) => change('settlementDate', event.target.value)}
            />
          </label>
          <label className={s.input}>
            Табельный номер
            <input
              value={draft.number}
              maxLength={40}
              onChange={(event) => change('number', event.target.value)}
              readOnly={!!person.card}
              placeholder="Можно заполнить позже"
            />
          </label>
          <label className={s.input}>
            Телефон
            <input
              type="tel"
              value={draft.phone}
              maxLength={30}
              onChange={(event) => change('phone', event.target.value)}
              placeholder="Можно заполнить позже"
            />
          </label>
          <label className={s.input}>
            Количество смен
            <input
              type="number"
              min={0}
              max={100000}
              step={1}
              value={draft.shifts}
              onChange={(event) => change('shifts', event.target.value)}
            />
          </label>
          <label className={s.input}>
            Начало вахты
            <input
              type="date"
              required
              value={draft.start}
              onChange={(event) => change('start', event.target.value)}
            />
          </label>
          <label className={s.input}>
            Окончание вахты
            <input
              type="date"
              value={draft.end}
              min={draft.start}
              onChange={(event) => change('end', event.target.value)}
            />
          </label>
        </div>
        <p className={s.subtle}>
          Окончание вахты можно указать отдельно. Количество смен не заменяет календарные даты.
        </p>
        <details className={s.snapshot} open>
          <summary>Личные сведения из плана заезда</summary>
          <FilledFields
            fields={fields.filter((field) => field.scope === 'person')}
            values={person.values}
          />
        </details>
        <p className={s.explanation}>
          После оформления человек появится в «Проживающих» этого общежития. В плане останется
          связанная отметка «В проживающих».
        </p>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <ModalCancelButton className="btn btn--ghost btn--compact" onClick={onClose} />
          <button className="btn btn--primary btn--compact">Оформить в проживающие</button>
        </div>
      </form>
    </Modal>
  );
}

export function ResidenceDialog({
  resident,
  onClose,
  onSource,
}: {
  resident: Residence;
  onClose: () => void;
  onSource: () => void;
}): JSX.Element {
  return (
    <Modal
      title="Карточка проживающего"
      testId="workflow-resident-dialog"
      onClose={onClose}
      panelClassName={s.dialog}
      initialFocus="panel"
    >
      <div className={s.personSummary}>
        <strong>{resident.name}</strong>
        <span>
          {resident.dorm} · {resident.hostel}
        </span>
      </div>
      <dl className={s.residentFacts}>
        <div>
          <dt>Табельный номер</dt>
          <dd>{resident.number || 'Не указан'}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd>{resident.phone || 'Не указан'}</dd>
        </div>
        <div>
          <dt>Дата заселения</dt>
          <dd>{dateLabel(resident.settlementDate, true)}</dd>
        </div>
        <div>
          <dt>Количество смен</dt>
          <dd>{resident.shifts || 'Не указано'}</dd>
        </div>
        <div>
          <dt>Начало вахты</dt>
          <dd>{dateLabel(resident.start, true)}</dd>
        </div>
        <div>
          <dt>Окончание вахты</dt>
          <dd>{resident.end ? dateLabel(resident.end, true) : 'Не указано'}</dd>
        </div>
      </dl>
      <section className={s.snapshot}>
        <h3>Сведения из плана на момент заселения</h3>
        <FilledFields
          fields={resident.fields.filter((field) => field.scope === 'person')}
          values={resident.personalValues}
        />
        <FilledFields
          fields={resident.fields.filter((field) => field.scope === 'arrival')}
          values={resident.arrivalValues}
        />
      </section>
      <div className="dialog-actions">
        {resident.source && (
          <button type="button" className="btn btn--ghost btn--compact" onClick={onSource}>
            Открыть исходный заезд
          </button>
        )}
        <ModalCancelButton className="btn btn--primary btn--compact" onClick={onClose}>
          Закрыть
        </ModalCancelButton>
      </div>
    </Modal>
  );
}
