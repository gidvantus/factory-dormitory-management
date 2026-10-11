import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { CustomTab, CustomTabTemplate } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './ConfigurableColumns.module.css';

export function CreateCustomTabDialog({
  dormitoryId,
  onClose,
  onCreated,
  parentId = null,
  parentSection = null,
  inline = false,
  onBusyChange,
}: {
  dormitoryId: string;
  onClose: () => void;
  onCreated: (tab: CustomTab) => void;
  parentId?: number | null;
  parentSection?: string | null;
  inline?: boolean;
  onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const [mode, setMode] = useState('blank');
  const [name, setName] = useState('');
  const [withSubtabs, setWithSubtabs] = useState(false);
  const [subtabs, setSubtabs] = useState(['']);
  const [sourceId, setSourceId] = useState('');
  const [templates, setTemplates] = useState<CustomTabTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    onBusyChange?.(saving);
    return () => onBusyChange?.(false);
  }, [saving, onBusyChange]);
  useEffect(() => {
    if (mode !== 'template') return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void api
      .customTabTemplates(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setTemplates(items.filter((tab) => String(tab.dormitory_id) !== dormitoryId));
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить шаблоны.',
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [mode, dormitoryId, attempt]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving || (mode === 'template' && (loading || !!loadError || !sourceId))) return;
    if (!name.trim()) {
      setError('Укажите название вкладки.');
      return;
    }
    if (mode === 'blank' && withSubtabs && subtabs.some((item) => !item.trim())) {
      setError('Укажите название каждой подвкладки.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const tab = await api.createCustomTab(
        dormitoryId,
        name.trim(),
        mode === 'template' ? Number(sourceId) : null,
        mode === 'blank' && withSubtabs ? subtabs.map((item) => item.trim()) : [],
        parentId,
        parentSection,
      );
      onCreated(tab);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось создать вкладку.');
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <label>
        Основа вкладки
        <select
          value={mode}
          disabled={saving}
          onChange={(event) => {
            setMode(event.target.value);
            setSourceId('');
            setError('');
          }}
        >
          <option value="blank">Новая пустая вкладка</option>
          <option value="template">Вкладка из другого общежития</option>
        </select>
      </label>
      {mode === 'template' && (
        <>
          <label>
            Шаблон вкладки
            <select
              value={sourceId}
              required
              disabled={loading || saving || !!loadError}
              onChange={(event) => {
                setSourceId(event.target.value);
                setName(templates.find((tab) => String(tab.id) === event.target.value)?.name ?? '');
              }}
            >
              <option value="">Выберите вкладку</option>
              {templates.map((tab) => (
                <option value={tab.id} key={tab.id}>
                  {tab.client_name} · {tab.dormitory_name} — {tab.name}
                  {tab.table_created ? '' : ' (без таблицы)'}
                </option>
              ))}
            </select>
          </label>
          {loading && <p role="status">Загружаем шаблоны…</p>}
          {loadError && (
            <p role="alert">
              {loadError}{' '}
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Повторить
              </button>
            </p>
          )}
          {!loading && !loadError && !templates.length && (
            <p className={styles.help}>В других общежитиях пока нет пользовательских вкладок.</p>
          )}
          <p className={styles.help}>
            Копируются название и структура таблицы без строк. Изменения исходной вкладки не
            повлияют на эту копию.
          </p>
        </>
      )}
      <label>
        {parentId || parentSection ? 'Название подвкладки' : 'Название вкладки'}
        <input
          value={name}
          maxLength={120}
          required
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {mode === 'blank' && (
        <>
          <label className={styles.subtabToggle}>
            <input
              type="checkbox"
              checked={withSubtabs}
              disabled={saving}
              onChange={(event) => setWithSubtabs(event.target.checked)}
            />
            Создать вкладку с подвкладками
          </label>
          {withSubtabs && (
            <>
              {subtabs.map((value, index) => (
                <div key={index} className={styles.subtabFields}>
                  <label>
                    Название подвкладки {index + 1}
                    <input
                      value={value}
                      maxLength={120}
                      required
                      disabled={saving}
                      onChange={(event) =>
                        setSubtabs((items) =>
                          items.map((item, i) => (i === index ? event.target.value : item)),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={saving || subtabs.length === 1}
                    onClick={() => setSubtabs((items) => items.filter((_, i) => i !== index))}
                  >
                    Убрать
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={styles.subtabAdd}
                disabled={saving}
                onClick={() => setSubtabs((items) => [...items, ''])}
              >
                + Добавить подвкладку
              </button>
              <p className={styles.help}>
                В каждой подвкладке можно будет создать свою таблицу. Подвкладки можно добавлять и
                позже.
              </p>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" disabled={saving} onClick={onClose}>
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving || (mode === 'template' && (loading || !!loadError || !sourceId))}
        >
          {saving ? 'Создаём…' : 'Создать вкладку'}
        </button>
      </div>
    </form>
  );
  return inline ? (
    <div style={{ overflowY: 'auto', padding: 24 }}>
      <h3>{parentId || parentSection ? 'Добавить подвкладку' : 'Добавить вкладку'}</h3>
      {content}
    </div>
  ) : (
    <Modal
      title={parentId || parentSection ? 'Добавить подвкладку' : 'Добавить вкладку'}
      onClose={onClose}
      closeDisabled={saving}
      testId="create-custom-tab-modal"
    >
      {content}
    </Modal>
  );
}
