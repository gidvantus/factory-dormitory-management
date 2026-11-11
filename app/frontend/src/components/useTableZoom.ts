import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { api } from '../api/client';

const DEFAULT_ZOOM = 100;
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;
const SCROLL_THRESHOLD = 40;
const SAVE_DELAY = 220;
const writes = new Map<string, Promise<unknown>>();

function saveZoom(key: string, percent: number): Promise<unknown> {
  const previous = writes.get(key);
  const write = previous
    ? previous.catch(() => undefined).then(() => api.saveTableZoom(key, percent))
    : api.saveTableZoom(key, percent);
  writes.set(key, write);
  const clear = (): void => {
    if (writes.get(key) === write) writes.delete(key);
  };
  void write.then(clear, clear);
  return write;
}

export function useTableZoom(
  ref: RefObject<HTMLTableElement>,
  key?: string,
): { scale: number; saveFailed: boolean } {
  const [view, setView] = useState({ key, percent: DEFAULT_ZOOM, saveFailed: false });

  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    const controller = new AbortController();
    let percent = DEFAULT_ZOOM;
    let interacted = false;
    let delta = 0;
    let lastWheel = 0;
    let timer: number | undefined;
    if (key) {
      const pending = writes.get(key) ?? Promise.resolve();
      void pending
        .catch(() => undefined)
        .then(() => (controller.signal.aborted ? undefined : api.tableZoom(key, controller.signal)))
        .then((result) => {
          if (controller.signal.aborted || interacted || !result) return;
          const saved = result.percent;
          if (Number.isInteger(saved) && saved >= MIN_ZOOM && saved <= MAX_ZOOM) {
            percent = saved;
            setView({ key, percent, saveFailed: false });
          }
        })
        .catch(() => undefined);
    }

    function persist(): void {
      if (timer === undefined || !key) return;
      window.clearTimeout(timer);
      timer = undefined;
      const target = percent;
      void saveZoom(key, target).catch(() => {
        if (!controller.signal.aborted && percent === target)
          setView({ key, percent, saveFailed: true });
      });
    }

    function wheel(event: WheelEvent): void {
      if (
        !event.ctrlKey ||
        !event.deltaY ||
        !(event.target instanceof Element) ||
        event.target.closest('table') !== table
      )
        return;
      event.preventDefault();

      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? SCROLL_THRESHOLD
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? table!.clientHeight
            : 1;
      if (event.timeStamp - lastWheel > 250 || Math.sign(delta) !== Math.sign(event.deltaY))
        delta = 0;
      lastWheel = event.timeStamp;
      delta += event.deltaY * unit;
      if (Math.abs(delta) < SCROLL_THRESHOLD) return;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, percent - Math.sign(delta) * ZOOM_STEP));
      delta = 0;
      if (next === percent) return;
      interacted = true;
      percent = next;
      setView({ key, percent, saveFailed: false });
      if (key) {
        window.clearTimeout(timer);
        timer = window.setTimeout(persist, SAVE_DELAY);
      }
    }

    table.addEventListener('wheel', wheel, { passive: false });
    if (key) window.addEventListener('pagehide', persist);
    return () => {
      controller.abort();
      table.removeEventListener('wheel', wheel);
      if (key) window.removeEventListener('pagehide', persist);
      persist();
    };
  }, [key, ref]);

  return view.key === key
    ? { scale: view.percent / 100, saveFailed: view.saveFailed }
    : { scale: 1, saveFailed: false };
}
