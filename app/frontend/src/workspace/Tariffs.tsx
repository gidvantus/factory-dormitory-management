import { useEffect, useState } from 'react';

import { api, ApiError } from '../api/client';
import type { Tariff } from '../api/client';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Workspace.module.css';

const LOAD_ERROR = 'Не удалось загрузить тариф. Проверьте соединение и попробуйте ещё раз.';

const EMPTY_NOTICE = 'Тариф организации ещё не назначен';
const EMPTY_HINT =
  'Тариф привязывается при покупке или администратором платформы. Здесь он только показывается.';

/** Сервер объясняет отказ точнее общего текста. */
function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return LOAD_ERROR;
}

/**
 * Раздел «Тариф»: купленный тариф организации, только чтение.
 *
 * Кабинет тариф не выбирает и не правит: привязка появляется при покупке или
 * усилиями администратора платформы. Поэтому экран не выводит права из `role` и
 * не показывает кнопок — роль здесь ни на что не влияет, а тот же тариф виден
 * плиткой в обзоре.
 */
export function Tariffs(): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tariff, setTariff] = useState<Tariff | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .currentTariff(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setTariff(data.tariff);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(loadErrorMessage(error));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  function reload(): void {
    setAttempt((value) => value + 1);
  }

  return (
    <section aria-labelledby="tariffs-title" data-testid="tariffs-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="tariffs-title" tabIndex={-1}>
            Тариф
          </h1>
          <p className={styles.subtitle}>Тариф вашей организации</p>
        </div>
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="tariffs-loading">
          Загружаем тариф…
        </p>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="tariffs-error">
          <p>{loadError}</p>
          <button type="button" onClick={reload}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && tariff && (
        <section
          className={styles['table-card']}
          aria-labelledby="tariff-current-title"
          data-testid="tariff-current"
        >
          <div className={styles['table-heading']}>
            <h2 id="tariff-current-title" data-testid="tariff-current-name">
              {tariff.name}
            </h2>
          </div>
          <div className={styles['tariff-card']}>
            {tariff.description && (
              <p
                className={styles['tariff-card-description']}
                data-testid="tariff-current-description"
              >
                {tariff.description}
              </p>
            )}
            <p className={styles['tariff-card-price']} data-testid="tariff-current-price">
              {tariff.price_label}
            </p>
            {tariff.unit_label && (
              <p className={styles['muted-cell']} data-testid="tariff-current-unit">
                {tariff.unit_label}
              </p>
            )}
          </div>
        </section>
      )}

      {status === 'ready' && !tariff && (
        <div className={styles['empty-state']} data-testid="tariffs-empty">
          <span className={styles['empty-state-icon']}>
            <WorkspaceIcon name="chart" />
          </span>
          <h2>{EMPTY_NOTICE}</h2>
          <p>{EMPTY_HINT}</p>
        </div>
      )}
    </section>
  );
}
