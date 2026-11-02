import { useState } from 'react';
import { Modal, ModalCancelButton } from '../../../components/Modal';
import { dateLabel } from '../helpers';
import type { Arrival, Field, Value } from './data';
import { PEOPLE_PAGE_SIZE, isEmpty, namesOf, personCount, printable } from './data';
import s from './Arrivals.module.css';
import type { ArrivalVisit } from '../../../api/personnel';
import { WorkflowPeople } from './WorkflowPeople';
import type { WorkflowActionHandler } from './WorkflowPeople';

function isFilled(value: Value | undefined): boolean {
  return !isEmpty(value) && (typeof value !== 'string' || !!value.trim());
}

export function ArrivalDetailsDialog({
  arrival,
  fields,
  onClose,
  onEdit,
  workflow,
  onPersonAction,
  busy,
  error,
  readOnly = false,
}: {
  arrival: Arrival;
  fields: Field[];
  onClose: () => void;
  onEdit: () => void;
  workflow?: Record<string, ArrivalVisit>;
  onPersonAction?: WorkflowActionHandler;
  busy?: boolean;
  error?: string;
  readOnly?: boolean;
}): JSX.Element {
  const [page, setPage] = useState(0);
  const count = personCount(arrival.count);
  const allPeople = arrival.people.slice(0, count);
  const sharedFields = fields.filter(
    (field) => field.scope === 'arrival' && isFilled(arrival.values[field.id]),
  );
  const personalFields = fields.filter(
    (field) =>
      field.scope === 'person' && allPeople.some((person) => isFilled(person.values[field.id])),
  );
  const people = allPeople
    .map((person, index) => ({ person, index }))
    .filter(
      ({ person }) =>
        !!person.name.trim() || personalFields.some((field) => isFilled(person.values[field.id])),
    );
  const pages = Math.max(1, Math.ceil(people.length / PEOPLE_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const offset = currentPage * PEOPLE_PAGE_SIZE;
  const end = Math.min(people.length, offset + PEOPLE_PAGE_SIZE);

  return (
    <Modal
      title="Информация о заезде"
      testId="arrival-details-dialog"
      onClose={onClose}
      closeDisabled={busy}
      initialFocus="panel"
      panelClassName={`${s.dialog} ${s.arrivalDialog}`}
    >
      <p className={s.muted}>Все заполненные поля, включая скрытые в кратком блоке справа.</p>
      {readOnly && (
        <p className={s.muted}>Общежитие в архиве. История заезда доступна для просмотра.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <dl className={s.fullSummary}>
        <div>
          <dt>Общежитие</dt>
          <dd>{arrival.dorm}</dd>
        </div>
        <div>
          <dt>Дата заезда</dt>
          <dd>{dateLabel(arrival.date, true)}</dd>
        </div>
        <div>
          <dt>Количество человек</dt>
          <dd>{arrival.count} чел.</dd>
        </div>
      </dl>
      {sharedFields.length > 0 && (
        <section className={s.fullSection} aria-label="Общие сведения о заезде">
          <h3>Общие сведения о заезде</h3>
          <dl className={s.fullFields}>
            {sharedFields.map((field) => (
              <div key={field.id}>
                <dt>{field.label}</dt>
                <dd
                  className={
                    field.type === 'checkbox' && arrival.values[field.id] === true
                      ? s.positive
                      : undefined
                  }
                >
                  {printable(field, arrival.values[field.id])}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section className={s.fullSection} aria-label="Все сведения о приезжающих">
        <div className={s.sectionHeading}>
          <h3>Приезжающие</h3>
          <span className={s.muted}>
            ФИО указаны: {namesOf(arrival).length} из {count}
          </span>
        </div>
        {people.length ? (
          onPersonAction ? (
            <WorkflowPeople
              people={people.slice(offset, end).map((item) => item.person)}
              fields={personalFields}
              workflow={workflow ?? {}}
              onAction={onPersonAction}
              busy={busy || readOnly}
              full
            />
          ) : (
            <div
              className={`${s.peopleReadScroll} ${s.fullPeopleScroll}`}
              tabIndex={0}
              role="region"
              aria-label="Все заполненные личные поля"
            >
              <table className={`${s.peopleReadTable} ${s.fullPeopleTable}`}>
                <thead>
                  <tr>
                    <th scope="col">ФИО</th>
                    {personalFields.map((field) => (
                      <th scope="col" key={field.id}>
                        {field.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people.slice(offset, end).map(({ person, index }) => (
                    <tr key={person.id}>
                      <th scope="row">
                        {person.name.trim() || `Человек ${index + 1} — ФИО не указано`}
                      </th>
                      {personalFields.map((field) => (
                        <td key={field.id}>
                          {isFilled(person.values[field.id])
                            ? printable(field, person.values[field.id])
                            : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p className={s.empty}>ФИО и личные поля пока не заполнены.</p>
        )}
        {pages > 1 && (
          <div className={s.peoplePagination}>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Назад
            </button>
            <span>
              Записи {offset + 1}–{end} из {people.length}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={currentPage === pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              Далее
            </button>
          </div>
        )}
        {count > people.length && (
          <p className={s.previewNote}>
            Для остальных {count - people.length} чел. ФИО и личные поля ещё не заполнены.
          </p>
        )}
      </section>
      <div className={`dialog-actions ${s.dialogActions}`}>
        <ModalCancelButton onClick={onClose} type="button" className="btn btn--ghost btn--compact">
          Закрыть
        </ModalCancelButton>
        {!readOnly && (
          <button
            type="button"
            disabled={busy}
            className="btn btn--primary btn--compact"
            onClick={onEdit}
          >
            Изменить заезд
          </button>
        )}
      </div>
    </Modal>
  );
}
