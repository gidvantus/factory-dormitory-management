import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { api, ApiError } from '../../api/client';
import type { Dormitory, Resident, ResidentTransferPreview } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './TransferResidentDialog.module.css';

export function TransferResidentDialog({
  dormitoryId,
  resident,
  month,
  trigger,
  onClose,
  onTransferred,
}: {
  dormitoryId: string;
  resident: Resident;
  month: string;
  trigger: HTMLButtonElement;
  onClose: () => void;
  onTransferred: (residentId: number, destination: Dormitory) => void;
}): JSX.Element {
  const [dormitories, setDormitories] = useState<Dormitory[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listAttempt, setListAttempt] = useState(0);
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<ResidentTransferPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
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
    setListStatus('loading');
    void api
      .dormitories(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setDormitories(
            items.filter((item) => String(item.id) !== dormitoryId && !item.is_archived),
          );
          setListStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setListStatus('error');
      });
    return () => controller.abort();
  }, [dormitoryId, listAttempt]);

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setPreview(null);
    setConfirmed(false);
    setChecking(true);
    void api
      .previewResidentTransfer(dormitoryId, resident.id, Number(target), month, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось сравнить столбцы.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [dormitoryId, resident.id, target, month, attempt]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const destination = dormitories.find((item) => String(item.id) === target);
    if (
      inFlight.current ||
      !destination ||
      !preview ||
      checking ||
      preview.target_dormitory_id !== destination.id
    )
      return;
    if (preview.warnings.length && !confirmed) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      await api.transferResident(
        dormitoryId,
        resident.id,
        destination.id,
        month,
        preview.preview_token,
        confirmed,
      );
      onTransferred(resident.id, destination);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось перевести проживающего.');
      if (caught instanceof ApiError && caught.status === 409) {
        setPreview(null);
        setConfirmed(false);
        setAttempt((value) => value + 1);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <Modal
      title="Перевести проживающего"
      testId="transfer-resident-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)} aria-busy={saving}>
        <p>{resident.full_name || `Строка № ${resident.id}`}</p>
        <p>
          После перевода строка исчезнет из этого общежития и появится в выбранном. Записи на аванс
          и расчёт останутся в прежнем общежитии.
        </p>
        {listStatus === 'loading' && <p role="status">Загружаем общежития…</p>}
        {listStatus === 'error' && (
          <p role="alert">
            Не удалось загрузить общежития.{' '}
            <button type="button" onClick={() => setListAttempt((value) => value + 1)}>
              Повторить загрузку
            </button>
          </p>
        )}
        {listStatus === 'ready' && dormitories.length === 0 && (
          <p>Нет других активных общежитий для перевода.</p>
        )}
        {listStatus === 'ready' && dormitories.length > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="transfer-dormitory">
              В какое общежитие перевести
            </label>
            <select
              id="transfer-dormitory"
              className="field__input"
              value={target}
              disabled={saving}
              onChange={(event) => {
                setTarget(event.target.value);
                setPreview(null);
                setConfirmed(false);
                setChecking(false);
                setError('');
              }}
            >
              <option value="">Выберите общежитие</option>
              {dormitories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {item.client_name}
                </option>
              ))}
            </select>
          </div>
        )}
        {checking && <p role="status">Сравниваем столбцы и значения…</p>}
        {preview && preview.target_dormitory_id === Number(target) && (
          <div className={styles.summary}>
            {preview.matched_columns.length > 0 && (
              <p>Перенесём совпадающие поля: {preview.matched_columns.join(', ')}.</p>
            )}
            {preview.warnings.length === 0 && (
              <p>Все исходные поля совпадают. Данные можно перенести.</p>
            )}
            {preview.warnings.length > 0 && (
              <>
                <div role="alert" className={styles.warning}>
                  <p>
                    <strong>Не сможем перенести следующие поля:</strong>
                  </p>
                  <ul>
                    {preview.warnings.map((item, index) => (
                      <li key={`${item.column}:${index}`}>
                        <strong>{item.column}</strong>: {item.reason}.
                      </li>
                    ))}
                  </ul>
                </div>
                <label className={styles.confirmation}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={saving}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Подтверждаю перевод без перечисленных полей
                </label>
              </>
            )}
            {preview.empty_columns.length > 0 && (
              <p>Поля в новом общежитии останутся пустыми: {preview.empty_columns.join(', ')}.</p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {target && !preview && !checking && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Повторить сравнение
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
              preview.target_dormitory_id !== Number(target) ||
              (preview.warnings.length > 0 && !confirmed)
            }
          >
            {saving ? 'Переводим…' : 'Перевести'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
