import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../api/client';
import type { InflowAction, InflowActionPreview, InflowRow } from '../../api/client';
import { Modal } from '../../components/Modal';
import { todayDate } from '../dashboard/dates';
import { OutflowTransferFields } from './OutflowTransferFields';
import styles from './TransferResidentDialog.module.css';

export function InflowActionDialog({
  dormitoryId,
  row,
  action,
  onClose,
  onProcessed,
}: {
  dormitoryId: string;
  row: InflowRow;
  action: InflowAction;
  onClose: () => void;
  onProcessed: (row: InflowRow) => void;
}): JSX.Element {
  const [preview, setPreview] = useState<InflowActionPreview | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [departure, setDeparture] = useState(todayDate());
  const initialized = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setPreview(null);
    void api
      .previewInflowAction(dormitoryId, row.id, action, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPreview(result);
        if (!initialized.current) {
          setDeparture(result.departure_date ?? todayDate());
          initialized.current = true;
        }
        setReason((current) =>
          result.fields?.reason_column?.kind === 'select' &&
          !result.fields.reasons.some((option) => option.value === current)
            ? ''
            : current,
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось подготовить действие.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [dormitoryId, row.id, action, attempt]);
  async function submit(): Promise<void> {
    if (!preview || checking || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await api.processInflow(dormitoryId, row.id, action, preview.preview_token, {
        ...(preview.fields?.reason_column ? { reason: reason.trim() } : {}),
        ...(preview.fields?.departure_column ? { departure_date: departure } : {}),
      });
      onProcessed(result.inflow);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Не удалось обработать строку притока.',
      );
      if (caught instanceof ApiError && caught.status === 409) setAttempt((value) => value + 1);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return createPortal(
    <Modal
      title={action === 'settle' ? 'Заселить из притока' : 'В отток из притока'}
      testId="inflow-action-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form
        className={styles.form}
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>
          {action === 'settle' ? 'Заселить' : 'Отправить'}{' '}
          {row.full_name?.trim() ? `сотрудника «${row.full_name.trim()}»` : 'этого сотрудника'}
          {action === 'outflow' ? ' в «Отток»' : ''}?
        </p>
        {checking && <p role="status">Подготавливаем действие…</p>}
        {preview && !checking && action === 'outflow' && preview.fields && (
          <OutflowTransferFields
            fields={preview.fields}
            reason={reason}
            departure={departure}
            onReason={setReason}
            onDeparture={setDeparture}
            disabled={saving}
          />
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {!preview && !checking && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Повторить проверку
          </button>
        )}
        <div className={styles.actions}>
          <button type="button" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            disabled={
              saving ||
              checking ||
              !preview ||
              (!!preview.fields?.reason_column && !reason.trim()) ||
              (!!preview.fields?.departure_column && !departure)
            }
          >
            {saving ? 'Сохраняем…' : 'Подтвердить'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
