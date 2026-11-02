import { FieldControl } from './ArrivalFields';
import type { Field, Person } from './data';
import { PEOPLE_PAGE_SIZE } from './data';
import s from './Arrivals.module.css';

export function PeopleEditor({
  people,
  count,
  fields,
  page,
  onPage,
  onChange,
}: {
  people: Person[];
  count: number;
  fields: Field[];
  page: number;
  onPage: (page: number) => void;
  onChange: (index: number, person: Person) => void;
}): JSX.Element {
  const pages = Math.max(1, Math.ceil(count / PEOPLE_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const offset = currentPage * PEOPLE_PAGE_SIZE;
  const end = Math.min(count, offset + PEOPLE_PAGE_SIZE);
  return (
    <section className={s.peopleEditor} aria-label="Приезжающие">
      <div className={s.sectionHeading}>
        <div>
          <h3>Приезжающие</h3>
          <p className={s.muted}>Отдельная строка на человека. ФИО можно заполнить позже.</p>
        </div>
        <span className={s.peopleCount}>Строк: {count}</span>
      </div>
      {count ? (
        <div
          className={s.peopleEditScroll}
          role="region"
          aria-label="ФИО и поля каждого человека"
          tabIndex={0}
        >
          <table className={s.peopleEditTable}>
            <thead>
              <tr>
                <th scope="col">№</th>
                <th scope="col">ФИО</th>
                {fields.map((field) => (
                  <th scope="col" key={field.id}>
                    {field.label}
                    {field.required && <span className={s.required}> *</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.slice(offset, end).map((person, index) => {
                const number = offset + index;
                return (
                  <tr
                    key={person.id}
                    data-testid="arrival-person-row"
                    data-person-number={number + 1}
                  >
                    <th scope="row">{number + 1}</th>
                    <td>
                      <input
                        className={s.personNameInput}
                        aria-label={`ФИО, человек ${number + 1}`}
                        autoComplete="off"
                        maxLength={255}
                        placeholder="Фамилия Имя Отчество"
                        value={person.name}
                        onChange={(e) => onChange(number, { ...person, name: e.target.value })}
                      />
                    </td>
                    {fields.map((field) => (
                      <td key={field.id}>
                        <FieldControl
                          compact
                          field={field}
                          accessibleLabel={`${field.label}, человек ${number + 1}`}
                          value={person.values[field.id]}
                          onChange={(value) =>
                            onChange(number, {
                              ...person,
                              values: { ...person.values, [field.id]: value },
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={s.empty}>Укажите целое количество человек от 1 до 10 000.</p>
      )}
      {pages > 1 && (
        <div className={s.peoplePagination}>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={currentPage === 0}
            onClick={() => onPage(currentPage - 1)}
          >
            Назад
          </button>
          <span>
            Строки {offset + 1}–{end} из {count}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={currentPage === pages - 1}
            onClick={() => onPage(currentPage + 1)}
          >
            Далее
          </button>
        </div>
      )}
      {!fields.length && (
        <p className={s.previewNote}>
          В «Настроить поля» выберите для нужного поля «Напротив каждого ФИО», чтобы добавить
          столбец в этот список.
        </p>
      )}
    </section>
  );
}
