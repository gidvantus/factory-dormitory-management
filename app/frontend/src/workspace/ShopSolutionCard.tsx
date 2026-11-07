import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { Solution } from '../api/client';
import { TariffPrice } from '../components/TariffPrice';
import { ArrowRightIcon, CheckIcon } from '../components/landing/icons';
import {
  EXTRA_MEMBER_CODE,
  MAX_SEATS_PER_PURCHASE,
  TELEGRAM_NOTIFICATIONS_CODE,
} from './solutions';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Shop.module.css';

const TELEGRAM_FEATURES = [
  'События в привычном мессенджере',
  'Выбор нужных уведомлений',
  'Тестовое сообщение для проверки связи',
];

/** Нижняя граница счётчика мест: контракт `CreateInvoiceRequest.seats` (`gt=0`). */
const MIN_SEATS = 1;

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

/**
 * Подпись срока подключённого решения.
 *
 * Своего срока у решения больше нет (#195): право действует, пока действует тариф
 * организации, а `expires_at` — конец этого тарифа (`null` у бессрочного). Дату
 * форматирует клиент: сервер отдаёт момент, а не готовую строку.
 */
function expiryLabel(solution: Solution): string {
  const live = 'Действует, пока действует тариф';
  if (!solution.expires_at) return live;
  const date = new Date(solution.expires_at);
  if (Number.isNaN(date.getTime())) return `${live} · до ${solution.expires_at}`;
  return `${live} · до ${date.toLocaleDateString('ru-RU')}`;
}

/**
 * Сумма денег для показа человеку.
 *
 * Считается **только для подсказки о цене места**: сумму счёта складывает сервер,
 * и в теле запроса её нет. Точную подпись счёта («2 700 ₽ разово») экран получает
 * готовой в `amount_label` после покупки.
 */
function money(amount: string, currency: string): string {
  const value = Number(amount);
  const symbol = currency === 'RUB' ? '₽' : currency;
  if (!Number.isFinite(value)) return `${amount} ${symbol}`;
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
  return `${formatted} ${symbol}`;
}

/**
 * Итог по количеству мест: «900 ₽ × 3 = 2 700 ₽».
 *
 * Ничего не отправляется на сервер: это подсказка перед покупкой, а сумму счёта
 * считает бэкенд (`amount = row.amount * quantity`).
 */
function seatsTotalLabel(solution: Solution, seats: number): string {
  const unit = money(solution.amount, solution.currency);
  const total = money(String(Number(solution.amount) * seats), solution.currency);
  return `${unit} × ${seats} = ${total}`;
}

