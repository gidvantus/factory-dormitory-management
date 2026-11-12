import { useState } from 'react';
import type { ReactNode } from 'react';
import { TABLE_PAGE_SIZE } from './useDormitoryPages';
import type { useDormitoryPages } from './useDormitoryPages';
import styles from './DormitoryPaging.module.css';

export interface DormitoryPagingProps {
  pager: ReturnType<typeof useDormitoryPages>;
  loading: boolean;
  search?: ReactNode;
  label?: string;
  unit?: string;
}

export function DormitoryPaging({
  pager,
  loading,
  search,
  label = 'Поиск по таблице',
  unit = 'строк',
  position = 'top',
}: DormitoryPagingProps & { position?: 'top' | 'bottom' }): JSX.Element | null {
  const [text, setText] = useState('');
  const { total, page, size = TABLE_PAGE_SIZE } = pager.info;
  const hasPages = total > size;
  const bottom = position === 'bottom';
  if (bottom && !hasPages) return null;
  return (
    <div className={bottom ? styles.bottom : styles.top}>
      <div className={styles.controls}>
        {!bottom && (
          <div className={styles.search}>
            {search ?? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void pager.change(() => pager.setSearch(text));
                }}
              >
                <div className={styles.find}>
                  <input
                    type="search"
                    aria-label={label}
                    placeholder={label}
                    maxLength={255}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <button type="submit" className="btn btn--ghost btn--compact" disabled={loading}>
                    Найти
                  </button>
                </div>
                {pager.search && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--compact"
                    disabled={loading}
                    onClick={() =>
                      void pager.change(() => {
                        setText('');
                        pager.setSearch('');
                      })
                    }
                  >
                    Сбросить поиск
                  </button>
                )}
              </form>
            )}
          </div>
        )}
        {hasPages && (
          <nav aria-label={bottom ? 'Страницы таблицы снизу' : 'Страницы таблицы сверху'}>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={loading || page <= 1}
              onClick={() => void pager.change(() => pager.changePage(page - 1))}
            >
              Назад
            </button>
            <span>
              Страница {page} из {Math.ceil(total / size)} · {unit}: {total}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={loading || page * size >= total}
              onClick={() => void pager.change(() => pager.changePage(page + 1))}
            >
              Дальше
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
