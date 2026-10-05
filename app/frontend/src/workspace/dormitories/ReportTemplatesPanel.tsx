import { useEffect, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { ReportTemplate } from '../../api/client';
import styles from './Dormitories.module.css';

export function ReportTemplatesPanel(): JSX.Element {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .reportTemplates(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(items)) throw new Error('Invalid templates response');
          setTemplates(items);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  async function remove(templateId: number): Promise<void> {
    if (deletingId !== null) return;
    setDeletingId(templateId);
    setDeleteError('');
    try {
      await api.deleteReportTemplate(templateId);
      setTemplates((items) => items.filter((item) => item.id !== templateId));
      setConfirmId(null);
    } catch (caught) {
      setDeleteError(caught instanceof ApiError ? caught.message : 'Не удалось удалить шаблон.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className={styles.templateSection} aria-label="Шаблоны отчётов">
      <h2>Шаблоны отчётов</h2>
      <p>Сохраните шаблон из большого отчёта, затем выберите его при создании общежития.</p>
      {status === 'loading' && <p>Загружаем шаблоны…</p>}
      {status === 'error' && (
        <p>
          Не удалось загрузить шаблоны.{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить загрузку шаблонов
          </button>
        </p>
      )}
      {status === 'ready' && templates.length === 0 && <p>Сохранённых шаблонов пока нет.</p>}
      {deleteError && <p role="alert">{deleteError}</p>}
      {status === 'ready' && templates.length > 0 && (
        <ul className={styles.templateList}>
          {templates.map((template) => (
            <li key={template.id}>
              <div>
                <strong>{template.name}</strong> <span>· {template.row_count} строк</span>
              </div>
              {confirmId === template.id ? (
                <div className={styles.templateActions}>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    disabled={deletingId !== null}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(template.id)}
                    disabled={deletingId !== null}
                    aria-label={`Подтвердить удаление шаблона ${template.name}`}
                  >
                    {deletingId === template.id ? 'Удаляем…' : 'Подтвердить удаление'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(template.id)}
                  aria-label={`Удалить шаблон ${template.name}`}
                  disabled={deletingId !== null}
                >
                  Удалить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
