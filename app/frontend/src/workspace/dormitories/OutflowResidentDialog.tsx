import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { api, ApiError } from '../../api/client';
import type { Resident } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './TransferResidentDialog.module.css';

export function OutflowResidentDialog({
  dormitoryId,
  resident,
  trigger,
  onClose,
  onMoved,
}: {
  dormitoryId: string;
  resident: Resident;
  trigger: HTMLButtonElement;
  onClose: () => void;
  onMoved: (residentId: number) => void;
}): JSX.Element {
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  useEffect(() => {
    const controller = new AbortController();
    setPreviewToken(null);
    setChecking(true);
    void api
      .previewResidentOutflow(dormitoryId, resident.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreviewToken(result.preview_token);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось подготовить перенос.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [dormitoryId, resident.id, attempt]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current || !previewToken || checking) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      await api.moveResidentToOutflow(dormitoryId, resident.id, previewToken, true);
      onMoved(resident.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось перенести в отток.');
      if (caught instanceof ApiError && caught.status === 409) {
        setError('Данные изменились. Подтвердите перенос ещё раз.');
        setPreviewToken(null);
        setAttempt((value) => value + 1);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <Modal
      title="Перенести в отток"
      testId="outflow-resident-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)} aria-busy={saving}>
        <p>
          Перенести {resident.full_name ? `«${resident.full_name}»` : `строку № ${resident.id}`} в
          «Отток»? Проживающий будет удалён из «Проживающих» и списков аванса и расчёта этого
          общежития.
        </p>
        {checking && <p role="status">Подготавливаем перенос…</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {!previewToken && !checking && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Повторить
          </button>
        )}
        <div className={styles.actions}>
          <button type="button" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={saving || checking || !previewToken}>
            {saving ? 'Переносим…' : 'Перенести в отток'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
