import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type { Tariff } from '../../api/client';
import { useTrial } from '../../auth/TrialProvider';
import { TariffPrice } from '../../components/TariffPrice';
import { WorkspaceIcon } from '../WorkspaceIcon';
import styles from './DashboardTariff.module.css';

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

  const current = status === 'ready' ? tariff : null;
  const trialActive = !current && trial?.is_active && trial.ends_at !== null;

  return (
    <section
      className={styles.ribbon}
      aria-labelledby="dashboard-tariff-title"
      data-testid="dashboard-tariff"
      data-status={status}
      data-access={current ? 'paid' : trialActive ? 'trial' : 'none'}
    >
      <span className={styles.iconTile}>
        <WorkspaceIcon name={current ? 'chart' : 'house'} />
      </span>
      <div className={styles.copy}>
        <div className={styles.heading}>
          <h2 className={styles.title} id="dashboard-tariff-title">
            {current ? (
              <>
                Тариф «<span data-testid="dashboard-tariff-name">{current.name}</span>»
              </>
            ) : trialActive ? (
              'Пробный период активен'
            ) : (
              'Ваш тариф'
            )}
          </h2>
          {(current || trialActive) && (
            <span className={styles.status}>
              <span />
              {current ? 'Тариф активен' : 'Пробный доступ'}
            </span>
          )}
        </div>
        {status === 'loading' && (
          <p className={styles.note} role="status" data-testid="dashboard-tariff-loading">
            Загружаем тариф…
          </p>
        )}
        {status === 'error' && (
          <p className={styles.note} role="status" data-testid="dashboard-tariff-error">
            {error}
          </p>
        )}
        {status === 'ready' && !current && (
          <p className={styles.note} data-testid="dashboard-tariff-empty">
            Тариф не выбран.{' '}
            {trialActive
              ? 'Знакомьтесь с возможностями «Домового».'
              : 'Его условия появятся здесь после покупки.'}
          </p>
        )}
        {current?.description && <p className={styles.note}>{current.description}</p>}
      </div>
      {trialActive && trial && trial.ends_at !== null && (
        <p className={styles.term} role="status" data-testid="trial-days-left">
          <span className="visually-hidden">Пробный период: осталось </span>
          <strong>
            {trial.days_left} {daysWord(trial.days_left)}
          </strong>
          <span className="visually-hidden">, </span>
          <span>до {formatTrialEnd(trial.ends_at)}</span>
        </p>
      )}
      {current && (
        <TariffPrice
          label={current.price_label}
          className={`${styles.term} ${styles.price}`}
          testId="dashboard-tariff-price"
        />
      )}
      {status === 'error' && (
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Повторить
        </button>
      )}
      {current && (
        <Link
          className={`btn btn--ghost btn--compact ${styles.action}`}
          to="/cabinet/tariffs"
          data-testid="dashboard-tariff-link"
        >
          О тарифе
          <WorkspaceIcon name="chevron" />
        </Link>
      )}
      {status === 'ready' && !current && !trial?.locked && (
        <Link
          className={`btn btn--primary btn--compact ${styles.action}`}
          to="/pricing"
          data-testid="dashboard-tariff-choose"
        >
          Выбрать тариф
          <WorkspaceIcon name="chevron" />
        </Link>
      )}
    </section>
  );
}
