import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { CustomTab, DormitoryHistoryPage } from '../../api/client';
import type { DateRange } from '../dashboard/dates';
import { usePageRefresh } from '../usePageRefresh';
import s from './DormitoryHistoryTable.module.css';

const dateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
  timeStyle: 'medium',
});

export function DormitoryHistoryTable({
  dormitoryId,
  tab,
  range,
}: {
  dormitoryId: string;
  tab: CustomTab;
  range: DateRange;
}): JSX.Element {
  const [items, setItems] = useState<DormitoryHistoryPage['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const revision = usePageRefresh();

  useEffect(() => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    setItems([]);
    setCursor(null);
    void api
      .dormitoryHistory(dormitoryId, tab.id, range.from, range.to, request.signal)
      .then((page) => {
        if (request.signal.aborted) return;
        setItems(page.items);
        setCursor(page.next_cursor);
      })
      .catch((caught: unknown) => {
        if (!request.signal.aborted)
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить историю.');
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => controller.current?.abort();
  }, [dormitoryId, tab.id, range.from, range.to, attempt, revision]);

  async function more(): Promise<void> {
    if (!cursor || loading) return;
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    try {
      const page = await api.dormitoryHistory(
        dormitoryId,
        tab.id,
        range.from,
        range.to,
        request.signal,
        cursor,
      );
      if (request.signal.aborted) return;
      setItems((current) => [
        ...current,
        ...page.items.filter((item) => !current.some((old) => old.id === item.id)),
      ]);
      setCursor(page.next_cursor);
    } catch (caught) {
      if (!request.signal.aborted)
        setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить историю.');
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  return (
    <section className={s.page} aria-label={tab.name}>
      <div className="toolbar">
        <h2>{tab.name}</h2>
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          disabled={loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Обновить
        </button>
      </div>
      <p className={s.hint}>
        Изменения данных текущего общежития. Новые события сверху, время московское. История
        записывается автоматически с момента включения функции.
      </p>
      {loading && <p role="status">Загружаем историю…</p>}
      {error && (
        <p role="alert" className={s.error}>
          {error}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              cursor && items.length ? void more() : setAttempt((value) => value + 1)
            }
          >
            Повторить
          </button>
        </p>
      )}
      <div className={s.scroll}>
        <table className={`data-table ${s.table}`}>
          <thead>
            <tr>
              <th scope="col">Дата</th>
              <th scope="col">Действие</th>
              <th scope="col">Автор</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <time dateTime={item.date}>{dateTime.format(new Date(item.date))}</time>
                </td>
                <td className={s.action}>{item.action}</td>
                <td>{item.author}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && !items.length && <p>За выбранный период изменений данных нет.</p>}
      {cursor && (
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          disabled={loading}
          onClick={() => void more()}
        >
          Показать ещё
        </button>
      )}
    </section>
  );
}
