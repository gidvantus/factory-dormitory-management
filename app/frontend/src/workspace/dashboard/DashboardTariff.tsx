import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type { Tariff } from '../../api/client';
import { useTrial } from '../../auth/TrialProvider';
import { WorkspaceIcon } from '../WorkspaceIcon';
import styles from './Dashboard.module.css';

const LOAD_ERROR = 'Не удалось загрузить тариф организации';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status !== 401) return error.message;
  return LOAD_ERROR;
}

/** Дата вида ДД.ММ.ГГГГ: сервер отдаёт ISO, человеку нужен привычный формат. */
function formatTrialEnd(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(date);
}

/** «осталось 5 дней»: без согласования числа текст читается как машинный. */
function daysWord(days: number): string {
  const tail = days % 100;
  if (tail >= 11 && tail <= 14) return 'дней';
  switch (days % 10) {
    case 1:
      return 'день';
    case 2:
    case 3:
    case 4:
      return 'дня';
    default:
      return 'дней';
  }
}

/**
 * Тариф организации в обзоре: тот же, что и в разделе «Тариф».
 *
 * Здесь только показ: тариф привязывается при покупке или администратором
 * платформы, а обзор ничего не меняет — поэтому ошибка загрузки не закрывает
 * дашборд и не превращается в красную плашку на весь экран: показатели обзора
 * важнее, а строка про тариф сообщает о себе сдержанно и предлагает повторить
 * запрос.
 *
 * Срок пробного периода показывается здесь же: «Ваш тариф» — то место, где
 * человек ищет ответ, что с кабинетом и сколько это ещё продлится, поэтому
 * остаток дней не живёт отдельной строкой над блоком.
 */
export function DashboardTariff(): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tariff, setTariff] = useState<Tariff | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const { state: trial } = useTrial();

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

      {trial?.is_active && trial.ends_at !== null && (
        <p className={styles.tariffCardTrial} role="status" data-testid="trial-days-left">
          Пробный период: осталось {trial.days_left} {daysWord(trial.days_left)}, до{' '}
          {formatTrialEnd(trial.ends_at)}
        </p>
      )}

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
          Тариф не выбран. Он появится здесь, когда организация купит тариф.
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
