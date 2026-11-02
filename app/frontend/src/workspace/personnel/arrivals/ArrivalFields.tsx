import { useId } from 'react';
import type { Arrival, Field, Settings, Value } from './data';
import { isEmpty, namesOf, personCount, printable } from './data';
import s from './Arrivals.module.css';
import type { ArrivalVisit } from '../../../api/personnel';
import { WorkflowPeople } from './WorkflowPeople';
import type { WorkflowActionHandler } from './WorkflowPeople';

export function FieldControl({
  field,
  value,
  onChange,
  compact = false,
  accessibleLabel,
}: {
  field: Field;
  value: Value | undefined;
  onChange: (value: Value) => void;
  compact?: boolean;
  accessibleLabel?: string;
}): JSX.Element {
  const id = useId();
  const label = (
    <>
      {field.label}
      {field.required && <span className={s.required}> *</span>}
    </>
  );
  if (field.type === 'checkbox') {
    return (
      <label className={s.checkField} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          required={field.required}
          aria-label={accessibleLabel}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={compact ? s.srOnly : undefined}>{label}</span>
      </label>
    );
  }
  const props = {
    id,
    required: field.required,
    'aria-label': accessibleLabel,
    value: typeof value === 'string' ? value : '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(e.target.value),
  };
  return (
    <label className={s.inputField} htmlFor={id}>
      <span className={compact ? s.srOnly : undefined}>{label}</span>
      {field.type === 'textarea' ? (
        <textarea {...props} rows={3} maxLength={4000} placeholder="Введите текст" />
      ) : field.type === 'select' ? (
        <select {...props}>
          <option value="">Выберите вариант</option>
          {field.options.filter(Boolean).map((option, i) => (
            <option key={i} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...props}
          type={field.type}
          maxLength={field.type === 'text' ? 1000 : undefined}
          step={field.type === 'number' ? 'any' : undefined}
          placeholder={field.type === 'text' ? 'Введите текст' : undefined}
        />
      )}
    </label>
  );
}

export function ArrivalCard({
  arrival,
  settings,
  onEdit,
  onOpen,
  editLabel,
  workflow,
  onPersonAction,
  busy,
}: {
  arrival: Arrival;
  settings: Settings;
  onEdit?: () => void;
  onOpen?: () => void;
  editLabel?: string;
  workflow?: Record<string, ArrivalVisit>;
  onPersonAction?: WorkflowActionHandler;
  busy?: boolean;
}): JSX.Element {
  const { fields, display } = settings;
  const names = namesOf(arrival);
  const personalFields = display.order
    .map((id) => fields.find((item) => item.id === id))
    .filter(
      (field): field is Field =>
        !!field &&
        field.scope === 'person' &&
        display.visible.includes(field.id) &&
        (!display.hideEmpty ||
          arrival.people
            .slice(0, personCount(arrival.count))
            .some((person) => !isEmpty(person.values[field.id]))),
    );
  const showNames = display.visible.includes('names');
  const people = arrival.people
    .slice(0, personCount(arrival.count))
    .map((person, index) => ({ person, index }))
    .filter(
      ({ person }) =>
        !display.hideEmpty ||
        (showNames && !!person.name.trim()) ||
        personalFields.some((field) => !isEmpty(person.values[field.id])),
    );
  return (
    <article
      className={s.arrivalCard}
      data-compact={display.compact}
      data-clickable={!!onOpen}
      data-testid={`arrival-card-${arrival.id}`}
      onClick={
        onOpen
          ? (event) => {
              const target = event.target;
              if (
                !(target instanceof Element) ||
                target.closest('button, a, input, select, textarea') ||
                window.getSelection()?.toString().trim()
              )
                return;
              onOpen();
            }
          : undefined
      }
    >
      <div className={s.cardHeading}>
        <h4>{arrival.dorm}</h4>
        <b>{arrival.count} чел.</b>
      </div>
      {display.order.map((id) => {
        if (id === 'names') {
          if ((!showNames && !personalFields.length) || (!people.length && display.hideEmpty))
            return null;
          return (
            <div className={s.names} key={id}>
              <span>Приезжающие{personalFields.length ? ' и личные сведения' : ''}</span>
              {people.length ? (
                <>
                  {onPersonAction ? (
                    <WorkflowPeople
                      people={people.slice(0, display.namesLimit).map((item) => item.person)}
                      fields={personalFields}
                      workflow={workflow ?? {}}
                      onAction={onPersonAction}
                      busy={busy}
                      showNames={showNames}
                      hideEmpty={display.hideEmpty}
                    />
                  ) : (
                    <div
                      className={s.peopleReadScroll}
                      tabIndex={0}
                      role="region"
                      aria-label={`Личные сведения: ${arrival.dorm}`}
                    >
                      <table className={s.peopleReadTable}>
                        <thead>
                          <tr>
                            <th scope="col">{showNames ? 'ФИО' : 'Человек'}</th>
                            {personalFields.map((field) => (
                              <th scope="col" key={field.id}>
                                {field.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {people.slice(0, display.namesLimit).map(({ person, index }) => (
                            <tr key={person.id}>
                              <th scope="row">
                                {showNames
                                  ? person.name.trim() || `Человек ${index + 1} — ФИО не указано`
                                  : `№ ${index + 1}`}
                              </th>
                              {personalFields.map((field) => (
                                <td key={field.id}>
                                  {display.hideEmpty && isEmpty(person.values[field.id])
                                    ? '—'
                                    : printable(field, person.values[field.id])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {people.length > display.namesLimit && (
                    <small>Ещё {people.length - display.namesLimit} — в записи заезда</small>
                  )}
                  {Number(arrival.count) > names.length && (
                    <small>Без ФИО: {Number(arrival.count) - names.length} чел.</small>
                  )}
                </>
              ) : (
                <p>ФИО не указаны</p>
              )}
            </div>
          );
        }
        const field = fields.find((item) => item.id === id);
        if (
          !field ||
          field.scope === 'person' ||
          !display.visible.includes(id) ||
          (display.hideEmpty && isEmpty(arrival.values[id]))
        )
          return null;
        return (
          <div key={id} className={s.detailRow}>
            <span>{field.label}</span>
            <strong
              className={
                field.type === 'checkbox' && arrival.values[id] === true ? s.positive : undefined
              }
            >
              {field.type === 'checkbox' && arrival.values[id] === true ? '✓ ' : ''}
              {printable(field, arrival.values[id])}
            </strong>
          </div>
        );
      })}
      {(onEdit || onOpen) && (
        <div className={s.cardActions}>
          {onOpen && (
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              aria-label={`Полная информация о заезде: ${arrival.dorm}`}
              aria-haspopup="dialog"
              onClick={onOpen}
            >
              Полная информация
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              aria-label={editLabel}
              onClick={onEdit}
            >
              Изменить заезд
            </button>
          )}
        </div>
      )}
    </article>
  );
}
