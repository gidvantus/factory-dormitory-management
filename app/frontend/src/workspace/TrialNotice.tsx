import { Link } from 'react-router-dom';

import { useTrial } from '../auth/TrialProvider';
import styles from './Workspace.module.css';

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
 * Сообщение о пробном периоде на обзоре.
 *
 * У закрытого кабинета обзор — единственное место, где пользователь узнаёт,
 * почему разделы исчезли, поэтому блок заметный и со ссылкой на тарифы. Пока
 * период идёт, сообщение сдержанное: оно не должно спорить с карточкой тарифа.
 */
export function TrialNotice(): JSX.Element | null {
  const { state } = useTrial();

  if (!state) return null;

  if (state.locked) {
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

  if (!state.is_active || state.ends_at === null) return null;

  return (
    <p className={styles['trial-note']} role="status" data-testid="trial-days-left">
      Пробный период: осталось {state.days_left} {daysWord(state.days_left)}, до{' '}
      {formatTrialEnd(state.ends_at)}
    </p>
  );
}
