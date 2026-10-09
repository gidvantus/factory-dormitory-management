import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client';
import type { Dormitory } from '../api/client';
import { CreateDormitoryDialog } from './dormitories/CreateDormitoryDialog';
import { ReportTemplatesPanel } from './dormitories/ReportTemplatesPanel';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Workspace.module.css';
import listStyles from './dormitories/Dormitories.module.css';

export function Dormitories(): JSX.Element {
  const [dormitories, setDormitories] = useState<Dormitory[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createdNotice, setCreatedNotice] = useState('');
  const createRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .dormitories(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setDormitories(items);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  function onCreated(dormitory: Dormitory): void {
    setDormitories((items) => [dormitory, ...items.filter((item) => item.id !== dormitory.id)]);
    setStatus('ready');
    setCreatedNotice(`Общежитие «${dormitory.name}» создано.`);
    setDialogOpen(false);
  }

  return (
    <section
      className={listStyles.page}
      aria-labelledby="dormitories-title"
      data-testid="dormitories-page"
    >
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="dormitories-title" tabIndex={-1}>
            Общежития
          </h1>
          <p className={styles.subtitle}>Список общежитий</p>
        </div>
        <button
          className={listStyles.createButton}
          type="button"
          ref={createRef}
          data-testid="create-dormitory-button"
          disabled={status === 'loading'}
          onClick={() => {
            setCreatedNotice('');
            setDialogOpen(true);
          }}
        >
          <span aria-hidden="true">＋</span>Создать общежитие
        </button>
      </div>
      {createdNotice && (
        <p className={listStyles.success} role="status">
          {createdNotice}
        </p>
      )}
      {status === 'loading' && (
        <p className={listStyles.status} role="status">
          Загружаем общежития…
        </p>
      )}
      {status === 'error' && (
        <div className={listStyles.error} role="alert">
          <p>Не удалось загрузить список общежитий.</p>
          <button
            className={listStyles.retryButton}
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Повторить
          </button>
        </div>
      )}
      {status === 'ready' && dormitories.length === 0 && (
        <div className={styles['empty-state']}>
          <span className={styles['empty-state-icon']}>
            <WorkspaceIcon name="house" />
          </span>
          <h2>Здесь появятся общежития</h2>
          <p>Создайте первое общежитие с помощью кнопки выше.</p>
        </div>
      )}
      {status === 'ready' && dormitories.length > 0 && (
        <ul className={listStyles.grid} aria-label="Список общежитий">
          {dormitories.map((dormitory) => (
            <li key={dormitory.id}>
              <Link
                to={`/cabinet/dormitories/${dormitory.id}`}
                className={listStyles.dormitoryCard}
                data-testid={`dormitory-card-${dormitory.id}`}
              >
                <span className={listStyles.cardIcon}>
                  <WorkspaceIcon name="house" />
                </span>
                <div className={listStyles.cardCopy}>
                  <h2 className={listStyles.clientName}>{dormitory.client_name}</h2>
                  <p className={listStyles.dormitoryName}>{dormitory.name}</p>
                </div>
                <span className={listStyles.cardArrow}>
                  <WorkspaceIcon name="chevron" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {status === 'ready' && <ReportTemplatesPanel />}
      {dialogOpen && (
        <CreateDormitoryDialog
          triggerRef={createRef}
          onClose={() => setDialogOpen(false)}
          onCreated={onCreated}
        />
      )}
    </section>
  );
}
