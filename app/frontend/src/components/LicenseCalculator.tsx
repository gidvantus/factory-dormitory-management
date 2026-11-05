import { useState } from 'react';

import type { ExtraSeatBand, TariffPeriod } from '../api/client';
import { CheckIcon, UsersIcon } from './landing/icons';
import { formatKopecks, toKopecks } from './money';
import styles from './LicenseCalculator.module.css';

/**
 * Строка прайса в том виде, в каком её показывает калькулятор.
 *
 * Числа сюда приходят готовыми: `amount` и `priceLabel` из ответа `/api/tariffs`,
 * `unit_amount` ступеней — из `/api/tariffs/extra-seats`. Калькулятор ничего не
 * зашивает и скидку сам не выводит: за каждый полный десяток мест её уже
 * посчитал сервер (`app/seats.py`), экран только умножает готовую цену места на
 * количество.
 */
export interface LicenseOption {
  /** Строка прайса: по `id` сервер выставляет счёт; у макета его нет. */
  id: number | null;
  period: TariffPeriod;
  /** Срок словами: «6 месяцев». */
  label: string;
  /** Имя строки прайса: «Домовой · 6 месяцев». */
  name: string;
  /** Цена лицензии строкой: «60000.00». */
  amount: string;
  /** Готовая подпись цены от сервера: «60 000 ₽ за 6 месяцев». */
  priceLabel: string;
  /** Сколько сотрудников включено в лицензию; `null` — без ограничения. */
  includedMembers: number | null;
}

/**
 * Заказ, который калькулятор передаёт странице.
 *
 * Деньги — в копейках и уже сложенные из серверных чисел: цена лицензии плюс
 * `unit_amount` ступени × количество мест. В теле запроса на покупку денег нет —
 * сумму счёта считает сервер, а это число нужно окну подтверждения.
 */
export interface LicenseOrder {
  tariff: LicenseOption;
  /** Сколько дополнительных мест докупается; `0` — только лицензия. */
  seats: number;
  /** Цена одного места на текущей ступени, в копейках. */
  unitKopecks: number;
  /** Сколько стоят места: `unitKopecks × seats`. */
  seatsTotalKopecks: number;
  /** Цена лицензии плюс места. */
  totalKopecks: number;
}

interface LicenseCalculatorProps {
  /** Видимые строки прайса: у публичной страницы их две — 6 и 12 месяцев. */
  licenses: LicenseOption[];
  /** Ступени скидки; `null` — места не продаются (`404 /extra-seats`). */
  bands: ExtraSeatBand[] | null;
  /** Потолок одной покупки мест: контракт разрешает 1…100. */
  maxQuantity: number;
  /** Что делать с заказом: страница открывает окно подтверждения. */
  onBuy: (order: LicenseOrder) => void;
  /**
   * Срок, выбранный при открытии: по умолчанию — первый в прайсе.
   *
   * Читается один раз при монтировании: подписка организации приходит запросом
   * позже прайса, поэтому страница пересоздаёт калькулятор по `key`, когда
   * `initialPeriod` появляется (см. `pages/Pricing.tsx`). Иначе выбранным
   * остался бы первый срок, а не срок действующей лицензии.
   */
  initialPeriod?: TariffPeriod;
}

/** Множественное число мест: «1 место», «5 мест». */
function seatsLabel(seats: number): string {
  const lastTwo = seats % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'мест';
  const last = seats % 10;
  return last === 1 ? 'место' : last >= 2 && last <= 4 ? 'места' : 'мест';
}

/** Предел мест лицензии словами: `null` — без ограничения. */
function includedLabel(included: number | null): string {
  return included === null ? 'без ограничения мест' : `до ${included} сотрудников в цене`;
}

/** Ступень, в которую попадает количество: границы включительные. */
function bandFor(bands: ExtraSeatBand[], seats: number): ExtraSeatBand {
  return (
    bands.find((band) => seats >= band.from && seats <= band.to) ??
    // Ноль мест — ещё не покупка, но цену места показываем базовую, первую ступень.
    bands[0]
  );
}

