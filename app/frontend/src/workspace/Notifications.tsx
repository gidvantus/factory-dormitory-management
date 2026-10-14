import { Link } from 'react-router-dom';

import { TelegramNotifications } from './TelegramNotifications';
import { useSolutions } from './SolutionsProvider';
import { TELEGRAM_NOTIFICATIONS_CODE } from './solutions';
import styles from './Workspace.module.css';

/**
 * Раздел «Уведомления»: настройки Telegram на отдельной странице.
 *
 * Раньше карточка жила на «Личных данных» и была доступна всегда. Теперь это
 * платная функция: без действующего права организации на решение
 * `telegram_notifications` страница показывает состояние «решение не
 * подключено» со ссылкой в магазин, а не настройки.
 *
 * Право спрашивается у провайдера (`useSolutions`), а не запросом отсюда:
 * каталог уже загружен оболочкой, и второй запрос к тому же адресу только шумел
 * бы. Пока состояние неизвестно, показывается загрузка — сервер всё равно
 * закроет ручки 403, и гадать «есть право или нет» не нужно.
 */
export function Notifications(): JSX.Element {
  const { status, ownedCodes } = useSolutions();
  const hasAccess = ownedCodes.has(TELEGRAM_NOTIFICATIONS_CODE);

  return (
    <section aria-labelledby="notifications-title" data-testid="notifications-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="notifications-title" tabIndex={-1}>
            Уведомления
          </h1>
          <p className={styles.subtitle}>Сообщения о событиях, которые вас касаются</p>
        </div>
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="notifications-loading">
          Загружаем настройки…
        </p>
      )}

      {status !== 'loading' && hasAccess && <TelegramNotifications />}

      {status !== 'loading' && !hasAccess && (
        <div className={styles['empty-state']} data-testid="notifications-no-solution">
          <h2>Решение не подключено</h2>
          <p>Уведомления в Telegram — отдельное решение: подключите его в магазине улучшений.</p>
          <Link className="btn btn--primary btn--sm" to="/cabinet/shop">
            В магазин улучшений
          </Link>
        </div>
      )}
    </section>
  );
}
