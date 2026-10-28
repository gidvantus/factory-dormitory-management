import { useSubscription } from '../auth/SubscriptionProvider';
import { formatTariffDate } from '../components/tariffText';
import styles from './Workspace.module.css';

/**
 * Два периода подписки под лентой тарифа: действующий и оплаченный вперёд.
 *
 * Блок нужен ровно в одном состоянии — когда оплачен и следующий период.
 * Иначе он повторял бы ленту: «Ваш тариф» уже говорит, до какого числа
 * действует оплата.
 *
 * Начало текущего периода не показывается: контракт отдаёт только `ends_at`, а
 * вычитать срок из даты на клиенте запрещено — срок считает сервер. Поэтому у
 * действующего периода видно «до», у будущего — «с» (это `next.starts_at`,
 * ровно момент конца текущего: граница исключающая).
 */
export function TariffPeriods(): JSX.Element | null {
  const { state } = useSubscription();
  const current = state?.tariff ?? null;
  const next = state?.next ?? null;

  if (current === null || next === null) return null;

  const endsAt = state?.ends_at ? formatTariffDate(state.ends_at) : '';

  return (
    <section className={styles['tariff-periods']} data-testid="tariff-next">
      <p className={styles['tariff-periods-line']}>
        <strong>Сейчас:</strong> «{current.name}»{endsAt ? ` · до ${endsAt}` : ''}
      </p>
      <p className={styles['tariff-periods-line']}>
        <strong>Оплачено вперёд:</strong> «{next.tariff.name}» · с{' '}
        {formatTariffDate(next.starts_at)}
      </p>
    </section>
  );
}
