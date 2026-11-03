import { useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { personName } from '../../workspace/personnel/helpers';
import type { Column, RecordRow } from './model';
import s from './Tabs.module.css';

export function RecordEditor({
  row,
  columns,
  data,
  onSave,
  onClose,
}: {
  row: RecordRow;
  columns: Column[];
  data: PersonnelData;
  onSave: (row: RecordRow) => void;
  onClose: () => void;
}): JSX.Element {
  const [values, setValues] = useState(row.values);
  const [error, setError] = useState('');
  return (
    <Modal
      title={row.id ? 'Изменить запись' : 'Добавить запись'}
      testId="tab-record-editor"
      onClose={onClose}
      dirty={JSON.stringify(values) !== JSON.stringify(row.values)}
      panelClassName={s.recordModal}
    >
      <form
        className={s.recordForm}
        onSubmit={(event) => {
          event.preventDefault();
          const missing = columns.find(
            (column) =>
              column.required &&
              (column.kind === 'checkbox'
                ? values[column.id] !== true
                : !String(values[column.id] ?? '').trim()),
          );
          if (missing) {
            setError(`Заполните поле «${missing.name}».`);
            return;
          }
          onSave({ id: row.id || crypto.randomUUID(), values });
        }}
      >
        {columns.map((column) => (
          <label key={column.id} className={column.kind === 'checkbox' ? s.check : undefined}>
            {column.kind !== 'checkbox' && (
              <span>
                {column.name}
                {column.required ? ' *' : ''}
              </span>
            )}
            {column.kind === 'employee' ? (
              <select
                required={column.required}
                value={
                  data.employees.find(
                    (person) =>
                      person.id === values[column.id] ||
                      person.member_ids.includes(String(values[column.id])),
                  )?.id ?? String(values[column.id] ?? '')
                }
                onChange={(event) => setValues({ ...values, [column.id]: event.target.value })}
              >
                <option value="">Выберите сотрудника</option>
                {data.employees.map((person) => (
                  <option key={person.id} value={person.id}>
                    {personName(person)} · № {person.personnel_number}
                  </option>
                ))}
              </select>
            ) : column.kind === 'select' ? (
              <select
                required={column.required}
                value={String(values[column.id] ?? '')}
                onChange={(event) => setValues({ ...values, [column.id]: event.target.value })}
              >
                <option value="">Не выбрано</option>
                {values[column.id] && !column.options.includes(String(values[column.id])) && (
                  <option value={String(values[column.id])}>{String(values[column.id])}</option>
                )}
                {column.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : column.kind === 'checkbox' ? (
              <>
                <input
                  type="checkbox"
                  checked={values[column.id] === true}
                  onChange={(event) => setValues({ ...values, [column.id]: event.target.checked })}
                />
                {column.name}
                {column.required ? ' *' : ''}
              </>
            ) : (
              <input
                required={column.required}
                type={
                  column.kind === 'number' ? 'number' : column.kind === 'date' ? 'date' : 'text'
                }
                step={column.kind === 'number' ? 'any' : undefined}
                maxLength={500}
                value={String(values[column.id] ?? '')}
                onChange={(event) => setValues({ ...values, [column.id]: event.target.value })}
              />
            )}
          </label>
        ))}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <ModalCancelButton className="btn btn--ghost btn--compact" onClick={onClose}>
            Отмена
          </ModalCancelButton>
          <button type="submit" className="btn btn--primary btn--compact">
            Сохранить запись
          </button>
        </div>
      </form>
    </Modal>
  );
}
