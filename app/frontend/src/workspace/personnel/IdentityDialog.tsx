import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, waitForDormitoryWrites } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import type {
  IdentityCheck,
  IdentityChoice,
  IdentityFields,
  SourceTable,
} from '../../api/personnel';
import { Modal, ModalCancelButton } from '../../components/Modal';
import s from './Personnel.module.css';
import { EntryColumnSettings } from './EntryColumnSettings';
import type { EntryColumnState } from './EntryColumnSettings';

export function IdentityDialog({
  dormitoryId,
  tableKey,
  rowId,
  initial,
  values = {},
  onClose,
  onSaved,
  title,
  renderFields,
  saveRecord,
  panelClassName,
  submitLabel,
  onEntryColumnsSaved,
}: {
  dormitoryId: string;
  tableKey: SourceTable;
  rowId?: number;
  initial?: Partial<IdentityFields>;
  values?: Record<string, unknown>;
  onClose: () => void;
  onSaved: (id: string) => void;
  title?: string;
  renderFields?: (
    fields: IdentityFields,
    busy: boolean,
    onChange: (field: keyof IdentityFields, value: string | null) => void,
  ) => ReactNode;
  saveRecord?: (identity: IdentityChoice) => Promise<string>;
  panelClassName?: string;
  submitLabel?: string;
  onEntryColumnsSaved?: () => void;
}): JSX.Element {
  const omitPersonnelNumber =
    rowId === undefined && (tableKey === 'residents' || tableKey === 'inflow');
  const [fields, setFields] = useState<IdentityFields>({
    full_name: initial?.full_name ?? null,
    personnel_number: omitPersonnelNumber ? null : (initial?.personnel_number ?? null),
    phone: initial?.phone ?? null,
  });
  const [checked, setChecked] = useState<IdentityCheck | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const mode = selected ? 'existing' : 'new';
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const entrySettings = rowId === undefined && tableKey === 'residents' && !saveRecord;
  const [entryColumns, setEntryColumns] = useState<EntryColumnState>({
    ready: false,
    fields: {},
    saving: false,
    dirty: false,
  });
  const formBusy = busy || (entrySettings && entryColumns.saving);
  const candidate = checked?.candidates.find((item) => item.id === selected);
  const entryIdentity: IdentityFields = {
    ...fields,
    full_name: fields.full_name || candidate?.full_name || null,
    phone: fields.phone || candidate?.phone || null,
  };
  function changeIdentity(field: keyof IdentityFields, value: string | null): void {
    setError('');
    setChecked(null);
    setFields((current) => ({ ...current, [field]: value?.trim() ? value : null }));
    setSelected(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    setChecked(null);
    setChecking(true);
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
    if (!checked || busy || (entrySettings && !entryColumns.ready)) return;
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
      const employeeId =
        saveRecord && !rowId
          ? await saveRecord(identity)
          : (
              await (rowId
                ? personnelApi.link(Number(dormitoryId), tableKey, rowId, identity)
                : entrySettings
                  ? personnelApi.createRecord(
                      Number(dormitoryId),
                      tableKey,
                      identity,
                      values,
                      entryColumns.fields,
                    )
                  : personnelApi.createRecord(Number(dormitoryId), tableKey, identity, values))
            ).employee_id;
      onSaved(employeeId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить сотрудника.');
      if (caught instanceof ApiError && caught.status === 409) setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title ?? (rowId ? 'Связать запись с сотрудником' : 'Добавить сотрудника')}
      testId="personnel-identity"
      onClose={onClose}
      closeDisabled={formBusy}
      dirty={
        entrySettings
          ? entryColumns.dirty ||
            !!selected ||
            (Object.keys(fields) as (keyof IdentityFields)[]).some(
              (role) => fields[role] !== (initial?.[role] ?? null),
            )
          : undefined
      }
      panelClassName={`${s.modal} ${panelClassName ?? ''}`}
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
        {renderFields ? (
          renderFields(fields, formBusy, changeIdentity)
        ) : (
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
                    disabled={formBusy}
                    maxLength={field === 'full_name' ? 255 : field === 'phone' ? 30 : 40}
                    value={fields[field] ?? ''}
                    onChange={(event) => changeIdentity(field, event.target.value)}
                  />
                </label>
              ))}
          </div>
        )}
        {entrySettings && (
          <EntryColumnSettings
            reloadKey={attempt}
            dormitoryId={dormitoryId}
            identity={entryIdentity}
            disabled={busy}
            onChange={setEntryColumns}
            onSaved={onEntryColumnsSaved}
          />
        )}
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
                disabled={formBusy}
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
          <ModalCancelButton onClick={onClose} type="button" disabled={formBusy}>
            Отмена
          </ModalCancelButton>
          <button
            className={s.primary}
            disabled={
              formBusy ||
              !checked ||
              (entrySettings && !entryColumns.ready) ||
              (mode === 'existing' ? !selected : !Object.values(fields).some(Boolean))
            }
          >
            {busy
              ? 'Сохраняем…'
              : (submitLabel ??
                (mode === 'existing' ? 'Использовать карточку' : 'Создать новую карточку'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}
