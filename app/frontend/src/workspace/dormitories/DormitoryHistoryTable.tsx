import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { CustomTab, DormitoryHistoryPage } from '../../api/client';
import { WorkingTable } from '../../components/WorkingTable';
import type { DateRange } from '../dashboard/dates';
import { usePageRefresh } from '../usePageRefresh';
import s from './DormitoryHistoryTable.module.css';
import { DormitoryTableFrame } from './DormitoryTableFrame';
import { useDormitoryPages } from './useDormitoryPages';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const revision = usePageRefresh();
  const pager = useDormitoryPages(
    dormitoryId,
    `${tab.id}:${range.from}:${range.to}`,
    () => setAttempt((n) => n + 1),
    setError,
  );
  const { options: pagingOptions, setInfo } = pager;

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setError('');
    setItems([]);
    void api
      .dormitoryHistory(
        dormitoryId,
        tab.id,
        range.from,
        range.to,
        request.signal,
        undefined,
        pagingOptions,
      )
      .then((page) => {
        if (request.signal.aborted) return;
        setItems(page.items);
        setInfo({ page: page.page ?? 1, total: page.total ?? page.items.length });
      })
      .catch((caught: unknown) => {
        if (!request.signal.aborted)
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить историю.');
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => request.abort();
  }, [dormitoryId, tab.id, range.from, range.to, attempt, revision, pagingOptions, setInfo]);

  return (
    <DormitoryTableFrame
      className={s.page}
      aria-label={tab.name}
      heading={<h2>{tab.name}</h2>}
      paging={{ pager, loading, label: 'Действие или автор' }}
      secondary={
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          disabled={loading}
          onClick={() => {
            pager.changePage(1);
            setAttempt((value) => value + 1);
          }}
        >
          Обновить
        </button>
      }
    >
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
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </p>
      )}
      <div className={s.scroll}>
        <WorkingTable
          className={`data-table ${s.table}`}
          zoomKey={`dormitories/${dormitoryId}/table-views/${tab.table_key}`}
          readOnly
          sortable={false}
          columns={[
            { id: 'date', label: 'Дата', kind: 'date' },
            { id: 'action', label: 'Действие', kind: 'text' },
            { id: 'author', label: 'Автор', compact: true },
          ]}
        >
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
        </WorkingTable>
      </div>
      {!loading && !error && !items.length && <p>За выбранный период изменений данных нет.</p>}
    </DormitoryTableFrame>
  );
}
