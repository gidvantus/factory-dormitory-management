import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Modal } from '../../components/Modal';
import { SiteHeader } from '../../components/SiteHeader';
import { CheckIcon, UsersIcon } from '../../components/landing/icons';
import { calculateTopUp, LICENSES, MAX_USERS, userLabel } from './pricing';
import type { LicenseTerm } from './pricing';
import { ComingSoonAddons, money, PreviewNavigation } from './PreviewShared';
import styles from './PricingCalculatorPreview.module.css';

/** Макет докупки мест для действующей лицензии, без обращения к API оплаты. */
export function ImprovementsStorePreview(): JSX.Element {
  const [term, setTerm] = useState<LicenseTerm>('halfYear');
  const [remainingMonths, setRemainingMonths] = useState(3);
  const [draft, setDraft] = useState('10');
  const [showOrder, setShowOrder] = useState(false);
  const license = LICENSES[term];
  const currentUsers = license.includedUsers + 5;
  const users = Number(draft);
  const valid = /^\d+$/.test(draft) && Number.isInteger(users) && users >= 1 && users <= MAX_USERS;
  const quote = valid ? calculateTopUp(users, term, remainingMonths) : null;
  const active = remainingMonths > 0;

  function changeUsers(delta: number): void {
    setDraft(String(Math.min(MAX_USERS, Math.max(1, (valid ? users : 1) + delta))));
  }

  function changeTerm(value: LicenseTerm): void {
    setTerm(value);
    setRemainingMonths(LICENSES[value].months / 2);
  }

  return (
    <div className={`app ${styles.page}`} data-testid="improvements-store-preview">
      <a className="skip-link" href="#store-main">
        К магазину улучшений
      </a>
      <SiteHeader
        actions={
          <Link className="btn btn--outline btn--sm" to="/preview/pricing-calculator">
            Лицензия
          </Link>
        }
      />
      <main id="store-main" className={styles.main}>
        <div className={styles.previewNote}>
          <span className={styles.previewBadge}>Тестовая страница</span>
          <span>Пример магазина улучшений в личном кабинете</span>
        </div>
        <PreviewNavigation active="store" />
        <header className={styles.storeIntro}>
          <h1>Магазин улучшений</h1>
          <p>Добавляйте места для сотрудников по мере роста команды.</p>
        </header>

        <div className={styles.licenseContext} aria-label="Текущая лицензия компании">
          <div>
            <span>Ваша лицензия</span>
            <strong>{license.label}</strong>
          </div>
          <div>
            <span>Оставшийся срок</span>
            <strong>
              {remainingMonths} из {license.months} мес.
            </strong>
          </div>
          <div>
            <span>Доступно сейчас</span>
            <strong>
              {currentUsers} {userLabel(currentUsers)}
            </strong>
          </div>
          <span className={styles.licenseStatus} data-active={active}>
            {active ? 'Лицензия активна' : 'Срок истёк'}
          </span>
        </div>

        <section className={styles.calculator} aria-labelledby="topup-title">
          <div className={styles.controls}>
            <div className={styles.controlHeading}>
              <span className={styles.teamIcon}>
                <UsersIcon />
              </span>
              <h2 id="topup-title">Дополнительные пользователи</h2>
            </div>
            <p className={styles.storeDescription}>
              Новые места будут действовать до окончания текущей лицензии.
            </p>
            <div className={styles.storeQuantity}>
              <div className={styles.quantityRow}>
                <label htmlFor="store-users">Сколько мест добавить</label>
                <div className={styles.stepper}>
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Уменьшить количество мест"
                    disabled={valid && users === 1}
                    onClick={() => changeUsers(-1)}
                  >
                    −
                  </button>
                  <input
                    id="store-users"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max={MAX_USERS}
                    step="1"
                    value={draft}
                    aria-invalid={!valid}
                    aria-describedby={valid ? 'store-users-help' : 'store-users-error'}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Увеличить количество мест"
                    disabled={valid && users === MAX_USERS}
                    onClick={() => changeUsers(1)}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className={styles.storeSeatPrice} aria-live="polite">
                <strong>{quote && active ? money(quote.unitPrice) : '—'}</strong>
                <span>за одно место на оставшийся срок</span>
              </div>
            </div>
            {!valid && (
              <p className={styles.error} id="store-users-error" role="alert">
                Введите целое число от 1 до 10 000.
              </p>
            )}
            <p className={styles.quantityHint} id="store-users-help">
              Скидка зависит от числа мест в этой покупке. От 50 мест — 50%.
            </p>
            <div className={styles.storeResult} aria-live="polite">
              <span>
                Сейчас <strong>{currentUsers}</strong>
              </span>
              <span aria-hidden="true">+</span>
              <span>
                Добавляем <strong>{valid ? users : '—'}</strong>
              </span>
              <span aria-hidden="true">=</span>
              <span>
                Будет доступно{' '}
                <strong data-testid="store-total-users">
                  {valid ? currentUsers + users : '—'}
                </strong>
              </span>
            </div>
            <div className={styles.storeExplanation}>
              <CheckIcon />
              <p>
                Докупайте пользователей в любой момент действия лицензии. Стоимость пересчитывается
                пропорционально оставшемуся сроку с учётом скидки за количество.
              </p>
            </div>
          </div>

          <aside className={styles.summary} aria-label="Стоимость дополнительных мест">
            <div className={styles.summaryHeading}>
              <h2>К оплате</h2>
              <span>Разовая покупка</span>
            </div>
            <div className={styles.quote} aria-live="polite" aria-atomic="true">
              <p className={styles.total} data-testid="store-total">
                {quote && active ? money(quote.total) : '—'}
              </p>
              <p className={styles.totalPeriod}>
                {active
                  ? `На оставшиеся ${remainingMonths} мес.`
                  : 'Продлите лицензию, чтобы добавить места'}
              </p>
            </div>
            <div className={styles.subscriptionItems}>
              <dl className={styles.itemLines}>
                <div>
                  <dt>Места за полный срок · {valid ? users : '—'}</dt>
                  <dd>{valid ? money(users * license.userPrice) : '—'}</dd>
                </div>
                <div>
                  <dt>Скидка за количество{quote ? ` · ${quote.discount}%` : ''}</dt>
                  <dd>{quote ? `−${money(quote.saving)}` : '—'}</dd>
                </div>
                <div>
                  <dt>С учётом скидки</dt>
                  <dd>{quote ? money(quote.extraUsersTotal) : '—'}</dd>
                </div>
                <div>
                  <dt>
                    Остаток срока · {remainingMonths}/{license.months}
                  </dt>
                  <dd>{Math.round((remainingMonths / license.months) * 100)}%</dd>
                </div>
              </dl>
            </div>
            <p className={styles.storeBillingNote}>
              Лицензия уже оплачена. В этой покупке — только дополнительные места.
            </p>
            <button
              className={`btn btn--primary ${styles.trialButton}`}
              type="button"
              disabled={!valid || !active}
              onClick={() => setShowOrder(true)}
            >
              Докупить пользователей
            </button>
            <p className={styles.purchasePreviewNote}>Предварительный просмотр заказа</p>
          </aside>
        </section>

        <div className={styles.storeAddons}>
          <ComingSoonAddons />
        </div>
        <details className={styles.demoSettings}>
          <summary>Изменить данные примера</summary>
          <div className={styles.demoFields}>
            <label>
              Лицензия компании
              <select
                value={term}
                onChange={(event) => changeTerm(event.target.value as LicenseTerm)}
              >
                <option value="halfYear">6 месяцев</option>
                <option value="year">1 год</option>
              </select>
            </label>
            <label>
              Осталось месяцев
              <select
                value={remainingMonths}
                onChange={(event) => setRemainingMonths(Number(event.target.value))}
              >
                {Array.from({ length: license.months + 1 }, (_, months) => (
                  <option key={months} value={months}>
                    {months}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>Для макета используются примерные данные компании и остаток срока в месяцах.</p>
        </details>
        <footer className={styles.footer}>
          <span>Домовой — учёт персонала и проживания</span>
          <Link to="/preview/pricing-calculator">К выбору лицензии</Link>
        </footer>
      </main>

      {showOrder && quote && active && (
        <Modal
          title="Докупка пользователей"
          testId="store-order"
          onClose={() => setShowOrder(false)}
          protectChanges={false}
        >
          <div className={styles.trialDialog}>
            <span className={styles.previewBadge}>Тестовый просмотр</span>
            <h3>Дополнительные места · {users}</h3>
            <dl className={styles.dialogItems}>
              <div>
                <dt>Остаток лицензии</dt>
                <dd>
                  {remainingMonths} из {license.months} мес.
                </dd>
              </div>
              <div>
                <dt>Скидка за количество</dt>
                <dd>{quote.discount}%</dd>
              </div>
              <div>
                <dt>Будет доступно мест</dt>
                <dd>{currentUsers + users}</dd>
              </div>
              <div>
                <dt>К оплате</dt>
                <dd>{money(quote.total)}</dd>
              </div>
            </dl>
            <p>Это пример заказа. Места будут действовать до окончания текущей лицензии.</p>
            <button className="btn btn--primary" type="button" onClick={() => setShowOrder(false)}>
              Вернуться в магазин
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
