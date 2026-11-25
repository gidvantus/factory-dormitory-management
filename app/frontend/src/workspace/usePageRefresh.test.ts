import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_REFRESH_MS, useFrameRefresh, usePageRefresh } from './usePageRefresh';

/**
 * Фоновое обновление поверхности (#251).
 *
 * Критерий тикета: открытая вкладка без действий не должна перезапрашивать карточки
 * списка. Поэтому у таймера и у фокуса разные ревизии, и это проверяется здесь, а
 * не только на глаз в консоли браузера.
 */
function setVisibility(value: DocumentVisibilityState): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Обновление поверхности персонала', () => {
  it('по таймеру обновляет только рамку, страница ждёт действия', () => {
    vi.useFakeTimers();
    const page = renderHook(() => usePageRefresh());
    const frame = renderHook(() => useFrameRefresh());
    act(() => void vi.advanceTimersByTime(FRAME_REFRESH_MS));
    expect(frame.result.current).toBe(1);
    expect(page.result.current).toBe(0);
    act(() => void vi.advanceTimersByTime(FRAME_REFRESH_MS * 9));
    expect(frame.result.current).toBe(10);
    expect(page.result.current).toBe(0);
  });

  it('по фокусу обновляет страницу целиком', () => {
    const page = renderHook(() => usePageRefresh());
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(page.result.current).toBe(1);
  });

  it('в скрытой вкладке ни таймер, ни фокус не считаются обновлением', () => {
    vi.useFakeTimers();
    const restore = setVisibility('hidden');
    try {
      const page = renderHook(() => usePageRefresh());
      const frame = renderHook(() => useFrameRefresh());
      act(() => void vi.advanceTimersByTime(FRAME_REFRESH_MS));
      act(() => void window.dispatchEvent(new Event('focus')));
      expect(frame.result.current).toBe(0);
      expect(page.result.current).toBe(0);
    } finally {
      restore();
    }
  });
});
