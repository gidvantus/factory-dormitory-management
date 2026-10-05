import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { api, ApiError } from '../../api/client';
import type { Dormitory } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './Dormitories.module.css';

interface Props {
  onClose: () => void;
  onCreated: (dormitory: Dormitory) => void;
  triggerRef: RefObject<HTMLButtonElement>;
}

export function CreateDormitoryDialog({ onClose, onCreated, triggerRef }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [errors, setErrors] = useState<{ name?: string; clientName?: string }>({});
  const [requestError, setRequestError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const trigger = triggerRef.current;
    return () => {
      document.body.style.overflow = previousOverflow;
      trigger?.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const normalizedName = name.trim().replace(/\s+/g, ' ');
    const normalizedClient = clientName.trim().replace(/\s+/g, ' ');
    const found: typeof errors = {};
    if (!normalizedName) found.name = 'Укажите название общежития';
    else if (normalizedName.length > 255) found.name = 'Не более 255 символов';
    if (!normalizedClient) found.clientName = 'Укажите название клиента';
    else if (normalizedClient.length > 255) found.clientName = 'Не более 255 символов';
    setErrors(found);
    setRequestError('');
    if (found.name || found.clientName) {
      (found.name ? nameRef : clientRef).current?.focus();
      return;
    }

    inFlight.current = true;
    setSaving(true);
    try {
      const created = await api.createDormitory({
        name: normalizedName,
        client_name: normalizedClient,
      });
      onCreated(created);
    } catch (error) {
      setRequestError(
        error instanceof ApiError && error.status === 401
          ? 'Сессия завершилась. Войдите в аккаунт снова.'
          : 'Не удалось создать общежитие. Проверьте соединение и попробуйте ещё раз.',
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <Modal
      title="Создать общежитие"
      testId="create-dormitory-modal"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className="form" noValidate onSubmit={(event) => void submit(event)} aria-busy={saving}>
        <div className="field">
          <label className="field__label" htmlFor="dormitory-name">
            Название общежития
          </label>
          <input
            className="field__input"
            id="dormitory-name"
            data-testid="dormitory-name"
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={255}
            required
            disabled={saving}
            placeholder="Например, Северное"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? 'dormitory-name-error' : undefined}
          />
          {errors.name && (
            <p className="field__error" id="dormitory-name-error" role="alert">
              {errors.name}
            </p>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor="dormitory-client-name">
            Название клиента
          </label>
          <input
            className="field__input"
            id="dormitory-client-name"
            data-testid="dormitory-client-name"
            ref={clientRef}
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
            maxLength={255}
            required
            disabled={saving}
            placeholder="Например, Стройкомплект"
            aria-invalid={!!errors.clientName}
            aria-describedby={errors.clientName ? 'dormitory-client-error' : undefined}
          />
          {errors.clientName && (
            <p className="field__error" id="dormitory-client-error" role="alert">
              {errors.clientName}
            </p>
          )}
        </div>
        {requestError && (
          <p className="alert alert--error" role="alert">
            {requestError}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className="btn btn--outline" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving}
            data-testid="create-dormitory-submit"
          >
            {saving ? 'Создаём…' : 'Создать'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
