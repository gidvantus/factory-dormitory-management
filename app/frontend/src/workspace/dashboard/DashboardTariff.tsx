import { Link } from 'react-router-dom';

import { useSubscription } from '../../auth/SubscriptionProvider';
import { useTrial } from '../../auth/TrialProvider';
import { TariffPrice } from '../../components/TariffPrice';
import { daysPhrase, daysWord, formatTariffDate } from '../../components/tariffText';
import { WorkspaceIcon } from '../WorkspaceIcon';
import styles from './DashboardTariff.module.css';

/**
 * Тариф организации в обзоре: единственное место в кабинете, где он назван.
 *
 * Раздела «Тарифы» в кабинете больше нет — прайс живёт на публичной странице
 * `/pricing`, и «О тарифе» ведёт туда же. Здесь только показ: тариф
 * привязывается при покупке или администратором платформы, а обзор ничего не
 * меняет — поэтому ошибка загрузки не закрывает дашборд и не превращается в
 * красную плашку на весь экран: показатели обзора важнее, а строка про тариф
 * сообщает о себе сдержанно и предлагает повторить запрос.
 *
 * Срок тарифа показывается здесь же: «Ваш тариф» — то место, где человек ищет
 * ответ, что с кабинетом и до какого числа он оплачен. У тарифа с известным
 * концом вместо цены стоит «Оплачен до <дата>» и остаток дней — те же данные,
 * что рисует предупреждение о скором конце (`TrialNotice`), но без текста
 * «истекает»: он появляется только при `is_expiring`. Остаток дней и дату
 * отдаёт сервер, клиент их не считает.
 *
 * Срок пробного периода показывается здесь по той же причине: пока тарифа нет,
 * это единственный срок, который у кабинета есть.
 */
export function DashboardTariff(): JSX.Element {
  const { state: subscription, status, error, reload } = useSubscription();
  const { state: trial } = useTrial();

  const current = status === 'ready' ? (subscription?.tariff ?? null) : null;
  const endsAt = current ? (subscription?.ends_at ?? null) : null;
  const daysLeft = subscription?.days_left ?? 0;
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
          <span>до {formatTariffDate(trial.ends_at)}</span>
        </p>
      )}
      {current && endsAt && (
        <p className={styles.term} role="status" data-testid="dashboard-tariff-ends">
          <strong>Оплачен до {formatTariffDate(endsAt)}</strong>
          {daysLeft > 0 && <span>осталось {daysPhrase(daysLeft)}</span>}
        </p>
      )}
      {current && !endsAt && (
        <TariffPrice
          label={current.price_label}
          className={`${styles.term} ${styles.price}`}
          testId="dashboard-tariff-price"
        />
      )}
      {status === 'error' && (
        <button type="button" className="btn btn--ghost btn--compact" onClick={reload}>
          Повторить
        </button>
      )}
      {current && (
        <Link
          className={`btn btn--ghost btn--compact ${styles.action}`}
          to="/pricing"
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
