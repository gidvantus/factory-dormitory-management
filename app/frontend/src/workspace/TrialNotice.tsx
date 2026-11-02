import { Link } from 'react-router-dom';

import { useSubscription } from '../auth/SubscriptionProvider';
import { useTrial } from '../auth/TrialProvider';
import { daysPhrase, formatTariffDate } from '../components/tariffText';
import styles from './Workspace.module.css';

/**
 * Сообщение о сроке тарифа на обзоре.
 *
 * Два состояния, и оба — про доступ, а не про ошибку:
 *
 * - **тариф скоро кончится** (`is_expiring`, то есть осталось 14 дней или
 *   меньше): полоса «Тариф истекает через N дней» с датой и ссылкой на прайс.
 *   Признак и число дней считает сервер: клиент не вычитает дни из `ends_at` и
 *   не держит вторую копию правила «за 14 дней предупредить». При
 *   `days_left > 14` полосы нет вовсе — остаток дней виден в ленте тарифа;
 * - **кабинет закрыт** (`locked`): рабочие разделы недоступны, обзор открыт.
 *
 * Чего блок не показывает — имени и даты закрывшегося тарифа. `/api/tariffs/current`
 * отдаёт `tariff: null` и `ends_at: null`, когда срок истёк и продления нет, а
 * отдельного поля «истёкший период» контракт не объявляет: по ответу нельзя
 * отличить кончившийся тариф от пробного периода. Поэтому текст общий для обоих
 * случаев и не называет ни имени, ни даты, которых нет в ответе.
 */
export function TrialNotice(): JSX.Element | null {
  const { state: subscription } = useSubscription();
  const { state: trial } = useTrial();

  if (subscription?.is_expiring) {
    const days = subscription.days_left;
    const endsAt = subscription.ends_at ? formatTariffDate(subscription.ends_at) : '';
    const name = subscription.tariff ? `«${subscription.tariff.name}»` : 'Тариф';
    const next = subscription.next;
    return (
      <section className={styles['tariff-notice']} role="status" data-testid="tariff-notice">
        <div className={styles['tariff-notice-copy']}>
          <h2 className={styles['tariff-notice-title']}>
            Тариф истекает через <span data-testid="tariff-notice-days">{daysPhrase(days)}</span>
          </h2>
          <p className={styles['tariff-notice-text']}>
            {name} оплачен до {endsAt}.{' '}
            {next
              ? `С ${formatTariffDate(next.starts_at)} начнётся «${next.tariff.name}» — кабинет продолжит работать, доплачивать не нужно.`
              : 'Продлите тариф, чтобы кабинет не закрылся и разделы остались на месте.'}
          </p>
        </div>
        <Link
          className={`btn btn--primary btn--compact ${styles['tariff-notice-link']}`}
          to="/pricing"
          data-testid="tariff-notice-link"
        >
          Открыть тарифы
        </Link>
      </section>
    );
  }

  if (!trial?.locked) return null;

  return (
    <section className={styles['tariff-expired']} role="status" data-testid="tariff-expired-notice">
      <h2 className={styles['tariff-expired-title']}>Кабинет закрыт</h2>
      <p>
        Срок тарифа или пробного периода закончился. Выберите тариф, чтобы вернуть рабочие разделы —
        данные и сотрудники сохранены.
      </p>
      <Link
        className="btn btn--primary btn--compact"
        to="/pricing"
        data-testid="tariff-expired-link"
      >
        Выбрать тариф
      </Link>
    </section>
  );
}
