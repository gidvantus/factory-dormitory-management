import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { formatDate } from '../dashboard/dates';
import { useColumns } from './tableColumnsContext';

export function CustomDayCell({
  tabId,
  rowId,
  day,
  initial,
  readOnly,
}: {
  tabId: number;
  rowId: number;
  day: string;
  initial: string;
  readOnly: boolean;
}): JSX.Element {
  const { dormitoryId, trackSave } = useColumns();
  const [draft, setDraft] = useState(initial);
  const [committed, setCommitted] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(): Promise<void> {
    if (saving || readOnly) return;
    const key = `${rowId}:day:${day}`;
    if (draft === committed) {
      await trackSave(key, Promise.resolve());
      setError('');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await trackSave(key, api.saveCustomDay(dormitoryId, tabId, rowId, day, draft));
      setDraft(result.value);
      setCommitted(result.value);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить значение.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <td>
      <input
        aria-label={`${formatDate(day)}, строка ${rowId}`}
        value={draft}
        maxLength={2000}
        disabled={readOnly || saving}
        aria-busy={saving}
        aria-invalid={!!error}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {error && (
        <small role="alert">
          {error}{' '}
          <button type="button" onClick={() => void save()}>
            Повторить
          </button>
        </small>
      )}
    </td>
  );
}
