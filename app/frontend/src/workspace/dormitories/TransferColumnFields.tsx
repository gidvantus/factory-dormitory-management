import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { TransferColumnChoice, TransferColumnRoute } from '../../api/client';
import styles from './TransferResidentDialog.module.css';

export function TransferColumnFields({
  dormitoryId,
  route,
  choices,
  disabled,
  settings = false,
  onBusy,
  onSaved,
}: {
  dormitoryId: string;
  route: TransferColumnRoute;
  choices: TransferColumnChoice[];
  disabled: boolean;
  settings?: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Record<number, number | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(): Promise<void> {
    setSaving(true);
    onBusy(true);
    setError('');
    try {
      await api.saveTransferColumns(dormitoryId, route, draft);
      setDraft({});
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить соответствия.');
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }

  return (
    <fieldset className={styles.columnMappings} disabled={disabled || saving}>
      <legend>{settings ? 'Соответствия' : 'Куда перенести данные'}</legend>
      <small>Сохранённый выбор применяется при следующих переносах.</small>
      {choices.map(({ source, targets, target_id }) => {
        const selected = source.id in draft ? draft[source.id] : target_id;
        return (
          <label className={styles.field} key={source.id}>
            <span>{source.name}</span>
            <select
              aria-label={`Столбец назначения для «${source.name}»`}
              value={selected ?? ''}
              onChange={(event) => {
                const value = event.target.value ? Number(event.target.value) : null;
                setDraft((previous) => {
                  const next = { ...previous };
                  if (value === target_id) delete next[source.id];
                  else next[source.id] = value;
                  return next;
                });
              }}
            >
              <option value="">
                {settings ? 'Сопоставлять автоматически' : 'Выберите столбец'}
              </option>
              {selected !== null && !targets.some((target) => target.id === selected) && (
                <option value={selected} disabled>
                  Столбец недоступен
                </option>
              )}
              {targets.map((target) => (
                <option
                  key={target.id}
                  value={target.id}
                  disabled={Object.entries(draft).some(
                    ([id, value]) => Number(id) !== source.id && value === target.id,
                  )}
                >
                  {target.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn--outline btn--compact"
        disabled={!Object.keys(draft).length}
        onClick={() => void save()}
      >
        {saving ? 'Сохраняем…' : 'Сохранить соответствия'}
      </button>
    </fieldset>
  );
}