/**
 * Калькулятор лицензии: срок, дополнительные места и состав заказа.
 *
 * Вёрстка перенесена с макета `/preview/pricing-calculator` (страница осталась
 * тестовой и переиспользует этот же компонент, передавая свои числа пропсами), а
 * расчёт — серверный: цена лицензии и ступени приходят готовыми, страница
 * умножает цену места на количество и складывает с ценой лицензии. Скидку по
 * десяткам клиент не выводит, иначе она разошлась бы со счётом.
 *
 * Количество мест ограничено потолком продажи (`maxQuantity`): сервер отвечает
 * `422` на всё, что вне 1…100, поэтому поле не даёт ввести больше и объясняет
 * предел подсказкой. Покупку (`onBuy`) делает страница: у макета она открывает
 * предварительный заказ, у `/pricing` — окно подтверждения, и только там уходит
 * запрос.
 */
export function LicenseCalculator({
  licenses,
  bands,
  maxQuantity,
  onBuy,
  initialPeriod,
}: LicenseCalculatorProps): JSX.Element | null {
  const [chosen, setChosen] = useState<TariffPeriod | null>(initialPeriod ?? null);
  const [draft, setDraft] = useState('0');

  const license = licenses.find((option) => option.period === chosen) ?? licenses[0];
  if (license === undefined) return null;

  const seats = Number(draft);
  const valid =
    /^\d+$/.test(draft) && Number.isInteger(seats) && seats >= 0 && seats <= maxQuantity;
  const countedSeats = valid ? seats : 0;

  const band = bands === null ? null : bandFor(bands, countedSeats);
  const unitKopecks = band === null ? 0 : toKopecks(band.unit_amount);
  const seatsTotalKopecks = unitKopecks * countedSeats;
  const totalKopecks = toKopecks(license.amount) + seatsTotalKopecks;

  function changeSeats(delta: number): void {
    setDraft(String(Math.min(maxQuantity, Math.max(0, countedSeats + delta))));
  }

  function buy(): void {
    if (!valid) return;
    onBuy({
      tariff: license,
      seats: countedSeats,
      unitKopecks,
      seatsTotalKopecks,
      totalKopecks,
    });
  }

  return (
    <>
      <section
        className={styles.calculator}
        data-testid="license-calculator"
        aria-label="Калькулятор лицензии"
      >
        <div className={styles.controls}>
          <div className={styles.controlHeading}>
            <span className={styles.teamIcon}>
              <UsersIcon />
            </span>
            <h2>Настройте лицензию</h2>
          </div>

          <div className={styles.configuration}>
            <fieldset className={styles.periodField}>
              <legend>Срок лицензии</legend>
              <div className={styles.periodToggle}>
                {licenses.map((option) => (
                  <button
                    key={option.period}
                    className="btn btn--segment"
                    type="button"
                    aria-pressed={option.period === license.period}
                    data-testid={`license-term-${option.period}`}
                    onClick={() => setChosen(option.period)}
                  >
                    <strong>{option.label}</strong>
                    <span>{includedLabel(option.includedMembers)}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            {bands !== null && (
              <div className={styles.quantityRow}>
                <label htmlFor="license-seats-input">Дополнительные места</label>
                <div className={styles.stepper}>
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Уменьшить количество мест"
                    disabled={countedSeats === 0}
                    onClick={() => changeSeats(-1)}
                  >
                    −
                  </button>
                  <input
                    id="license-seats-input"
                    data-testid="license-seats"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={maxQuantity}
                    step="1"
                    value={draft}
                    aria-invalid={!valid}
                    aria-describedby={`license-seats-help${valid ? '' : ' license-seats-error'}`}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Увеличить количество мест"
                    disabled={valid && countedSeats === maxQuantity}
                    onClick={() => changeSeats(1)}
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          </div>

          {!valid && (
            <p className={styles.error} id="license-seats-error" role="alert">
              Введите целое число от 0 до {maxQuantity}.
            </p>
          )}

          <p className={styles.quantityHint} id="license-seats-help">
            {bands === null
              ? 'Дополнительные сотрудники не продаются: лицензия уже включает нужное количество мест.'
              : 'Скидка растёт за каждый полный десяток мест и действует на весь набор.'}
          </p>
        </div>

        <aside className={styles.summary} aria-label="Стоимость заказа">
          <div className={styles.summaryContent}>
            <div className={styles.summaryHeading}>
              <h2>Ваш заказ</h2>
              <span>
                {license.includedMembers === null
                  ? 'Места без ограничения'
                  : `${license.includedMembers + countedSeats} ${seatsLabel(
                      license.includedMembers + countedSeats,
                    )} всего`}
              </span>
            </div>
            <div className={styles.quote} aria-live="polite" aria-atomic="true">
              <p className={styles.total} data-testid="license-total">
                {formatKopecks(totalKopecks)}
              </p>
              <p className={styles.totalPeriod}>За весь срок лицензии · {license.label}</p>
            </div>

            <div className={styles.subscriptionItems}>
              <h3>Состав заказа</h3>
              <dl className={styles.itemLines}>
                <div>
                  <dt>Лицензия · {license.label}</dt>
                  <dd>{formatKopecks(toKopecks(license.amount))}</dd>
                </div>
                <div>
                  <dt>Сотрудников в лицензии</dt>
                  <dd>
                    {license.includedMembers === null ? 'Без ограничения' : license.includedMembers}
                  </dd>
                </div>
                <div>
                  <dt>Доп. места{valid ? ` · ${countedSeats}` : ''}</dt>
                  <dd data-testid="license-seat-total">{formatKopecks(seatsTotalKopecks)}</dd>
                </div>
                {band !== null && (
                  <div className={styles.seatUnit}>
                    <dt>Цена одного места</dt>
                    <dd data-testid="license-seat-unit">{formatKopecks(unitKopecks)}</dd>
                  </div>
                )}
              </dl>
            </div>

            {bands !== null && (
              <p className={styles.savingTotal}>
                <CheckIcon />
                <span>
                  {band !== null && band.discount_percent > 0
                    ? `Скидка ${band.discount_percent}% на весь набор мест`
                    : 'До 50% скидки на дополнительные места'}
                </span>
              </p>
            )}

            <button
              className={`btn btn--primary ${styles.buyButton}`}
              type="button"
              data-testid="license-buy"
              disabled={!valid}
              onClick={buy}
            >
              Посмотреть заказ
            </button>
          </div>
        </aside>
      </section>

      {bands !== null && (
        <section className={styles.discounts} aria-labelledby="license-bands-title">
          <div className={styles.discountHeading}>
            <div>
              <h2 id="license-bands-title">Скидка на дополнительные места</h2>
              <p>
                Цены одного места за полный срок лицензии «{license.label}». Скидка действует на
                весь набор: за каждый полный десяток мест — 10%, максимум 50%.
              </p>
            </div>
            <span className={styles.discountBadge}>До 50% на весь набор</span>
          </div>
          <ol className={styles.bandList}>
            {bands.map((option) => {
              const used = band !== null && option.from === band.from && option.to === band.to;
              return (
                <li key={`${option.from}-${option.to}`} data-testid="license-band" data-used={used}>
                  <span className={styles.bandLabel}>
                    {option.from === option.to ? option.from : `${option.from}–${option.to}`} мест
                  </span>
                  <strong>{formatKopecks(toKopecks(option.unit_amount))}</strong>
                  <span className={styles.bandUnit}>за место</span>
                  <span className={styles.bandStatus}>
                    {used && <CheckIcon />}
                    {option.discount_percent > 0
                      ? `Скидка ${option.discount_percent}%`
                      : 'Базовая цена'}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </>
  );
}
