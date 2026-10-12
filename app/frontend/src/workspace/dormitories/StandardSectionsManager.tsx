import { useEffect, useState } from 'react';
import { api, ApiError, waitForDormitoryWrites } from '../../api/client';
import type { StandardSection } from '../../api/client';
import styles from './ManageCustomTabsDialog.module.css';

export function StandardSectionsManager({
  dormitoryId,
  onChanged,
  onOpen,
  busy,
  setBusy,
}: {
  dormitoryId: string;
  onChanged: (items: StandardSection[]) => void;
  onOpen: (item: StandardSection) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}): JSX.Element {
  const [items, setItems] = useState<StandardSection[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState<{
    item: StandardSection;
    status: 'hidden' | 'deleted';
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .standardSections(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setItems(result);
          setLoading(false);
          onChanged(result);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof ApiError
              ? caught.message
              : 'Не удалось загрузить стандартные вкладки.',
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [dormitoryId, attempt, onChanged]);
  async function change(
    item: StandardSection,
    status: 'active' | 'hidden' | 'deleted',
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await waitForDormitoryWrites(dormitoryId);
      const result = await api.changeStandardSection(dormitoryId, item.key, status);
      setItems(result);
      onChanged(result);
      setConfirm(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось изменить вкладку.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <h3>Стандартные вкладки и подвкладки</h3>
      {loading && <p role="status">Загружаем стандартные вкладки…</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}{' '}
          <button type="button" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {!confirm && (
        <ul className={styles.list}>
          {items.map((item) => {
            const parent = items.find((entry) => entry.key === item.parent_key);
            const parentInactive = parent && parent.status !== 'active';
            return (
              <li key={item.key} className={styles.item} data-testid={`manage-section-${item.key}`}>
                <div className={styles.heading}>
                  <strong>{item.parent_key ? `${parent?.name} → ${item.name}` : item.name}</strong>
                  <span>
                    {item.status === 'deleted'
                      ? 'Удалена'
                      : item.status === 'hidden'
                        ? 'Скрыта · только просмотр'
                        : parentInactive
                          ? 'Раздел недоступен'
                          : 'Активна'}
                  </span>
                </div>
                <div className={styles.actions}>
                  {item.status !== 'deleted' && parent?.status !== 'deleted' && (
                    <button type="button" disabled={busy} onClick={() => onOpen(item)}>
                      {item.status === 'hidden' || parentInactive ? 'Просмотреть' : 'Открыть'}
                    </button>
                  )}
                  {item.status === 'active' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setConfirm({ item, status: 'hidden' });
                      }}
                    >
                      Скрыть
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !!parentInactive}
                      onClick={() => void change(item, 'active')}
                    >
                      {item.status === 'deleted' ? 'Добавить обратно' : 'Восстановить'}
                    </button>
                  )}
                  {item.status !== 'deleted' && (
                    <button
                      type="button"
                      className={styles.danger}
                      disabled={busy || !!item.delete_block_reason}
                      title={item.delete_block_reason ?? undefined}
                      onClick={() => {
                        setError('');
                        setConfirm({ item, status: 'deleted' });
                      }}
                    >
                      Удалить
                    </button>
                  )}
                </div>
                {item.status !== 'deleted' && item.delete_block_reason && (
                  <p className={styles.help}>{item.delete_block_reason}</p>
                )}
                {parentInactive && (
                  <p className={styles.help}>Сначала восстановите раздел «{parent.name}».</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <div className={styles.confirm}>
          <p>
            {confirm.status === 'hidden'
              ? `Скрыть «${confirm.item.name}»? Данные сохранятся и продолжат учитываться в отчётах. Раздел и его подвкладки будут доступны только для просмотра.`
              : `Удалить пустую вкладку «${confirm.item.name}» и её структуру? Позже её можно добавить обратно со стандартными столбцами.`}
          </p>
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
              Отмена
            </button>
            <button
              type="button"
              disabled={busy}
              className={confirm.status === 'deleted' ? styles.danger : undefined}
              onClick={() => void change(confirm.item, confirm.status)}
            >
              {busy
                ? 'Сохраняем…'
                : confirm.status === 'deleted'
                  ? 'Удалить вкладку'
                  : 'Скрыть вкладку'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
