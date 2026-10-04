import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import { WorkspaceIcon } from '../WorkspaceIcon';
import styles from './Dormitories.module.css';

export function DormitoryDetails(): JSX.Element {
  const { dormitoryId = '' } = useParams();
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .dormitory(dormitoryId, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setStatus(
            error instanceof ApiError && [404, 422].includes(error.status) ? 'missing' : 'error',
          );
      });
    return () => controller.abort();
  }, [dormitoryId, attempt]);

  return (
    <section className={styles.page} aria-label="Общежитие" data-testid="dormitory-details-page">
      <Link
        to="/cabinet/dormitories"
        className={styles.backLink}
        data-testid="dormitory-back"
        data-workspace-focus
      >
        <WorkspaceIcon name="chevron" />
        Назад
      </Link>
      {status === 'loading' && (
        <p className={styles.status} role="status">
          Загружаем общежитие…
        </p>
      )}
      {status === 'missing' && (
        <p className={styles.error} role="alert">
          Общежитие не найдено.
        </p>
      )}
      {status === 'error' && (
        <div className={styles.error} role="alert">
          <p>Не удалось загрузить общежитие.</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => setAttempt((current) => current + 1)}
          >
            Повторить
          </button>
        </div>
      )}
    </section>
  );
}
