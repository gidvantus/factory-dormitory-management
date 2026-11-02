import type { ArrivalVisit } from '../../../api/personnel';
import type { Field, Person } from './data';
import { isEmpty, printable } from './data';
import { dateLabel } from '../helpers';
import s from './Workflow.module.css';

export type WorkflowAction =
  'arrived' | 'no_show' | 'expected' | 'move' | 'undo' | 'destination' | 'origin' | 'details';
export type WorkflowActionHandler = (action: WorkflowAction, personId: string) => void;
const labels = {
  expected: 'Ожидается',
  arrived: 'Прибыл',
  no_show: 'Не приехал',
  moved: 'Перенесён',
};
const historyLabels: Record<string, string> = {
  ...labels,
  settled: 'Заселён (прежняя отметка)',
  rescheduled_from: 'Перенесён из другой даты',
  undo_move: 'Перенос отменён',
};

export function WorkflowValues({
  fields,
  values,
  hideEmpty = true,
}: {
  fields: Field[];
  values: Record<string, string | boolean>;
  hideEmpty?: boolean;
}): JSX.Element {
  return (
    <dl className={s.values}>
      {fields
        .filter((field) => !hideEmpty || !isEmpty(values[field.id]))
        .map((field) => (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd>{printable(field, values[field.id])}</dd>
          </div>
        ))}
    </dl>
  );
}
export function WorkflowPeople({
  people,
  fields,
  workflow,
  onAction,
  busy = false,
  showNames = true,
  hideEmpty = true,
  full = false,
}: {
  people: Person[];
  fields: Field[];
  workflow: Record<string, ArrivalVisit>;
  onAction: WorkflowActionHandler;
  busy?: boolean;
  showNames?: boolean;
  hideEmpty?: boolean;
  full?: boolean;
}): JSX.Element {
  return (
    <ul className={s.people}>
      {people
        .filter((person) => workflow[person.id]?.status !== 'moved')
        .map((person, index) => {
          const visit = workflow[person.id];
          const status = visit?.status === 'settled' ? 'arrived' : (visit?.status ?? 'expected');
          const invoke = (action: WorkflowAction): void => onAction(action, person.id);
          const locked = busy || !person.name.trim();
          const statusHistory =
            visit?.history.filter(
              (item) => !['moved', 'rescheduled_from', 'undo_move'].includes(item.action),
            ) ?? [];
          return (
            <li
              className={s.person}
              key={person.id}
              data-testid={`arrival-person-${person.id}`}
              data-status={status}
            >
              <div className={s.personHeading}>
                <button
                  type="button"
                  className={`btn link-button ${s.textAction}`}
                  disabled={busy}
                  onClick={() => invoke('details')}
                >
                  {showNames
                    ? person.name || `Человек ${index + 1} — ФИО не указано`
                    : `Человек ${index + 1}`}
                </button>
                <span className={s.badge} data-state={status}>
                  {labels[status]}
                </span>
              </div>
              <WorkflowValues fields={fields} values={person.values} hideEmpty={hideEmpty} />
              {visit?.origin && (
                <small className={s.transferNote}>
                  Перенесён с {dateLabel(visit.origin.date, true)}
                </small>
              )}
              <div className={s.actions}>
                {status === 'expected' && (
                  <>
                    <button
                      type="button"
                      className="btn btn--primary btn--compact"
                      disabled={locked}
                      onClick={() => invoke('arrived')}
                    >
                      Прибыл
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--compact"
                      disabled={locked}
                      onClick={() => invoke('no_show')}
                    >
                      Не приехал
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--compact"
                      disabled={locked}
                      onClick={() => invoke('move')}
                    >
                      Перенести
                    </button>
                  </>
                )}
                {(status === 'arrived' || status === 'no_show') && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    disabled={busy}
                    onClick={() => invoke('expected')}
                  >
                    Изменить статус
                  </button>
                )}
              </div>
              {full && visit?.settlement && (
                <details className={s.history}>
                  <summary>
                    Сведения на момент заселения · {dateLabel(visit.settlement.settlement_date)}
                  </summary>
                  <p>
                    {visit.settlement.hostel_name} · {visit.settlement.shift_count ?? '—'} смен · с{' '}
                    {dateLabel(visit.settlement.shift_start)}
                    {visit.settlement.shift_end
                      ? ` по ${dateLabel(visit.settlement.shift_end)}`
                      : ''}
                  </p>
                  <WorkflowValues
                    fields={visit.settlement.fields.filter((field) => field.scope === 'person')}
                    values={visit.settlement.personal_values}
                  />
                  <WorkflowValues
                    fields={visit.settlement.fields.filter((field) => field.scope === 'arrival')}
                    values={visit.settlement.arrival_values}
                  />
                </details>
              )}
              {full && statusHistory.length > 0 && (
                <details className={s.history}>
                  <summary>История отметок · {statusHistory.length}</summary>
                  <ul>
                    {statusHistory.map((item, i) => (
                      <li key={i}>
                        {historyLabels[item.action] ?? item.action} · {dateLabel(item.date, true)}
                        {item.destination ? ` → ${dateLabel(item.destination.date)}` : ''}
                        {item.origin ? ` · с ${dateLabel(item.origin.date)}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
    </ul>
  );
}
