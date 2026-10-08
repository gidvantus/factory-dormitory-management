import { useEffect, useState } from 'react';

import { api, ApiError } from '../../api/client';
import type { ReportTemplate, ReportTemplateDetail } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './Dormitories.module.css';

function TemplatePreview({
  template,
  onClose,
}: {
  template: ReportTemplate;
  onClose: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<ReportTemplateDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .reportTemplate(template.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setDetail(result);
          setStatus('ready');
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить шаблон.');
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [template.id, attempt]);

  return (
    <Modal title={`Шаблон «${template.name}»`} testId="report-template-preview" onClose={onClose}>
      {status === 'loading' && <p role="status">Загружаем строки шаблона…</p>}
      {status === 'error' && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </p>
      )}
      {status === 'ready' && detail && (
        <>
          <p className={styles.previewHint}>
            {detail.row_count} строк · сохранены названия, порядок и формулы. Значений ячеек в
            шаблоне нет.
          </p>
          {detail.rows.length ? (
            <ol className={styles.previewRows}>
              {detail.rows.map((row, index) => (
                <li key={`${row.position}-${row.name}`}>
                  <span className={styles.previewNumber}>{index + 1}</span>
                  <div>
                    <strong>{row.name}</strong>
                    {row.formula ? (
                      <code>{row.formula}</code>
                    ) : (
                      <span>{row.linked ? 'Связь с таблицей' : 'Вручную'}</span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>В этом шаблоне нет строк.</p>
          )}
        </>
      )}
      <div className={styles.dialogActions}>
        <button type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}

export function ReportTemplatesPanel(): JSX.Element {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [preview, setPreview] = useState<ReportTemplate | null>(null);

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
              <button
                type="button"
                className={styles.templateOpen}
                onClick={() => setPreview(template)}
                aria-label={`Посмотреть шаблон ${template.name}`}
              >
                <strong>{template.name}</strong> <span>· {template.row_count} строк</span>
              </button>
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
      {preview && <TemplatePreview template={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}
