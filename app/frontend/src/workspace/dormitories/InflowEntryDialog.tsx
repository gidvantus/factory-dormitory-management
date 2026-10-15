import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { CellValue, InflowEntryForm } from '../../api/client';
import type { IdentityChoice } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { IdentityDialog } from '../personnel/IdentityDialog';
import { identityKey } from './entryIdentity';
import { ResidentEntryFields } from './ResidentEntryFields';
import styles from './ResidentEntryFields.module.css';

export function InflowEntryDialog({
  dormitoryId,
  month,
  onClose,
  onSaved,
}: {
  dormitoryId: string;
  month: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [form, setForm] = useState<InflowEntryForm | null>(null);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .inflowEntryForm(dormitoryId, month, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setForm(result);
          setError('');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить форму.');
      });
    return () => controller.abort();
  }, [dormitoryId, month, attempt]);

  async function save(identity: IdentityChoice): Promise<string> {
    if (!form) throw new Error('Форма ещё загружается');
    const cells = Object.fromEntries(
      form.columns.map((column) => {
        const field = identityKey(column.builtin_key);
        return [
          String(column.id),
          field
            ? identity[field]
            : (values[String(column.id)] ?? (column.kind === 'checkbox' ? false : null)),
        ];
      }),
    );
    try {
      const result = await api.createInflowEntry(dormitoryId, {
        identity,
        month: form.month,
        schema_token: form.schema_token,
        values: cells,
      });
      return result.employee_id!;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const updated = await api.inflowEntryForm(dormitoryId, month);
        setValues((current) =>
          Object.fromEntries(
            updated.columns
              .filter((column) =>
                form.columns.some((old) => old.id === column.id && old.kind === column.kind),
              )
              .map((column) => [String(column.id), current[String(column.id)] ?? null]),
          ),
        );
        setForm(updated);
      }
      throw caught;
    }
  }

  if (!form)
    return (
      <Modal title="Добавить в приток" testId="inflow-entry-loading" onClose={onClose}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </button>
          </>
        ) : (
          <p role="status">Загружаем поля…</p>
        )}
      </Modal>
    );

  return (
    <IdentityDialog
      dormitoryId={dormitoryId}
      tableKey="inflow"
      title="Добавить в приток"
      panelClassName={styles.panel}
      onClose={onClose}
      onSaved={onSaved}
      saveRecord={save}
      renderFields={(identity, disabled, onIdentity) => (
        <ResidentEntryFields
          form={form}
          values={values}
          identity={identity}
          disabled={disabled}
          onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
          onIdentity={onIdentity}
        />
      )}
    />
  );
}
