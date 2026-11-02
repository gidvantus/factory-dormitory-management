import type { Field } from '../../workspace/personnel/arrivals/data';
import { isEmpty, printable } from '../../workspace/personnel/arrivals/data';
import { dateLabel } from '../../workspace/personnel/helpers';
import type { PlannedArrival, PlannedPerson, VisitStatus } from './model';
import { STATUS_LABELS } from './model';
import s from './ArrivalWorkflowPreview.module.css';

export type PersonAction =
  | 'arrive'
  | 'no_show'
  | 'restore'
  | 'move'
  | 'undo_move'
  | 'open_move'
  | 'settle'
  | 'resident'
  | 'details'
  | 'origin';
export type OnPersonAction = (
  action: PersonAction,
  arrival: PlannedArrival,
  person: PlannedPerson,
) => void;

export function StatusBadge({ status }: { status: VisitStatus }): JSX.Element {
  return (
    <span className={s.status} data-state={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function FilledFields({
  fields,
  values,
  hideEmpty = true,
}: {
  fields: Field[];
  values: Record<string, string | boolean>;
  hideEmpty?: boolean;
}): JSX.Element {
  return (
    <dl className={s.fields}>
      {fields
        .filter(
          (field) => !hideEmpty || (!isEmpty(values[field.id]) && String(values[field.id]).trim()),
        )
        .map((field) => (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd>{printable(field, values[field.id])}</dd>
          </div>
        ))}
    </dl>
  );
}

export function PersonRow({
  arrival,
  person,
  fields,
  full = false,
  onAction,
  hideEmpty = true,
  highlighted = false,
}: {
  arrival: PlannedArrival;
  person: PlannedPerson;
  fields: Field[];
  full?: boolean;
  onAction: OnPersonAction;
  hideEmpty?: boolean;
  highlighted?: boolean;
}): JSX.Element {
  const disabled = !person.name.trim();
  const action = (id: PersonAction): void => onAction(id, arrival, person);
  return (
    <li
      className={s.person}
      id={full ? undefined : `visit-${person.id}`}
      data-testid={`workflow-person-${person.id}`}
      data-status={person.status}
      data-highlight={highlighted}
    >
      <div className={s.personTop}>
        <button
          type="button"
          className="link-button"
          onClick={() => action('details')}
          aria-label={`Полная информация: ${person.name}`}
        >
          {person.name || 'ФИО не указано'}
        </button>
        <StatusBadge status={person.status} />
      </div>
      <FilledFields
        fields={fields.filter((field) => field.scope === 'person')}
        values={person.values}
        hideEmpty={hideEmpty}
      />
      {person.card && full && (
        <p className={s.subtle}>Карточка сотрудника · Т/н {person.card.number}</p>
      )}
      {person.from && (
        <button
          type="button"
          className={`link-button ${s.origin}`}
          onClick={() => action('origin')}
        >
          Перенесён с {dateLabel(person.from.date)}
        </button>
      )}
      <div className={s.rowActions}>
        {person.status === 'expected' && (
          <>
            <button
              type="button"
              className="btn btn--primary btn--compact"
              disabled={disabled}
              onClick={() => action('arrive')}
            >
              Прибыл
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={disabled}
              onClick={() => action('no_show')}
            >
              Не приехал
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={disabled}
              onClick={() => action('move')}
            >
              Перенести
            </button>
          </>
        )}
        {person.status === 'arrived' && (
          <>
            <button
              type="button"
              className="btn btn--primary btn--compact"
              onClick={() => action('settle')}
            >
              В проживающие
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => action('restore')}
            >
              Исправить отметку
            </button>
          </>
        )}
        {person.status === 'no_show' && (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => action('restore')}
            >
              Вернуть в ожидаемые
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => action('move')}
            >
              Перенести
            </button>
          </>
        )}
        {person.status === 'moved' && person.to && (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() => action('open_move')}
            >
              Открыть {dateLabel(person.to.date)}
            </button>
            <button
              type="button"
              className={`link-button ${s.secondaryAction}`}
              onClick={() => action('undo_move')}
            >
              Отменить перенос
            </button>
          </>
        )}
        {person.status === 'settled' && (
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            onClick={() => action('resident')}
          >
            Открыть проживание
          </button>
        )}
      </div>
      {disabled && <p className={s.subtle}>Для отметки прибытия сначала заполните ФИО.</p>}
      {full && person.history.length > 0 && (
        <details className={s.history}>
          <summary>История отметок · {person.history.length}</summary>
          <ul>
            {person.history.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
