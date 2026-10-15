import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { OutflowRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './OutflowTable.module.css';

export function OutflowEvictionDialog({
  dormitoryId,
  row,
  onClose,
  onEvicted,
}: {
  dormitoryId: string;
  row: OutflowRow;
  onClose: () => void;
  onEvicted: (row: OutflowRow) => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setToken('');
    void api
      .previewOutflowEviction(dormitoryId, row.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setToken(result.preview_token);
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось подготовить выселение.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [dormitoryId, row.id, attempt]);

  async function submit(): Promise<void> {
    if (!token || checking || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      onEvicted(await api.evictOutflowEmployee(dormitoryId, row.id, token));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось выселить сотрудника.');
      if (caught instanceof ApiError && caught.status === 409) setAttempt((value) => value + 1);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Выселение сотрудника"
      testId="outflow-eviction-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <p>
        Выселить{' '}
        {row.full_name?.trim() ? `сотрудника «${row.full_name.trim()}»` : 'этого сотрудника'}?
      </p>
      <p>
        Сотрудник будет удалён из «Проживающих» и связанных списков аванса и расчёта этого
        общежития.
      </p>
      {checking && <p role="status">Подготавливаем выселение…</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!checking && !token && (
        <button
          type="button"
          onClick={() => {
            setError('');
            setAttempt((value) => value + 1);
          }}
        >
          Повторить проверку
        </button>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          disabled={saving}
          onClick={onClose}
        >
          Отмена
        </button>
        <button
          type="button"
          className="btn btn--danger btn--compact"
          disabled={checking || saving || !token}
          aria-busy={saving}
          onClick={() => void submit()}
        >
          {saving ? 'Сохраняем…' : 'Подтвердить'}
        </button>
      </div>
    </Modal>
  );
}
