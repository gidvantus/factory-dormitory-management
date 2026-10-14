import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import styles from './ConfigurableColumns.module.css';

export function RowActionsMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const visible = open && position !== undefined;

  function closeAndFocus(): void {
    setOpen(false);
    // Dialogs opened by an action can restore focus to this persistent button.
    trigger.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place(): void {
      if (!trigger.current || !popup.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const menu = popup.current.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin);
      const above = Math.max(0, anchor.top - gap - margin);
      const upwards = below < menu.height && above > below;
      const maxHeight = upwards ? above : below;
      const height = Math.min(popup.current.scrollHeight + 2, maxHeight);
      setPosition({
        left: Math.max(
          margin,
          Math.min(anchor.right - menu.width, window.innerWidth - menu.width - margin),
        ),
        top: upwards ? anchor.top - gap - height : anchor.bottom + gap,
        maxHeight,
      });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useLayoutEffect(() => {
    if (visible)
      popup.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    function outside(event: Event): void {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    }
    function escape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    }
    function scroll(event: Event): void {
      // Keep scrolling inside a long menu; dismiss it when its table moves.
      if (popup.current?.contains(event.target as Node)) return;
      const current = trigger.current?.getBoundingClientRect();
      if (anchor && current && (current.top !== anchor.top || current.left !== anchor.left))
        setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.rowActionTrigger}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setPosition(undefined);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setPosition(undefined);
            setOpen(true);
          }
        }}
      >
        Действия <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="group"
            aria-label={label}
            className={styles.rowActionList}
            style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
            onClick={(event) => {
              if ((event.target as Element).closest('button:not(:disabled)')) closeAndFocus();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const buttons =
                popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
              if (!buttons?.length) return;
              if (event.shiftKey && event.target === buttons[0]) {
                event.preventDefault();
                closeAndFocus();
              } else if (!event.shiftKey && event.target === buttons[buttons.length - 1]) {
                closeAndFocus();
              }
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
