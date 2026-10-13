import { Link } from 'react-router-dom';

import { useTrial } from '../auth/TrialProvider';
import styles from './Workspace.module.css';

/**
 * Сообщение об окончании пробного периода на обзоре.
 *
 * У закрытого кабинета обзор — единственное место, где пользователь узнаёт,
 * почему разделы исчезли, поэтому блок заметный и со ссылкой на тарифы.
 * Идущий период здесь ничего не рисует: остаток дней показывает блок «Ваш
 * тариф», который стоит рядом.
 */
export function TrialNotice(): JSX.Element | null {
  const { state } = useTrial();

  if (!state?.locked) return null;

  return (
    <section className={styles['trial-expired']} role="status" data-testid="trial-expired-notice">
      <h2 className={styles['trial-expired-title']}>Пробный период закончился</h2>
      <p>Выберите тариф, чтобы вернуть рабочие разделы.</p>
      <Link
        className="btn btn--primary btn--compact"
        to="/cabinet/tariffs"
        data-testid="trial-expired-link"
      >
        Выбрать тариф
      </Link>
    </section>
  );
}
