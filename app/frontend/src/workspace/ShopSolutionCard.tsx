import { Link } from 'react-router-dom';

import type { Solution } from '../api/client';
import { TariffPrice } from '../components/TariffPrice';
import { ArrowRightIcon, CheckIcon } from '../components/landing/icons';
import { TELEGRAM_NOTIFICATIONS_CODE } from './solutions';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Shop.module.css';

const TELEGRAM_FEATURES = [
  'События в привычном мессенджере',
  'Выбор нужных уведомлений',
  'Тестовое сообщение для проверки связи',
];

function TelegramIcon({ bell = false }: { bell?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {bell ? (
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      ) : (
        <>
          <path d="m21 3-6 18-4-8-8-4 18-6Z" />
          <path d="m11 13 5-5" />
        </>
      )}
    </svg>
  );
}

/** Иллюстрация решения: показ примера не отправляет сообщения в Telegram. */
function TelegramExample(): JSX.Element {
  return (
    <figure className={styles.chat} data-testid="solution-telegram-example">
      <div className={styles.chatHead}>
        <span className={styles.botAvatar}>
          <WorkspaceIcon name="house" />
        </span>
        <div>
          <strong>Домовой</strong>
          <span>Уведомления в Telegram</span>
        </div>
        <TelegramIcon bell />
      </div>
      <figcaption className={styles.exampleCaption}>Пример уведомления</figcaption>
      <div className={styles.chatBody}>
        <div className={styles.message}>
          <strong>Всё на связи 👋</strong>
          <p>
            Это тестовое уведомление от «Домового». Здесь будут появляться события, которые вас
            касаются.
          </p>
          <span className={styles.messageTime}>
            12:30 <CheckIcon />
          </span>
        </div>
        <div className={styles.messageHint}>
          <CheckIcon />
          Вы сами выбираете уведомления
        </div>
      </div>
    </figure>
  );
}

function expiryLabel(solution: Solution): string {
  if (!solution.expires_at) return 'Действует бессрочно';
  const date = new Date(solution.expires_at);
  if (Number.isNaN(date.getTime())) return `Действует до ${solution.expires_at}`;
  return `Действует до ${date.toLocaleDateString('ru-RU')}`;
}

/** «01 Витрина»: данные и состояние покупки принадлежат каталогу, а не макету. */
export function ShopSolutionCard({
  solution,
  buying,
  onBuy,
}: {
  solution: Solution;
  buying: number | null;
  onBuy: (id: number) => void;
}): JSX.Element {
  const telegram = solution.code === TELEGRAM_NOTIFICATIONS_CODE;
  const pending = buying === solution.id;
  const action = solution.is_owned && solution.period !== 'once' ? 'Продлить' : 'Купить';
  return (
    <article
      className={styles.showcase}
      data-testid="solution-card"
      data-owned={solution.is_owned || undefined}
      aria-labelledby={`solution-${solution.id}-title`}
    >
      <div className={styles.main} data-telegram={telegram}>
        <div className={styles.copy}>
          <div className={styles.row}>
            <span className={styles.productIcon}>
              {telegram ? <TelegramIcon /> : <WorkspaceIcon name="info" />}
            </span>
            <span
              className={styles.status}
              data-owned={solution.is_owned}
              data-testid={solution.is_owned ? 'solution-owned' : undefined}
            >
              <span />
              {solution.is_owned ? 'Подключено' : 'Дополнительное решение'}
            </span>
          </div>
          <h2
            className={styles.name}
            id={`solution-${solution.id}-title`}
            data-testid="solution-name"
          >
            {solution.name}
          </h2>
          {solution.description && (
            <p className={styles.description} data-testid="solution-description">
              {solution.description}
            </p>
          )}
          {telegram && (
            <ul className={styles.benefits}>
              {TELEGRAM_FEATURES.map((feature) => (
                <li key={feature}>
                  <CheckIcon />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          )}
          {telegram && solution.is_owned && (
            <Link className="btn btn--ghost btn--compact" to="/cabinet/notifications">
              Настроить уведомления
            </Link>
          )}
        </div>
        {telegram && (
          <div className={styles.scene}>
            <TelegramExample />
          </div>
        )}
      </div>
      <div className={styles.purchaseBar}>
        <div>
          <span className={styles.caption}>Дополнительно к вашему тарифу</span>
          <TariffPrice
            label={solution.price_label}
            className={styles.price}
            testId="solution-price"
          />
        </div>
        <div className={styles.purchaseAction}>
          {solution.is_owned && (
            <span className={styles.caption} data-testid="solution-expiry">
              {expiryLabel(solution)}
            </span>
          )}
          <button
            className={`btn btn--primary btn--compact ${styles.action}`}
            type="button"
            data-testid="solution-buy"
            aria-label={`${pending ? 'Выставляем счёт' : action}: ${solution.name}`}
            aria-busy={pending || undefined}
            disabled={buying !== null}
            onClick={() => onBuy(solution.id)}
          >
            {pending ? 'Выставляем счёт…' : action}
            <ArrowRightIcon />
          </button>
        </div>
      </div>
    </article>
  );
}
