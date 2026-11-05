import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Modal } from '../../components/Modal';
import { SiteHeader } from '../../components/SiteHeader';
import { CheckIcon, ShieldCheckIcon, UsersIcon } from '../../components/landing/icons';
import { calculatePrice, getUserPrice, LICENSES, MAX_USERS, userLabel } from './pricing';
import type { LicenseTerm } from './pricing';
import { ComingSoonAddons, money, PreviewNavigation } from './PreviewShared';
import { ImprovementsStorePreview } from './ImprovementsStorePreview';
import styles from './PricingCalculatorPreview.module.css';

const features = [
  'Учёт проживающих',
  'Планирование заездов',
  'Заселение и переселение',
  'Списки на аванс и расчёт',
  'Настраиваемые таблицы',
  'Отчёты и статистика',
];

const discountExamples = [1, 10, 20, 30, 40, 50] as const;

/** Отдельный интерактивный макет: не обращается к покупке и не меняет тариф организации. */
export function PricingCalculatorPreview(): JSX.Element {
  const [searchParams] = useSearchParams();
  return searchParams.get('view') === 'store' ? (
    <ImprovementsStorePreview />
  ) : (
    <LicenseCalculatorPreview />
  );
}

function LicenseCalculatorPreview(): JSX.Element {
  const [draft, setDraft] = useState('0');
  const [term, setTerm] = useState<LicenseTerm>('halfYear');
  const [showOrder, setShowOrder] = useState(false);
  const license = LICENSES[term];
  const users = Number(draft);
  const valid = /^\d+$/.test(draft) && Number.isInteger(users) && users >= 0 && users <= MAX_USERS;
  const quote = valid ? calculatePrice(users, term) : null;

  function changeUsers(delta: number): void {
    setDraft(String(Math.min(MAX_USERS, Math.max(0, (valid ? users : 0) + delta))));
  }

  return (
    <div className={`app ${styles.page}`} data-testid="pricing-calculator-preview">
      <a className="skip-link" href="#calculator-main">
        К расчёту стоимости
      </a>
      <SiteHeader
        actions={
          <Link className="btn btn--outline btn--sm" to="/pricing">
            Тарифы
          </Link>
        }
      />

      <main id="calculator-main" className={styles.main}>
        <div className={styles.previewNote}>
          <span className={styles.previewBadge}>Тестовая страница</span>
          <span>Лицензия и дополнительные места для вашей команды</span>
        </div>
        <PreviewNavigation active="license" />

        <header className={styles.intro}>
          <h1>Лицензия на «Домовой»</h1>
          <p>
            Выберите лицензию на 6 месяцев или год и добавьте пользователей, если нужно больше мест.
          </p>
        </header>

        <section className={styles.calculator} aria-label="Калькулятор стоимости">
          <div className={styles.controls}>
            <div className={styles.controlHeading}>
              <span className={styles.teamIcon}>
                <UsersIcon />
              </span>
              <div>
                <h2>Настройте лицензию</h2>
              </div>
            </div>

            <div className={styles.configuration}>
              <fieldset className={styles.periodField}>
                <legend>Срок лицензии</legend>
                <div className={styles.periodToggle}>
                  {(['halfYear', 'year'] as const).map((option) => {
                    const plan = LICENSES[option];
                    return (
                      <button
                        key={option}
                        className="btn btn--segment"
                        type="button"
                        aria-pressed={term === option}
                        onClick={() => setTerm(option)}
                      >
                        <strong>
                          {plan.label} · {money(plan.price)}
                        </strong>
                        <span>{plan.includedUsers} пользователей в цене</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <div className={styles.quantityRow}>
                <label htmlFor="pricing-users">Дополнительные пользователи</label>
                <div className={styles.stepper}>
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Уменьшить количество пользователей"
                    disabled={valid && users === 0}
                    onClick={() => changeUsers(-1)}
                  >
                    −
                  </button>
                  <input
                    id="pricing-users"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={MAX_USERS}
                    step="1"
                    value={draft}
                    aria-invalid={!valid}
                    aria-describedby={`pricing-users-help${valid ? '' : ' pricing-users-error'}`}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Увеличить количество пользователей"
                    disabled={valid && users === MAX_USERS}
                    onClick={() => changeUsers(1)}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
            {!valid && (
              <p className={styles.error} id="pricing-users-error" role="alert">
                Введите целое число от 0 до 10 000.
              </p>
            )}
            <p className={styles.quantityHint}>
              <span id="pricing-users-help">
                Дополнительное место — {money(quote?.unitPrice ?? license.userPrice)} за полный срок
                лицензии.
              </span>
            </p>

            <ComingSoonAddons />
          </div>

          <aside className={styles.summary} aria-label="Стоимость для вашей команды">
            <div className={styles.summaryContent}>
              <div className={styles.summaryHeading}>
                <h2>Ваш заказ</h2>
                <span>
                  {quote
                    ? `${quote.totalUsers} ${userLabel(quote.totalUsers)}`
                    : 'Укажите количество'}
                </span>
              </div>
              <div className={styles.quote} aria-live="polite" aria-atomic="true">
                <p className={styles.total} data-testid="calculator-total">
                  {quote ? money(quote.total) : '—'}
                </p>
                <p className={styles.totalPeriod}>За весь срок лицензии · {license.label}</p>
              </div>

              <div className={styles.subscriptionItems}>
                <h3>Состав заказа</h3>
                <dl className={styles.itemLines}>
                  <div>
                    <dt>Лицензия · {license.label}</dt>
                    <dd>{money(license.price)}</dd>
                  </div>
                  <div>
                    <dt>Пользователи в лицензии · {license.includedUsers}</dt>
                    <dd>Включены</dd>
                  </div>
                  <div>
                    <dt>Доп. пользователи{valid ? ` · ${users}` : ''}</dt>
                    <dd data-testid="calculator-workplaces">
                      {quote ? money(quote.extraUsersTotal) : '—'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className={styles.savingTotal} data-testid="calculator-saving">
                <CheckIcon />
                <span>
                  {quote && quote.saving > 0
                    ? `Скидка ${quote.discount}% на доп. места · экономия ${money(quote.saving)}`
                    : 'До 50% скидки на дополнительные места'}
                </span>
              </div>
              <details className={styles.savingsDetails}>
                <summary>Скидки и условия оплаты</summary>
                <dl className={styles.savingLines}>
                  <div>
                    <dt>Цена одного доп. места за весь срок</dt>
                    <dd>{quote ? money(quote.unitPrice) : '—'}</dd>
                  </div>
                </dl>
                <p className={styles.billingNote}>
                  При оформлении дополнительные места оплачиваются за весь срок лицензии.
                </p>
              </details>
              <button
                type="button"
                className={`btn btn--primary ${styles.trialButton}`}
                disabled={!valid}
                onClick={() => setShowOrder(true)}
              >
                Посмотреть заказ
              </button>
            </div>
          </aside>
        </section>

        <section className={styles.included} aria-labelledby="included-title">
          <h2 id="included-title">Возможности лицензии</h2>
          <ul>
            {features.map((feature) => (
              <li key={feature}>
                <CheckIcon />
                {feature}
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.discounts} aria-labelledby="discount-title">
          <div className={styles.discountHeading}>
            <div>
              <h2 id="discount-title">Скидка на дополнительных пользователей</h2>
              <p>
                Цены для лицензии на {license.label}. От двух мест скидка в процентах равна их
                количеству, максимум 50%.
              </p>
            </div>
            <span className={styles.discountBadge}>До 50% на весь набор</span>
          </div>
          <ol className={styles.bandList}>
            {discountExamples.map((quantity) => {
              const { discount, unitPrice } = getUserPrice(quantity, term);
              const selected = valid && (users === quantity || (quantity === 50 && users > 50));
              return (
                <li key={quantity} data-used={selected}>
                  <span className={styles.bandLabel}>
                    {quantity === 50 ? '50+ пользователей' : quantity + ' ' + userLabel(quantity)}
                  </span>
                  <strong>{money(unitPrice)}</strong>
                  <span className={styles.bandUnit}>за пользователя</span>
                  <span className={styles.bandStatus}>
                    {selected && <CheckIcon />}
                    {discount ? 'Скидка ' + discount + '%' : 'Базовая цена'}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section className={styles.questions} aria-labelledby="questions-title">
          <div className={styles.questionsIntro}>
            <ShieldCheckIcon />
            <h2 id="questions-title">Докупка после оформления</h2>
            <p>Докупайте пользователей в личном кабинете в любой момент действия лицензии.</p>
          </div>
          <div className={styles.faq}>
            <div className={styles.proration}>
              <h3>Платите за оставшийся срок</h3>
              <p>
                При докупке пользователей стоимость пересчитывается пропорционально оставшемуся
                сроку действия лицензии с учётом скидки за количество. Вы платите только за время до
                окончания лицензии.
              </p>
            </div>
            <details>
              <summary>Кто считается пользователем?</summary>
              <p>
                Сотрудник с личным доступом в кабинет организации. Количество проживающих не влияет
                на стоимость лицензии.
              </p>
            </details>
            <details>
              <summary>Когда появятся дополнительные услуги?</summary>
              <p>
                Telegram-оповещения и журнал действий скоро будут доступны для подключения на всю
                компанию.
              </p>
            </details>
          </div>
        </section>

        <footer className={styles.footer}>
          <span>Домовой — учёт персонала и проживания</span>
          <Link to="/preview/pricing">Другие варианты оформления тарифов</Link>
        </footer>
      </main>

      {showOrder && quote && (
        <Modal
          title="Ваш заказ"
          testId="calculator-order"
          onClose={() => setShowOrder(false)}
          protectChanges={false}
        >
          <div className={styles.trialDialog}>
            <span className={styles.previewBadge}>Тестовый просмотр</span>
            <h3>
              Лицензия на {license.label} · {quote.totalUsers} {userLabel(quote.totalUsers)}
            </h3>
            <p>
              Стоимость за полный срок <strong>{money(quote.total)}</strong>.
            </p>
            <dl className={styles.dialogItems}>
              <div>
                <dt>Лицензия с {license.includedUsers} местами</dt>
                <dd>{money(license.price)}</dd>
              </div>
              <div>
                <dt>Доп. пользователи · {users}</dt>
                <dd>{money(quote.extraUsersTotal)}</dd>
              </div>
            </dl>
            <p>Это предварительный расчёт на тестовой странице.</p>
            <button type="button" className="btn btn--primary" onClick={() => setShowOrder(false)}>
              Вернуться к расчёту
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
