import { useEffect, useState } from 'react';
import { api, ApiError, waitForDormitoryWrites } from '../../api/client';
import type { CustomTab, StandardSection } from '../../api/client';
import { StandardSectionsManager } from './StandardSectionsManager';
import { customChain, customLabel } from './tabStructure';
import { Modal } from '../../components/Modal';
import styles from './ManageCustomTabsDialog.module.css';

export function ManageCustomTabsDialog({
  dormitoryId,
  onClose,
  onLoaded,
  onChanged,
  onDeleted,
  onOpen,
  beforeChange,
  onStandardChanged,
  onStandardOpen,
}: {
  dormitoryId: string;
  onClose: () => void;
  onLoaded: (tabs: CustomTab[]) => void;
  onChanged: (tab: CustomTab) => void;
  onDeleted: (id: number) => void;
  onOpen: (tab: CustomTab) => void;
  beforeChange: (id: number) => Promise<void>;
  onStandardChanged?: (items: StandardSection[]) => void;
  onStandardOpen?: (item: StandardSection) => void;
}): JSX.Element {
  const [tabs, setTabs] = useState<CustomTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ tab: CustomTab; action: 'hide' | 'delete' } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void api
      .customTabs(dormitoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setTabs(result);
          setLoading(false);
          onLoaded(result);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить вкладки.',
          );
        }
      });
    return () => controller.abort();
  }, [dormitoryId, attempt, onLoaded]);
  async function change(tab: CustomTab, action: 'hide' | 'restore' | 'delete'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await beforeChange(tab.id);
      await waitForDormitoryWrites(dormitoryId);
      if (action === 'delete') {
        await api.deleteCustomTab(dormitoryId, tab.id);
        setTabs((current) =>
          current.filter(
            (item) => !customChain(item, current).some((ancestor) => ancestor.id === tab.id),
          ),
        );
        onDeleted(tab.id);
      } else {
        const updated = await api.setCustomTabActive(dormitoryId, tab.id, action === 'restore');
        setTabs((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        onChanged(updated);
      }
      setConfirm(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось изменить вкладку.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Управление вкладками"
      testId="manage-custom-tabs-modal"
      onClose={onClose}
      closeDisabled={busy}
    >
      <div className={styles.content}>
        <p className={styles.help}>
          Удалить можно только вкладку без записей за всё время и без связей с отчётом. Скрытые
          вкладки продолжают учитываться в отчёте и доступны только для просмотра.
        </p>
        {onStandardChanged && onStandardOpen && (
          <StandardSectionsManager
            dormitoryId={dormitoryId}
            onChanged={onStandardChanged}
            onOpen={onStandardOpen}
            busy={busy}
            setBusy={setBusy}
          />
        )}
        {loading && <p role="status">Загружаем вкладки…</p>}
        {loadError && (
          <p role="alert" className={styles.error}>
            {loadError}{' '}
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Повторить загрузку
            </button>
          </p>
        )}
        {!loading && !loadError && !tabs.length && <p>Пользовательских вкладок пока нет.</p>}
        {!confirm && !loading && !loadError && (
          <ul className={styles.list}>
            {tabs.map((tab) => (
              <li key={tab.id} className={styles.item} data-testid={`manage-tab-${tab.id}`}>
                <div className={styles.heading}>
                  <strong>{customLabel(tab, tabs)}</strong>
                  <span>
                    {!tab.is_active
                      ? 'Скрыта · только просмотр'
                      : tab.parent_id &&
                          tabs.find((item) => item.id === tab.parent_id)?.is_active === false
                        ? 'Раздел скрыт · только просмотр'
                        : 'Активна'}
                  </span>
                </div>
                <div className={styles.actions}>
                  <button type="button" disabled={busy} onClick={() => onOpen(tab)}>
                    {tab.is_active &&
                    (!tab.parent_id || tabs.find((item) => item.id === tab.parent_id)?.is_active)
                      ? 'Открыть'
                      : 'Просмотреть'}
                  </button>
                  {tab.is_active ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setConfirm({ tab, action: 'hide' });
                      }}
                    >
                      Скрыть
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !!(
                          tab.parent_id &&
                          tabs.find((item) => item.id === tab.parent_id)?.is_active === false
                        )
                      }
                      onClick={() => void change(tab, 'restore')}
                    >
                      Восстановить
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy || !!tab.delete_block_reason}
                    title={tab.delete_block_reason ?? undefined}
                    onClick={() => {
                      setError('');
                      setConfirm({ tab, action: 'delete' });
                    }}
                  >
                    Удалить
                  </button>
                </div>
                {tab.delete_block_reason && (
                  <p className={styles.help}>{tab.delete_block_reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {confirm && (
          <div className={styles.confirm}>
            <p>
              {confirm.action === 'hide'
                ? `Скрыть вкладку «${confirm.tab.name}»? Данные сохранятся и продолжат учитываться в «Большом отчёте». Изменять таблицу можно будет после восстановления.`
                : `Удалить пустую вкладку «${confirm.tab.name}» вместе со структурой таблицы?`}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirm(null);
                  setError('');
                }}
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={busy}
                className={confirm.action === 'delete' ? styles.danger : undefined}
                onClick={() => void change(confirm.tab, confirm.action)}
              >
                {busy
                  ? 'Сохраняем…'
                  : confirm.action === 'hide'
                    ? 'Скрыть вкладку'
                    : 'Удалить вкладку'}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
