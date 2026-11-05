import { forwardRef, useLayoutEffect, useRef } from 'react';
import type { ComponentPropsWithoutRef } from 'react';

export const AutoGrowTextarea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<'textarea'>
>(function AutoGrowTextarea({ className = '', ...props }, forwardedRef) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = (): void => {
      const width = element.getBoundingClientRect().width;
      if (!width) return;
      element.style.height = 'auto';
      const style = getComputedStyle(element);
      element.style.height = `${element.scrollHeight + parseFloat(style.borderTopWidth || '0') + parseFloat(style.borderBottomWidth || '0')}px`;
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const next = element.getBoundingClientRect().width;
            if (next !== width) {
              width = next;
              resize();
            }
          });
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [props.value]);
  return (
    <textarea
      {...props}
      rows={props.rows ?? 3}
      className={`auto-grow-textarea ${className}`}
      ref={(element) => {
        ref.current = element;
        if (typeof forwardedRef === 'function') forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      }}
    />
  );
});
