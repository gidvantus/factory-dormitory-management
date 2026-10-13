import { useEffect, useState } from 'react';
import { personnelApi } from '../../api/personnel';
import type { Binding, SourceTable } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { message } from './helpers';
import s from './Personnel.module.css';

const roles = {
  full_name: 'ФИО',
  personnel_number: 'Табельный номер',
  phone: 'Телефон',
  shift_start: 'Начало вахты',
  shift_end: 'Окончание вахты',
  reason: 'Причина / статус',
};
export function PersonnelBindingButton({
  dormitoryId,
  tableKey,
  onSaved,
}: {
  dormitoryId: string;
  tableKey: SourceTable;
  onSaved: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn--ghost btn--compact" onClick={() => setOpen(true)}>
        Связь с персоналом
      </button>
      {open && (
        <BindingDialog
          dormitoryId={dormitoryId}
          tableKey={tableKey}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            onSaved();
          }}
        />
      )}
    </>
  );
}
function BindingDialog({
  dormitoryId,
  tableKey,
  onClose,
  onSaved,
}: {
  dormitoryId: string;
  tableKey: SourceTable;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [data, setData] = useState<Binding | null>(null);
  const [fields, setFields] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void personnelApi
      .binding(dormitoryId, tableKey)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setFields(result.fields);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(message(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [dormitoryId, tableKey]);
  return (
    <Modal
      title="Связь таблицы с персоналом"
      testId="personnel-binding"
      onClose={onClose}
      closeDisabled={busy}
      panelClassName={s.modal}
    >
      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void personnelApi
            .saveBinding(dormitoryId, tableKey, fields)
            .then(onSaved)
            .catch((caught) => setError(message(caught)))
            .finally(() => setBusy(false));
        }}
      >
        <p>
          Укажите назначение столбцов. Связь сохранится при их переименовании. Существующие
          заполненные строки получат отдельные карточки со статусом «Требует проверки»; совпадения
          объединяются вручную.
        </p>
        {!data && !error && <p role="status">Загружаем столбцы…</p>}
        {data && (
          <div className={s.formGrid}>
            {Object.entries(roles).map(([role, title]) => (
              <label key={role}>
                {title}
                <select
                  disabled={busy}
                  value={fields[role] ?? ''}
                  onChange={(event) => {
                    const next = { ...fields };
                    if (event.target.value) next[role] = Number(event.target.value);
                    else delete next[role];
                    setFields(next);
                  }}
                >
                  <option value="">Не использовать</option>
                  {data.columns
                    .filter(
                      (col) =>
                        !col.builtin_key &&
                        (role.startsWith('shift_')
                          ? col.kind === 'date'
                          : role === 'personnel_number'
                            ? ['text', 'number'].includes(col.kind)
                            : col.kind === 'text'),
                    )
                    .map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.actions}>
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button className={s.primary} disabled={busy || !data}>
            {busy ? 'Сохраняем…' : 'Сохранить связь'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
