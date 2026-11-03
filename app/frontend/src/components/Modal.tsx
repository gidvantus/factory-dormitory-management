import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useUnsavedChanges } from './useUnsavedChanges';
import { EditorSurfaceContext } from './EditorSurface';

const CloseContext = createContext<{ close: () => void; run: (action: () => void) => void } | null>(
  null,
);
export function ModalCancelButton({
  children = 'Отмена',
  when = true,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { when?: boolean }): JSX.Element {
  const close = useContext(CloseContext);
  return (
    <button
      {...props}
      type="button"
      onClick={(event) => {
        if (!close || !when) props.onClick?.(event);
        else if (props.onClick) close.run(() => props.onClick?.(event));
        else close.close();
      }}
    >
      {children}
    </button>
  );
}

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
  panelClassName?: string;
  containerClassName?: string;
  initialFocus?: 'first-input' | 'panel';
  /** Точная оценка черновика; без неё изменения отслеживаются внутри форм. */
  dirty?: boolean;
  protectChanges?: boolean;
  guardClose?: boolean;
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
  panelClassName = '',
  containerClassName = '',
  initialFocus = 'first-input',
  dirty,
  protectChanges = true,
  guardClose = true,
}: ModalProps): JSX.Element {
  const surface = useContext(EditorSurfaceContext);
  const inline = surface?.inline ?? false;
  const Intro = surface?.intro;
  const Layout = surface?.layout;
  const [changed, setChanged] = useState(false);
  const confirmDiscard = useUnsavedChanges(dirty ?? (protectChanges && changed));
  const protectAction = useCallback(
    (action: () => void) => {
      if (!closeDisabled && (!guardClose || confirmDiscard())) {
        setChanged(false);
        action();
      }
    },
    [closeDisabled, guardClose, confirmDiscard],
  );
  const requestClose = useCallback(() => protectAction(onClose), [protectAction, onClose]);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `${testId}-title`;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const firstInput = panel.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE);
    (initialFocus === 'panel' ? panel : (firstInput ?? firstFocusable ?? panel)).focus();
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (inline && !(event.target instanceof Node && panelRef.current?.contains(event.target)))
        return;
      if (event.key === 'Escape') {
        requestClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      if (inline) return;
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
    [requestClose, inline],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <CloseContext.Provider value={{ close: requestClose, run: protectAction }}>
      <div
        className={`modal ${containerClassName}`}
        data-editor-inline={inline || undefined}
        data-editor-window={surface?.windowed || undefined}
        data-editor-organized={surface?.organized || undefined}
        onChangeCapture={(event) => {
          if (protectChanges && event.target instanceof Element && event.target.closest('form'))
            setChanged(true);
        }}
        onResetCapture={() => setChanged(false)}
      >
        <div
          className="modal__backdrop"
          aria-hidden="true"
          data-testid={`${testId}-backdrop`}
          onClick={requestClose}
        />
        <div
          className={`modal__panel ${panelClassName}`}
          role={inline ? 'region' : 'dialog'}
          aria-modal={inline ? undefined : true}
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
              onClick={requestClose}
            >
              ✕
            </button>
          </div>
          <div className="modal__body">
            {Layout ? (
              <Layout editorId={testId}>{children}</Layout>
            ) : (
              <>
                {Intro && <Intro editorId={testId} />}
                {children}
              </>
            )}
          </div>
        </div>
      </div>
    </CloseContext.Provider>
  );
}
