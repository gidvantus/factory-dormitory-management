import { useEffect, useState } from 'react';

/** Обновляем ежедневные статусы при возвращении на страницу и раз в минуту. */
export function usePageRefresh(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, []);
  return revision;
}
