import { useState } from 'react';
import { personnelApi } from '../../api/personnel';
import { downloadBlob } from '../../api/download';
import type { Employee, PersonnelData } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import type { EmployeeListField, ListCriteria } from './employeeListFilters';
import { employeeFieldValues } from './employeeListFilters';
import { dateLabel, dormName, personName, value, message } from './helpers';
import s from './Personnel.module.css';
import styles from './EmployeeList.module.css';

export function SelectedEmployeesDialog({
  people,
  data,
  criteria,
  fields,
  onPerson,
  onClose,
}: {
  people: Employee[];
  data: PersonnelData;
  criteria: ListCriteria;
  fields: EmployeeListField[];
  onPerson: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState('Выбранные сотрудники');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  async function exportList(): Promise<void> {
    if (exporting || !people.length) return;
    setExporting(true);
    setError('');
    try {
      const blob = await personnelApi.exportSelected(
        name.trim() || 'Выбранные сотрудники',
        people.map((person) => person.id),
        fields
          .filter((field) => field.columns?.length)
          .map((field) => field.columns!.map((column) => column.id)),
      );
      downloadBlob(blob, `Сотрудники-${data.today}.xlsx`);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setExporting(false);
    }
  }
  return (
    <Modal
      title="Список выбранных сотрудников"
      testId="personnel-selected-list"
      onClose={onClose}
      closeDisabled={exporting}
      panelClassName={`${s.modal} ${styles.selectedDialog}`}
    >
      <div className={styles.selectedToolbar}>
        <label>
          Название списка
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn--primary btn--compact"
          disabled={exporting || !people.length}
          onClick={() => void exportList()}
          aria-busy={exporting}
        >
          {exporting ? 'Выгружаем…' : 'Выгрузить'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className={s.tableScroll}>
        <table className={`${s.table} ${styles.selectedTable}`}>
          <caption className={styles.selectedTableCaption}>
            {name.trim() || 'Выбранные сотрудники'} · {people.length}
          </caption>
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Проживание</th>
              <th>Период вахты</th>
              <th>Статус</th>
              <th>Телефон</th>
              {fields.map((field) => (
                <th key={field.id}>{field.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id}>
                <td>
                  <button
                    className={s.name}
                    type="button"
                    onClick={() => {
                      onClose();
                      onPerson(person.id);
                    }}
                  >
                    {personName(person)}
                    <small>Т/н {person.personnel_number ?? '—'}</small>
                  </button>
                </td>
                <td>
                  {person.current.length
                    ? person.current.map((source) => (
                        <div key={source.row_id}>
                          {dormName(data, source.dormitory_id)}
                          <small>{value(source, 'hostel_name') || 'Место не указано'}</small>
                        </div>
                      ))
                    : 'Сейчас не проживает'}
                </td>
                <td>
                  {person.current.map((source) => (
                    <div key={source.row_id}>
                      {dateLabel(value(source, 'shift_start'))} —{' '}
                      {dateLabel(value(source, 'shift_end'))}
                    </div>
                  ))}
                </td>
                <td>
                  <span className={s.badge}>
                    {person.current.length ? 'Проживает' : 'Вне общежитий'}
                  </span>
                </td>
                <td>{person.phone ?? 'Не указан'}</td>
                {fields.map((field) => (
                  <td key={field.id}>
                    {employeeFieldValues(person, field, data, criteria).join(' · ') || '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!people.length && <p className={s.empty}>В списке больше нет доступных сотрудников.</p>}
      <p className={styles.hint}>
        В список включены все отмеченные сотрудники, в том числе выбранные при других фильтрах.
      </p>
    </Modal>
  );
}
