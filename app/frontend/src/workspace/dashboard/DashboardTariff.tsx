import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type { Tariff } from '../../api/client';
import { WorkspaceIcon } from '../WorkspaceIcon';
import styles from './Dashboard.module.css';

const LOAD_ERROR = 'Не удалось загрузить тариф организации';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status !== 401) return error.message;
  return LOAD_ERROR;
}

/**
 * Тариф организации в обзоре: тот же, что и в разделе «Тариф».
 *
 * Настройка живёт в разделе «Тариф», здесь только показ — поэтому ошибка
 * загрузки не закрывает дашборд и не превращается в красную плашку на весь
 * экран: показатели обзора важнее, а строка про тариф сообщает о себе
 * сдержанно и предлагает повторить запрос.
 */
export function DashboardTariff(): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tariff, setTariff] = useState<Tariff | null>(null);
  const [error, setError] = useState('');
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
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(caught));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <section
      className={styles.tariffCard}
      aria-labelledby="dashboard-tariff-title"
      data-testid="dashboard-tariff"
      data-status={status}
    >
      <div className={styles.tariffCardHead}>
        <div>
          <h2 className={styles.tariffCardTitle} id="dashboard-tariff-title">
            Ваш тариф
          </h2>
          <p className={styles.tariffCardHint}>Купленный тариф организации</p>
        </div>
        <span className={styles.blockIcon} data-tone="mint">
          <WorkspaceIcon name="chart" />
        </span>
      </div>

      {status === 'loading' && (
        <p className={styles.tariffCardNote} role="status" data-testid="dashboard-tariff-loading">
          Загружаем тариф…
        </p>
      )}

      {status === 'error' && (
        <p className={styles.tariffCardNote} role="status" data-testid="dashboard-tariff-error">
          {error}.{' '}
          <button
            className={styles.tariffCardRetry}
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </p>
      )}

      {status === 'ready' && !tariff && (
        <p className={styles.tariffCardNote} data-testid="dashboard-tariff-empty">
          Тариф не выбран.{' '}
          <Link to="/cabinet/tariffs" data-testid="dashboard-tariff-link">
            Выбрать тариф
          </Link>
        </p>
      )}

      {status === 'ready' && tariff && (
        <>
          <p className={styles.tariffCardValue} data-testid="dashboard-tariff-price">
            {tariff.price_label}
          </p>
          <p className={styles.tariffCardName} data-testid="dashboard-tariff-name">
            {tariff.name}
          </p>
          <p className={styles.tariffCardNote}>
            <Link to="/cabinet/tariffs" data-testid="dashboard-tariff-link">
              Подробнее о тарифе
            </Link>
          </p>
        </>
      )}
    </section>
  );
}
