import { useEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import styles from './TableHorizontalScrollbar.module.css';

const BAR_HEIGHT = 18;
const TABLE_OR_DIALOG = 'table, [aria-modal="true"]';

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Placement {
  scroller: HTMLElement;
  host: HTMLElement;
  label: string;
  left: number;
  top: number;
  width: number;
  thumbWidth: number;
  max: number;
  value: number;
}

function viewportBounds(): Bounds {
  const { clientWidth, clientHeight } = document.documentElement;
  const viewport = window.visualViewport;
  if (!viewport) return { left: 0, top: 0, right: clientWidth, bottom: clientHeight };
  return {
    left: viewport.offsetLeft,
    top: viewport.offsetTop,
    right: Math.min(clientWidth, viewport.offsetLeft + viewport.width),
    bottom: Math.min(clientHeight, viewport.offsetTop + viewport.height),
  };
}

function horizontalScroller(table: HTMLTableElement): HTMLElement | null {
  for (
    let parent = table.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const { overflowX } = getComputedStyle(parent);
    if (overflowX === 'auto' || overflowX === 'scroll') return parent;
    if (overflowX === 'hidden' || overflowX === 'clip') return null;
  }
  return null;
}

function visibleBounds(scroller: HTMLElement, viewport: Bounds): Bounds {
  const bounds = { ...viewport };
  for (
    let parent = scroller.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const rect = parent.getBoundingClientRect();
    const left = rect.left + parent.clientLeft;
    const top = rect.top + parent.clientTop;
    if (overflowX !== 'visible') {
      bounds.left = Math.max(bounds.left, left);
      bounds.right = Math.min(bounds.right, left + parent.clientWidth);
    }
    if (overflowY !== 'visible') {
      bounds.top = Math.max(bounds.top, top);
      bounds.bottom = Math.min(bounds.bottom, top + parent.clientHeight);
    }
  }
  return bounds;
}

function placementFor(
  table: HTMLTableElement,
  viewport: Bounds,
  host: HTMLElement,
): Placement | null {
  const tableRect = table.getBoundingClientRect();
  if (!tableRect.height || tableRect.top >= viewport.bottom || tableRect.bottom <= viewport.top)
    return null;
  const scroller = horizontalScroller(table);
  if (!scroller || scroller.scrollWidth - scroller.clientWidth <= 1) return null;
  const rect = scroller.getBoundingClientRect();
  if (rect.top >= viewport.bottom - BAR_HEIGHT || rect.bottom <= viewport.top) return null;

  const bounds = visibleBounds(scroller, viewport);
  const contentLeft = rect.left + scroller.clientLeft;
  const left = Math.max(contentLeft, bounds.left);
  const width = Math.min(contentLeft + scroller.clientWidth, bounds.right) - left;
  const top = bounds.bottom - BAR_HEIGHT;
  // Нижняя полоса самого контейнера уже доступна целиком.
  if (rect.bottom <= bounds.bottom + 1 || top < Math.max(rect.top, bounds.top) || width < 28)
    return null;

  const title = table.getAttribute('aria-label') || table.caption?.textContent?.trim();
  return {
    scroller,
    host,
    label: title ? `Горизонтальная прокрутка: ${title}` : 'Горизонтальная прокрутка таблицы',
    left,
    top,
    width,
    thumbWidth: Math.max(28, (width * scroller.clientWidth) / scroller.scrollWidth),
    max: scroller.scrollWidth - scroller.clientWidth,
    value: scroller.scrollLeft,
  };
}

function samePlacement(first: Placement | null, second: Placement | null): boolean {
  return (
    first === second ||
    (!!first &&
      !!second &&
      first.scroller === second.scroller &&
      first.host === second.host &&
      first.label === second.label &&
      first.left === second.left &&
      first.top === second.top &&
      first.width === second.width &&
      first.thumbWidth === second.thumbWidth &&
      first.max === second.max &&
      first.value === second.value)
  );
}

export function TableHorizontalScrollbar({
  scopeRef,
}: {
  scopeRef: RefObject<HTMLElement>;
}): JSX.Element | null {
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => {
    const root = scopeRef.current;
    if (!root) return;
    const workspace = root;
    let frame = 0;
    let preferred: HTMLTableElement | null = null;
    let scope: HTMLElement | null = null;
    let tables: HTMLTableElement[] = [];
    let scanNeeded = true;
    const viewport = window.visualViewport;
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);

    function schedule(): void {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    function measure(): void {
      frame = 0;
      const dialog = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
        .reverse()
        .find((item) => item.getClientRects().length > 0);
      const currentScope = dialog ?? workspace;
      if (scanNeeded || scope !== currentScope) {
        scope = currentScope;
        tables = Array.from(currentScope.querySelectorAll('table'));
        sizes?.disconnect();
        sizes?.observe(currentScope);
        for (const table of tables) {
          sizes?.observe(table);
          const scroller = horizontalScroller(table);
          if (scroller) sizes?.observe(scroller);
        }
        scanNeeded = false;
      }
      const bounds = viewportBounds();
      const host = dialog ?? document.body;
      if (preferred && !preferred.isConnected) preferred = null;
      let next =
        preferred && currentScope.contains(preferred)
          ? placementFor(preferred, bounds, host)
          : null;
      if (!next) {
        for (const table of tables) {
          const candidate = placementFor(table, bounds, host);
          if (candidate && (!next || candidate.top > next.top)) next = candidate;
        }
      }
      setPlacement((current) => (samePlacement(current, next) ? current : next));
    }

    function selectTable(event: Event): void {
      const table = event.target instanceof Element ? event.target.closest('table') : null;
      if (event.type === 'pointerover' && (!table || table === preferred)) return;
      if (table) preferred = table;
      schedule();
    }

    const mutations = new MutationObserver((records) => {
      let update = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          const target = record.target as Element;
          if (target.matches(TABLE_OR_DIALOG) || target.querySelector('table')) update = true;
        } else if (
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(TABLE_OR_DIALOG) || node.querySelector(TABLE_OR_DIALOG)),
          )
        ) {
          scanNeeded = true;
          update = true;
        }
      }
      if (update) schedule();
    });
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'hidden', 'open', 'data-scroll', 'aria-modal'],
    });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    document.addEventListener('pointerover', selectTable);
    document.addEventListener('focusin', selectTable);
    schedule();
    return () => {
      mutations.disconnect();
      sizes?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      document.removeEventListener('pointerover', selectTable);
      document.removeEventListener('focusin', selectTable);
      cancelAnimationFrame(frame);
    };
  }, [scopeRef]);

  if (!placement) return null;
  const { scroller, host, label, left, top, width, thumbWidth, max, value } = placement;
  return createPortal(
    <input
      className={styles.scrollbar}
      type="range"
      min={0}
      max={max}
      step="any"
      value={value}
      aria-label={label}
      aria-valuetext={`${Math.round((value / max) * 100)}%`}
      style={
        {
          left,
          top,
          width,
          height: BAR_HEIGHT,
          '--table-scroll-thumb-width': `${thumbWidth}px`,
        } as CSSProperties
      }
      onChange={(event) => {
        scroller.scrollLeft = event.currentTarget.valueAsNumber;
        setPlacement((current) =>
          current?.scroller === scroller ? { ...current, value: scroller.scrollLeft } : current,
        );
      }}
    />,
    host,
  );
}
