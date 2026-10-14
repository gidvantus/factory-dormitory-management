import { useEffect, useState } from 'react';
import { ApiError, waitForDormitoryWrites } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type {
  IdentityCheck,
  IdentityChoice,
  IdentityFields,
  SourceTable,
} from '../../api/personnel';
import { Modal } from '../../components/Modal';
import s from './Personnel.module.css';

export function IdentityDialog({
  dormitoryId,
  tableKey,
  rowId,
  initial,
  selectedEmployeeId,
  values = {},
  onClose,
  onSaved,
}: {
  dormitoryId: string;
  tableKey: SourceTable;
  rowId?: number;
  initial?: Partial<IdentityFields>;
  selectedEmployeeId?: string;
  values?: Record<string, unknown>;
  onClose: () => void;
  onSaved: (id: string) => void;
}): JSX.Element {
  const omitPersonnelNumber =
    rowId === undefined && (tableKey === 'residents' || tableKey === 'inflow');
  const [fields, setFields] = useState<IdentityFields>({
    full_name: initial?.full_name ?? null,
    personnel_number: omitPersonnelNumber ? null : (initial?.personnel_number ?? null),
    phone: initial?.phone ?? null,
  });
  const [checked, setChecked] = useState<IdentityCheck | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedEmployeeId ?? null);
  const mode = selected ? 'existing' : 'new';
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setChecked(null);
    setChecking(true);
    setError('');
    const timer = window.setTimeout(() => {
      void personnelApi
        .check(fields, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setChecked(result);
            setChecking(false);
          }
        })
        .catch((caught) => {
          if (!controller.signal.aborted) {
            setError(
              caught instanceof ApiError ? caught.message : 'Не удалось проверить совпадения.',
            );
            setChecking(false);
          }
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fields, attempt]);
  async function save(): Promise<void> {
    if (!checked || busy) return;
    setBusy(true);
    setError('');
    try {
      await waitForDormitoryWrites(dormitoryId);
      const identity: IdentityChoice = {
        ...fields,
        mode,
        employee_id: mode === 'existing' ? selected : null,
        check_token: checked.check_token,
      };
      const result = rowId
        ? await personnelApi.link(Number(dormitoryId), tableKey, rowId, identity)
        : await personnelApi.createRecord(Number(dormitoryId), tableKey, identity, values);
      onSaved(result.employee_id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить сотрудника.');
      if (caught instanceof ApiError && caught.status === 409) setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={rowId ? 'Связать запись с сотрудником' : 'Добавить сотрудника'}
      testId="personnel-identity"
      onClose={onClose}
      closeDisabled={busy}
      panelClassName={s.modal}
    >
      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>
          Введите известные данные и проверьте, есть ли уже карточка этого человека. Исходные
          сведения в других общежитиях сохранятся.
        </p>
        <div className={s.formGrid}>
          {(
            [
              ['full_name', 'ФИО'],
              ['personnel_number', 'Табельный номер'],
              ['phone', 'Телефон'],
            ] as const
          )
            .filter(([field]) => !omitPersonnelNumber || field !== 'personnel_number')
            .map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  disabled={busy}
                  maxLength={field === 'full_name' ? 255 : field === 'phone' ? 30 : 40}
                  value={fields[field] ?? ''}
                  onChange={(event) => {
                    setChecked(null);
                    setFields({
                      ...fields,
                      [field]: event.target.value.trim() ? event.target.value : null,
                    });
                    if (!selectedEmployeeId) {
                      setSelected(null);
                    }
                  }}
                />
              </label>
            ))}
        </div>
        <section className={s.softCard} aria-label="Результаты проверки">
          <h3>Возможные совпадения</h3>
          {checking && <p role="status">Проверяем данные…</p>}
          {checked && !checked.candidates.length && (
            <p>Совпадений по известным данным не найдено.</p>
          )}
          {checked?.candidates.map((candidate) => (
            <label className={s.candidate} key={candidate.id}>
              <input
                type="radio"
                name="identity-choice"
                disabled={busy}
                checked={mode === 'existing' && selected === candidate.id}
                onChange={() => {
                  setSelected(candidate.id);
                }}
              />
              <span>
                <strong>{candidate.full_name ?? 'ФИО не указано'}</strong>
                <small>
                  Т/н {candidate.personnel_number ?? '—'} · {candidate.phone ?? 'телефон не указан'}
                </small>
                <small>{candidate.dormitories.join(' · ') || 'Есть карточка сотрудника'}</small>
                <small>{candidate.evidence.join(' · ')}</small>
                {candidate.differences.length > 0 && (
                  <small className={s.warning}>{candidate.differences.join(' · ')}</small>
                )}
              </span>
            </label>
          ))}
          {selected && (
            <button type="button" disabled={busy} onClick={() => setSelected(null)}>
              Снять выбор
            </button>
          )}
        </section>
        <p className={s.hint}>
          Если выберете человека из списка, запись продолжит историю его карточки. Если никого не
          выбрать, будет создан новый сотрудник.
        </p>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {!checked && !checking && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Повторить проверку
          </button>
        )}
        <div className={s.actions}>
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            className={s.primary}
            disabled={
              busy ||
              !checked ||
              (mode === 'existing' ? !selected : !Object.values(fields).some(Boolean))
            }
          >
            {busy
              ? 'Сохраняем…'
              : mode === 'existing'
                ? 'Использовать карточку'
                : 'Создать новую карточку'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