/** «01 Витрина»: данные и состояние покупки принадлежат каталогу, а не макету. */
export function ShopSolutionCard({
  solution,
  buying,
  onBuy,
}: {
  solution: Solution;
  buying: number | null;
  onBuy: (id: number, seats?: number) => void;
}): JSX.Element {
  const telegram = solution.code === TELEGRAM_NOTIFICATIONS_CODE;
  const extraSeats = solution.code === EXTRA_MEMBER_CODE;
  const pending = buying === solution.id;
  // Счётчик количества живёт в карточке: мест покупают одно решение, и второй
  // карточке это число не принадлежит. Строкой, а не числом, — чтобы поле можно
  // было очистить и ввести число заново, не теряя курсор.
  const [draft, setDraft] = useState(String(MIN_SEATS));
  const seats = Number(draft);
  const seatsValid =
    /^\d+$/.test(draft) &&
    Number.isInteger(seats) &&
    seats >= MIN_SEATS &&
    seats <= MAX_SEATS_PER_PURCHASE;

  function stepSeats(delta: number): void {
    const next = Math.min(
      MAX_SEATS_PER_PURCHASE,
      Math.max(MIN_SEATS, (Number.isInteger(seats) ? seats : MIN_SEATS) + delta),
    );
    setDraft(String(next));
  }

  return (
    <article
      className={styles.showcase}
      data-testid="solution-card"
      data-owned={solution.is_owned || undefined}
      data-seats={extraSeats || undefined}
      aria-labelledby={`solution-${solution.id}-title`}
    >
      <div className={styles.main} data-telegram={telegram}>
        <div className={styles.copy}>
          <div className={styles.row}>
            <span className={styles.productIcon}>
              {telegram ? <TelegramIcon /> : <WorkspaceIcon name="info" />}
            </span>
            {/* Места — предмет счёта, а не право доступа: «Подключено» и срок
                у них не выводятся, счётчик мест растёт только оплатой. */}
            {!extraSeats && (
              <span
                className={styles.status}
                data-owned={solution.is_owned}
                data-testid={solution.is_owned ? 'solution-owned' : undefined}
              >
                <span />
                {solution.is_owned ? 'Подключено' : 'Дополнительное решение'}
              </span>
            )}
            {extraSeats && <span className={styles.status}>Докупается сверх тарифа</span>}
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
          <span className={styles.caption}>
            {extraSeats ? 'Цена за одно место' : 'В рамках действующего тарифа'}
          </span>
          <TariffPrice
            label={solution.price_label}
            className={styles.price}
            testId="solution-price"
          />
        </div>
        <div className={styles.purchaseAction}>
          {extraSeats ? (
            <>
              <div className={styles.quantityRow}>
                <label className="field__label" htmlFor={`seats-quantity-${solution.id}`}>
                  Количество мест
                </label>
                <div className={styles.stepper}>
                  <button
                    className="btn btn--ghost btn--compact"
                    type="button"
                    aria-label="Уменьшить количество мест"
                    disabled={pending || (seatsValid && seats === MIN_SEATS)}
                    onClick={() => stepSeats(-1)}
                  >
                    −
                  </button>
                  <input
                    id={`seats-quantity-${solution.id}`}
                    data-testid="seats-quantity"
                    type="number"
                    inputMode="numeric"
                    min={MIN_SEATS}
                    max={MAX_SEATS_PER_PURCHASE}
                    step={1}
                    value={draft}
                    disabled={pending}
                    aria-invalid={!seatsValid || undefined}
                    aria-describedby={`seats-quantity-hint-${solution.id}${
                      seatsValid ? '' : ` seats-quantity-error-${solution.id}`
                    }`}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    className="btn btn--ghost btn--compact"
                    type="button"
                    aria-label="Увеличить количество мест"
                    disabled={pending || (seatsValid && seats === MAX_SEATS_PER_PURCHASE)}
                    onClick={() => stepSeats(1)}
                  >
                    +
                  </button>
                </div>
              </div>
              {!seatsValid && (
                <p
                  className={styles.quantityError}
                  id={`seats-quantity-error-${solution.id}`}
                  role="alert"
                  data-testid="seats-quantity-error"
                >
                  Введите целое число от {MIN_SEATS} до {MAX_SEATS_PER_PURCHASE}.
                </p>
              )}
              <span
                className={styles.seatsTotal}
                id={`seats-quantity-hint-${solution.id}`}
                aria-live="polite"
                data-testid="seats-total"
              >
                {seatsValid ? seatsTotalLabel(solution, seats) : '—'}
              </span>
              <button
                className={`btn btn--primary btn--compact ${styles.action}`}
                type="button"
                data-testid="seats-buy"
                aria-label={`${pending ? 'Выставляем счёт' : 'Купить места'}: ${solution.name}`}
                aria-busy={pending || undefined}
                disabled={buying !== null || !seatsValid}
                onClick={() => onBuy(solution.id, seats)}
              >
                {pending ? 'Выставляем счёт…' : 'Купить места'}
                <ArrowRightIcon />
              </button>
            </>
          ) : (
            <>
              {/* Купленное решение не продаётся второй раз: доплата за него —
                  тихая двойная продажа, и сервер отвечает на неё `409`. Вместо
                  кнопки карточка объясняет, сколько право ещё действует. */}
              {solution.is_owned ? (
                <span className={styles.caption} data-testid="solution-expiry">
                  {expiryLabel(solution)}
                </span>
              ) : (
                <button
                  className={`btn btn--primary btn--compact ${styles.action}`}
                  type="button"
                  data-testid="solution-buy"
                  aria-label={`${pending ? 'Выставляем счёт' : 'Купить'}: ${solution.name}`}
                  aria-busy={pending || undefined}
                  disabled={buying !== null}
                  onClick={() => onBuy(solution.id)}
                >
                  {pending ? 'Выставляем счёт…' : 'Купить'}
                  <ArrowRightIcon />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
