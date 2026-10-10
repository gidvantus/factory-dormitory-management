import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { api, ApiError } from '../../api/client';
import type { Dormitory, ReportTemplate } from '../../api/client';
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
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templatesStatus, setTemplatesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [templatesAttempt, setTemplatesAttempt] = useState(0);
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

  useEffect(() => {
    const controller = new AbortController();
    setTemplatesStatus('loading');
    void api
      .reportTemplates(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(items)) throw new Error('Invalid templates response');
          setTemplates(items);
          setTemplatesStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setTemplatesStatus('error');
      });
    return () => controller.abort();
  }, [templatesAttempt]);

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
        ...(templateId ? { template_id: Number(templateId) } : {}),
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
        <div className="field">
          <label className="field__label" htmlFor="dormitory-template">
            Шаблон отчёта <span className={styles.optional}>(необязательно)</span>
          </label>
          <select
            className="field__input"
            id="dormitory-template"
            data-testid="dormitory-template"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            disabled={saving || templatesStatus !== 'ready'}
          >
            <option value="">Без шаблона</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {template.row_count} строк
              </option>
            ))}
          </select>
          {templatesStatus === 'loading' && (
            <p className={styles.templateHint}>Загружаем шаблоны…</p>
          )}
          {templatesStatus === 'error' && (
            <p className={styles.templateHint}>
              Не удалось загрузить шаблоны.{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => setTemplatesAttempt((value) => value + 1)}
              >
                Повторить
              </button>
            </p>
          )}
          {templateId && (
            <p className={styles.templateHint}>
              Скопируются только строки и формулы. Значения останутся пустыми.
            </p>
          )}
        </div>
        {requestError && (
          <p className="alert alert--error" role="alert">
            {requestError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn--ghost" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            aria-busy={saving}
            disabled={saving}
            data-testid="create-dormitory-submit"
          >
            Создать
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
