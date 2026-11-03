import { useRef, useState } from 'react';
import type { ArrivalPlan } from '../../../api/personnel';
import { Modal, ModalCancelButton } from '../../../components/Modal';
import { addDays, dateLabel, message } from '../helpers';
import type { Person } from './data';
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
