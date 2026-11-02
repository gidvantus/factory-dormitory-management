import { useState } from 'react';
import type { FormEvent } from 'react';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { addDays, dateLabel } from '../../workspace/personnel/helpers';
import type { PlannedArrival, PlannedPerson } from './model';
import s from './ArrivalWorkflowPreview.module.css';

export function MoveDialog({
  arrival,
  person,
  onClose,
  onSave,
}: {
  arrival: PlannedArrival;
  person: PlannedPerson;
  onClose: () => void;
  onSave: (date: string) => void;
}): JSX.Element {
  const [date, setDate] = useState(addDays(arrival.date, 1));
  const [error, setError] = useState('');
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
