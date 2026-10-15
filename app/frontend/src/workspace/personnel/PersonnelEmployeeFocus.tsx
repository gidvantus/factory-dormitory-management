import { useEffect, useRef, useState } from 'react';
import type { Employee, PersonnelData } from '../../api/personnel';
import resident from '../../assets/avatar-rezident.svg';
import { dateLabel, dayDiff, dormName, personName, value } from './helpers';
import { employeeFieldValues } from './employeeListFilters';
import type { EmployeeListField, ListCriteria } from './employeeListFilters';
import f from './PersonnelFocus.module.css';

export function PersonnelEmployeeFocus({
  people,
  rows,
  selected,
  onSelection,
  data,
  criteria,
  fields,
  onPerson,
}: {
  people: Employee[];
  rows: Employee[];
  selected: string[];
  onSelection: (ids: string[]) => void;
  data: PersonnelData;
  criteria: ListCriteria;
  fields: EmployeeListField[];
  onPerson: (id: string) => void;
}): JSX.Element {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listKey = people.map((person) => person.id).join('|');
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [listKey]);
  const focused = people.find((person) => person.id === focusedId) ?? people[0];
  const selectedCount = rows.filter((person) => selected.includes(person.id)).length;
  return (
    <div className={f.focusLayout}>
      <div className={f.employeeList}>
        <div className={f.tableScroll} ref={listRef}>
          <table className={f.employeeTable} aria-label="Список сотрудников">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label={`Выбрать весь список: ${rows.length}`}
                    checked={rows.length > 0 && selectedCount === rows.length}
                    aria-checked={
                      selectedCount > 0 && selectedCount < rows.length
                        ? 'mixed'
                        : rows.length > 0 && selectedCount === rows.length
                    }
                    ref={(input) => {
                      if (input)
                        input.indeterminate = selectedCount > 0 && selectedCount < rows.length;
                    }}
                    onChange={(event) =>
                      onSelection(
                        event.target.checked
                          ? [...new Set([...selected, ...rows.map((person) => person.id)])]
                          : selected.filter((id) => !rows.some((person) => person.id === id)),
                      )
                    }
                  />
                </th>
                <th>Сотрудник</th>
                <th>Проживание</th>
                {fields.map((field) => (
                  <th key={field.id}>{field.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id} data-active={focused?.id === person.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Выбрать сотрудника ${personName(person)}`}
                      checked={selected.includes(person.id)}
                      onChange={(event) =>
                        onSelection(
                          event.target.checked
                            ? [...new Set([...selected, person.id])]
                            : selected.filter((id) => id !== person.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={f.employeeName}
                      aria-pressed={focused?.id === person.id}
                      onClick={() => setFocusedId(person.id)}
                    >
                      <span className={f.initials} aria-hidden="true">
                        {personName(person)
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((part) => part[0])
                          .join('')}
                      </span>
                      <span>
                        {personName(person)}
                        <small>Т/н {person.personnel_number ?? '—'}</small>
                      </span>
                    </button>
                  </td>
                  <td data-label="Проживание">
                    {person.current.length ? (
                      person.current.map((source) => (
                        <div key={`${source.table_key}:${source.row_id}`}>
                          {dormName(data, source.dormitory_id)}
                          <small>{value(source, 'hostel_name') || 'Место не указано'}</small>
                        </div>
                      ))
                    ) : (
                      <span className={f.muted}>Сейчас не проживает</span>
                    )}
                  </td>
                  {fields.map((field) => (
                    <td key={field.id} data-label={field.label}>
                      {employeeFieldValues(person, field, data, criteria).join(' · ') || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!people.length && <p className={f.empty}>Сотрудников по выбранным условиям нет.</p>}
      </div>
      <aside className={f.profile} aria-label="Выбранный сотрудник">
        {focused ? (
          <>
            <img className={f.portrait} src={resident} alt="" />
            <span className={f.kicker}>КАРТОЧКА СОТРУДНИКА</span>
            <h3>{personName(focused)}</h3>
            <span className={f.status} data-current={!!focused.current.length}>
              {focused.current.length ? 'Проживает' : 'Вне общежитий'}
            </span>
            <dl className={f.details}>
              <div>
                <dt>Табельный номер</dt>
                <dd>{focused.personnel_number ?? 'Не указан'}</dd>
              </div>
              <div>
                <dt>Телефон</dt>
                <dd>{focused.phone ?? 'Не указан'}</dd>
              </div>
            </dl>
            {focused.current.map((source) => {
              const start = value(source, 'shift_start');
              const end = value(source, 'shift_end');
              const duration = dayDiff(start, end);
              const elapsed = dayDiff(start, data.today);
              const remaining = dayDiff(data.today, end);
              const progress =
                duration > 0 && Number.isFinite(elapsed)
                  ? Math.max(0, Math.min(100, Math.round((elapsed / duration) * 100)))
                  : null;
              return (
                <div key={`${source.table_key}:${source.row_id}`} className={f.stay}>
                  <strong>{dormName(data, source.dormitory_id)}</strong>
                  <span>{value(source, 'hostel_name') || 'Место не указано'}</span>
                  <div className={f.shiftLabel}>
                    <span>Вахта</span>
                    <b>
                      {dateLabel(start)} — {dateLabel(end)}
                    </b>
                  </div>
                  {progress !== null && (
                    <progress
                      max={100}
                      value={progress}
                      aria-label={`Прошло вахты: ${dormName(data, source.dormitory_id)}`}
                    />
                  )}
                  {end && Number.isFinite(remaining) && (
                    <small>
                      {remaining < 0
                        ? 'Дата окончания вахты прошла'
                        : remaining === 0
                          ? 'Вахта заканчивается сегодня'
                          : `До окончания: ${remaining} дн.`}
                    </small>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              className="btn btn--primary btn--compact"
              onClick={() => onPerson(focused.id)}
            >
              Открыть полную карточку
            </button>
          </>
        ) : (
          <div className={f.empty}>
            <img className={f.portrait} src={resident} alt="" />
            <p>Здесь появится карточка сотрудника из списка.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
