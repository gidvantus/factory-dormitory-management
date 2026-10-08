import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../api/client';
import type { Dormitory } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './Dormitories.module.css';

export function DormitoryActions({
  dormitory,
  onUpdated,
}: {
  dormitory: Dormitory;
  onUpdated: (dormitory: Dormitory) => void;
}): JSX.Element {
  const [dialog, setDialog] = useState<'edit' | 'archive' | null>(null);
  const [name, setName] = useState(dormitory.name);
  const [clientName, setClientName] = useState(dormitory.client_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const button = trigger.current;
    return () => {
      document.body.style.overflow = previousOverflow;
      button?.focus({ preventScroll: true });
    };
  }, [dialog]);

  async function update(input: {
    name?: string;
    client_name?: string;
    is_archived?: boolean;
  }): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateDormitory(String(dormitory.id), input);
      onUpdated(updated);
      setDialog(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Не удалось сохранить изменения. Попробуйте ещё раз.',
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <div className={styles.dormitoryActions} aria-label={`Действия: ${dormitory.name}`}>
        <button
          type="button"
          disabled={saving}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setName(dormitory.name);
            setClientName(dormitory.client_name);
            setError('');
            setDialog('edit');
          }}
        >
          Редактировать
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setError('');
            if (dormitory.is_archived) void update({ is_archived: false });
            else setDialog('archive');
          }}
        >
          {saving && !dialog
            ? 'Восстанавливаем…'
            : dormitory.is_archived
              ? 'Восстановить'
              : 'В архив'}
        </button>
      </div>
      {error && !dialog && (
        <p role="alert" className={styles.actionError}>
          {error}
        </p>
      )}
      {dialog &&
        createPortal(
          <Modal
            title={
              dialog === 'edit'
                ? 'Редактировать общежитие'
                : `Перенести «${dormitory.name}» в архив?`
            }
            testId={`dormitory-${dialog}-modal-${dormitory.id}`}
            onClose={() => setDialog(null)}
            closeDisabled={saving}
          >
            {dialog === 'edit' ? (
              <form
                className="form"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const normalizedName = name.trim().replace(/\s+/g, ' ');
                  const normalizedClient = clientName.trim().replace(/\s+/g, ' ');
                  if (!normalizedName || !normalizedClient) {
                    setError('Заполните название общежития и название клиента.');
                    return;
                  }
                  if (normalizedName.length > 255 || normalizedClient.length > 255) {
                    setError('Название должно содержать не более 255 символов.');
                    return;
                  }
                  void update({ name: normalizedName, client_name: normalizedClient });
                }}
              >
                <div className="field">
                  <label className="field__label" htmlFor={`edit-dormitory-name-${dormitory.id}`}>
                    Название общежития
                  </label>
                  <input
                    className="field__input"
                    id={`edit-dormitory-name-${dormitory.id}`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={255}
                    disabled={saving}
                    required
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`edit-client-name-${dormitory.id}`}>
                    Название клиента
                  </label>
                  <input
                    className="field__input"
                    id={`edit-client-name-${dormitory.id}`}
                    value={clientName}
                    onChange={(event) => setClientName(event.target.value)}
                    maxLength={255}
                    disabled={saving}
                    required
                  />
                </div>
                {error && (
                  <p className="alert alert--error" role="alert">
                    {error}
                  </p>
                )}
                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    className="btn btn--outline"
                    disabled={saving}
                    onClick={() => setDialog(null)}
                  >
                    Отмена
                  </button>
                  <button type="submit" className="btn btn--primary" disabled={saving}>
                    {saving ? 'Сохраняем…' : 'Сохранить'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p>
                  Общежитие останется в списке с пометкой «Архив». Все данные сохранятся и продолжат
                  учитываться на дашборде. Общежитие можно восстановить в любой момент.
                </p>
                {error && (
                  <p className="alert alert--error" role="alert">
                    {error}
                  </p>
                )}
                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    className="btn btn--outline"
                    disabled={saving}
                    onClick={() => setDialog(null)}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saving}
                    onClick={() => void update({ is_archived: true })}
                  >
                    {saving ? 'Переносим…' : 'Перенести в архив'}
                  </button>
                </div>
              </>
            )}
          </Modal>,
          document.body,
        )}
    </>
  );
}
