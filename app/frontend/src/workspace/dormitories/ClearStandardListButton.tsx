import { useContext, useState } from 'react';
import { api, ApiError, waitForDormitoryWrites } from '../../api/client';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { TableLayoutContext } from './tableLayoutContext';

export function ClearStandardListButton({
  dormitoryId,
  section,
  title,
  disabled,
  onCleared,
}: {
  dormitoryId: string;
  section: 'residents' | 'inflow' | 'outflow';
  title: string;
  disabled: boolean;
  onCleared: () => void;
}): JSX.Element | null {
  const { clearList } = useContext(TableLayoutContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!clearList) return null;

  async function clear(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await waitForDormitoryWrites(dormitoryId);
      await api.clearStandardList(dormitoryId, section);
      setOpen(false);
      onCleared();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось очистить список.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--danger-text btn--compact"
        disabled={disabled || busy}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <WorkspaceIcon name="trash" />
        Очистить список
      </button>
      {open && (
        <Modal
          title={`Очистить список «${title}»?`}
          testId={`clear-${section}-modal`}
          onClose={() => setOpen(false)}
          closeDisabled={busy}
        >
          <p>
            {section === 'residents' ? 'Все строки' : 'Доступные для удаления строки'} списка «
            {title}» в текущем общежитии будут удалены за всё время, включая записи вне фильтра.
            {section === 'inflow' && ' Обработанные строки притока сохранятся.'}
            {section === 'outflow' && ' Строки по завершённым выселениям сохранятся.'}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <ModalCancelButton
              className="btn btn--ghost btn--compact"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Отмена
            </ModalCancelButton>
            <button
              type="button"
              className="btn btn--danger btn--compact"
              aria-busy={busy}
              disabled={busy}
              onClick={() => void clear()}
            >
              {busy ? 'Очищаем…' : 'Удалить строки'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
