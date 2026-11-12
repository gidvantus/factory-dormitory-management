import { useCallback, useContext, useMemo, useState } from 'react';
import { ApiError, waitForDormitoryWrites } from '../../api/client';
import type { TablePage, TablePageOptions } from '../../api/client';
import type { TableSort } from '../../components/tableSorting';
import { ColumnsContext } from './tableColumnsContext';

export const TABLE_PAGE_SIZE = 100;

export function tablePage<T>(data: TablePage<T> | T[]): TablePage<T> {
  return Array.isArray(data) ? { rows: data, total: data.length, page: 1 } : data;
}

export function useDormitoryPages(
  dormitoryId: string,
  scope: string,
  refresh: () => void,
  reportError: (message: string) => void,
) {
  const columns = useContext(ColumnsContext)?.columns;
  const [requested, setRequested] = useState({ scope, page: 1 });
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TableSort | null>(null);
  const [info, setInfo] = useState<{ total: number; page: number; size?: number }>({
    total: 0,
    page: 1,
  });
  const selectedSort =
    sort &&
    (sort.column.includes('-') ||
      (!columns && sort.column === 'name') ||
      columns?.some((column) => String(column.id) === sort.column && !column.archived))
      ? sort
      : null;
  const page = requested.scope === scope ? requested.page : 1;
  const options = useMemo<TablePageOptions>(
    () => ({ page, search, sort: selectedSort ?? undefined }),
    [page, search, selectedSort],
  );
  const submitSearch = useCallback(
    (next: string) => {
      setSearch(next.trim());
      setRequested({ scope, page: 1 });
    },
    [scope],
  );

  function changePage(next: number): void {
    setRequested({ scope, page: next });
  }

  async function change(action: () => void): Promise<void> {
    try {
      await waitForDormitoryWrites(dormitoryId);
      action();
    } catch (error) {
      reportError(error instanceof ApiError ? error.message : 'Не удалось сохранить изменения.');
    }
  }

  return {
    options,
    info,
    setInfo,
    changePage,
    change,
    search,
    setSearch: submitSearch,
    tableProps: {
      pagedRows: {
        sort: selectedSort,
        onSort: (next: TableSort) =>
          void change(() => {
            setSort(next);
            changePage(1);
          }),
        onOrderSaved: () => {
          setSort(null);
          refresh();
        },
      },
    },
  };
}
