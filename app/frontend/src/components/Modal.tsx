import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  /** Заголовок окна: он же — доступное имя диалога. */
  title: string;
  /** Префикс для data-testid: `auth-modal`, `auth-modal-close` и так далее. */
  testId: string;
  onClose: () => void;
  /** Во время сохранения нельзя закрыть окно и потерять результат запроса. */
  closeDisabled?: boolean;
  children: ReactNode;
}

/**
 * Модальное окно с диалоговой семантикой: `role="dialog"`, `aria-modal`,
 * закрытие по Esc, возврат фокуса на первый элемент и удержание Tab внутри
 * окна. Стили — в `index.css`, разметка — только семантика.
 */
export function Modal({
  title,
  testId,
  onClose,
  closeDisabled = false,
  children,
}: ModalProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `${testId}-title`;

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const firstInput = panel.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE);
    (firstInput ?? firstFocusable ?? panel).focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!closeDisabled) onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, closeDisabled],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="modal">
      <div
        className="modal__backdrop"
        aria-hidden="true"
        data-testid={`${testId}-backdrop`}
        onClick={closeDisabled ? undefined : onClose}
      />
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="modal__head">
          <h2 className="modal__title" id={titleId} data-testid={`${testId}-title`}>
            {title}
          </h2>
          <button
            type="button"
            className="modal__close"
            data-testid={`${testId}-close`}
            aria-label="Закрыть окно"
            disabled={closeDisabled}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
