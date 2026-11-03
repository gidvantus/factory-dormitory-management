import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Modal } from '../../components/Modal';
import { SiteHeader } from '../../components/SiteHeader';
import { CheckIcon, ShieldCheckIcon, UsersIcon } from '../../components/landing/icons';
import { ADDONS, BASE_PRICE, calculatePrice, MAX_USERS, PRICE_BANDS, userLabel } from './pricing';
import type { AddonId, PaymentPeriod } from './pricing';
import styles from './PricingCalculatorPreview.module.css';

const money = (amount: number): string =>
  `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)} ₽`;

const features = [
  'Учёт проживающих',
  'Планирование заездов',
  'Заселение и переселение',
  'Списки на аванс и расчёт',
  'Настраиваемые таблицы',
  'Отчёты и статистика',
];

function AddonIcon({ id }: { id: AddonId }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {id === 'telegram' ? (
        <>
          <path d="m21 3-6 18-4-8-8-4 18-6Z" />
          <path d="m11 13 5-5" />
        </>
      ) : (
        <>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h3" />
        </>
      )}
    </svg>
  );
}

/** Отдельный интерактивный макет: не обращается к покупке и не меняет тариф организации. */
export function PricingCalculatorPreview(): JSX.Element {
  const [draft, setDraft] = useState('10');
  const [period, setPeriod] = useState<PaymentPeriod>('month');
  const [showTrial, setShowTrial] = useState(false);
  const [selectedAddons, setSelectedAddons] = useState<AddonId[]>([]);
  const users = Number(draft);
  const valid = /^\d+$/.test(draft) && Number.isInteger(users) && users >= 1 && users <= MAX_USERS;
  const quote = valid ? calculatePrice(users, period, selectedAddons) : null;
  const yearly = period === 'year';
  const suffix = yearly ? 'в год' : 'в месяц';
  const savingsSuffix = yearly ? 'за год' : 'в месяц';

  function changeUsers(delta: number): void {
    setDraft(String(Math.min(MAX_USERS, Math.max(1, (valid ? users : 1) + delta))));
  }

  function toggleAddon(id: AddonId): void {
    setSelectedAddons((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
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
          <span>Рабочие места и услуги · цена журнала предварительная</span>
        </div>

        <header className={styles.intro}>
          <h1>Одна подписка. Всё для вашей команды.</h1>
          <p>
            Выберите количество сотрудников и дополните тариф нужными услугами.
            <br className={styles.desktopBreak} /> Рабочие места — для каждого, услуги — для всей
            компании.
          </p>
        </header>

        <section className={styles.calculator} aria-label="Калькулятор стоимости">
          <div className={styles.controls}>
            <div className={styles.controlHeading}>
              <span className={styles.teamIcon}>
                <UsersIcon />
              </span>
              <div>
                <h2>Сколько вас в команде?</h2>
              </div>
            </div>

            <div className={styles.configuration}>
              <div className={styles.quantityRow}>
                <div>
                  <label htmlFor="pricing-users">Количество пользователей</label>
                </div>
                <div className={styles.stepper}>
                  <button
                    className="btn btn--stepper"
                    type="button"
                    aria-label="Уменьшить количество пользователей"
                    disabled={valid && users === 1}
                    onClick={() => changeUsers(-1)}
                  >
                    −
                  </button>
                  <input
                    id="pricing-users"
                    type="number"
                    inputMode="numeric"
                    min="1"
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
              <fieldset className={styles.periodField}>
                <legend>Период оплаты</legend>
                <div className={styles.periodToggle}>
                  <button
                    className="btn btn--segment"
                    type="button"
                    aria-pressed={!yearly}
                    onClick={() => setPeriod('month')}
                  >
                    Месяц
                  </button>
                  <button
                    className="btn btn--segment"
                    type="button"
                    aria-pressed={yearly}
                    onClick={() => setPeriod('year')}
                  >
                    Год <span>2 месяца в подарок</span>
                  </button>
                </div>
              </fieldset>
            </div>
            {!valid && (
              <p className={styles.error} id="pricing-users-error" role="alert">
                Введите целое число от 1 до 10 000.
              </p>
            )}
            <p className={styles.quantityHint}>
              <span id="pricing-users-help">Проживающие не оплачиваются отдельно.</span>
            </p>

            <fieldset className={styles.addonsField}>
              <legend>Услуги для всей компании</legend>
              <p className={styles.addonsHint}>
                Фиксированная цена за компанию, независимо от числа сотрудников.
              </p>
              <div className={styles.addonList}>
                {ADDONS.map((addon) => {
                  const selected = selectedAddons.includes(addon.id);
                  return (
                    <label className={styles.addon} key={addon.id} data-selected={selected}>
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={`Добавить ${addon.name}`}
                        onChange={() => toggleAddon(addon.id)}
                      />
                      <span className={styles.addonContent}>
                        <span className={styles.addonTitle}>
                          <span className={styles.addonIcon} data-addon={addon.id}>
                            <AddonIcon id={addon.id} />
                          </span>
                          <strong>{addon.name}</strong>
                        </span>
                        <span className={styles.addonPrice}>
                          +{money(addon.monthlyPrice)} <span>в месяц</span>
                        </span>
                        <span className={styles.addonDescription}>
                          {addon.id === 'telegram'
                            ? 'Выселения — в Telegram сотрудников.'
                            : 'История изменений. Просмотр — у владельца.'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>

          <aside className={styles.summary} aria-label="Стоимость для вашей команды">
            <div className={styles.summaryContent}>
              <div className={styles.summaryHeading}>
                <h2>Ваша подписка</h2>
                <span>{valid ? `${users} ${userLabel(users)}` : 'Укажите количество'}</span>
              </div>
              <div className={styles.quote} aria-live="polite" aria-atomic="true">
                <p className={styles.total} data-testid="calculator-total">
                  {quote ? money(quote.total) : '—'}
                </p>
                <p className={styles.totalPeriod}>{suffix} за всю подписку</p>
              </div>

              <div className={styles.subscriptionItems}>
                <h3>Состав подписки</h3>
                <dl className={styles.itemLines}>
                  <div>
                    <dt>Рабочие места{valid ? ` · ${users}` : ''}</dt>
                    <dd data-testid="calculator-workplaces">
                      {quote ? money(quote.workplacesTotal) : '—'}
                    </dd>
                  </div>
                  {ADDONS.filter((addon) => selectedAddons.includes(addon.id)).map((addon) => (
                    <div key={addon.id}>
                      <dt>{addon.name}</dt>
                      <dd data-testid={`calculator-addon-${addon.id}`}>
                        {money(addon.monthlyPrice * (yearly ? 12 : 1))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className={styles.savingTotal} data-testid="calculator-saving">
                <CheckIcon />
                <span>
                  {quote && quote.saving > 0
                    ? `Экономия ${money(quote.saving)} ${savingsSuffix}`
                    : 'Скидка на дополнительные места — с 6-го пользователя'}
                </span>
              </div>
              <details className={styles.savingsDetails}>
                <summary>Скидки и условия оплаты</summary>
                <dl className={styles.savingLines}>
                  <div>
                    <dt>Без скидок</dt>
                    <dd>{quote ? money(quote.baseline) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Скидка за количество</dt>
                    <dd>{quote ? `−${money(quote.volumeSaving)}` : '—'}</dd>
                  </div>
                  {yearly && (
                    <div>
                      <dt>Два месяца рабочих мест</dt>
                      <dd>{quote ? `−${money(quote.annualSaving)}` : '—'}</dd>
                    </div>
                  )}
                </dl>
                <p className={styles.billingNote}>
                  {yearly
                    ? 'Рабочие места — 12 месяцев по цене 10. Услуги для компании оплачиваются за все 12 месяцев.'
                    : 'Услуги оплачиваются один раз за компанию в каждом периоде. При добавлении сотрудников их цена не меняется.'}
                </p>
              </details>
              <button
                type="button"
                className={`btn btn--primary ${styles.trialButton}`}
                disabled={!valid}
                onClick={() => setShowTrial(true)}
              >
                Попробовать «Домовой» бесплатно
              </button>
              <p className={styles.trialHint}>30 дней бесплатно. Без привязки карты.</p>
            </div>
          </aside>
        </section>

        <section className={styles.included} aria-labelledby="included-title">
          <h2 id="included-title">В каждом рабочем месте уже есть</h2>
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
              <h2 id="discount-title">Как уменьшается цена за место</h2>
              <p>Каждая сниженная цена действует только на места в своём диапазоне.</p>
            </div>
            <span className={styles.discountBadge}>Скидка считается сама</span>
          </div>
          <ol className={styles.bandList}>
            {PRICE_BANDS.map((band) => {
              const selected = valid && users >= band.from;
              return (
                <li key={band.from} data-used={selected}>
                  <span className={styles.bandLabel}>{band.label}</span>
                  <strong>{money(band.price)}</strong>
                  <span className={styles.bandUnit}>за место в месяц</span>
                  <span className={styles.bandStatus}>
                    {selected ? (
                      <>
                        <CheckIcon /> В вашем расчёте
                      </>
                    ) : band.price === BASE_PRICE ? (
                      'Базовая стоимость'
                    ) : (
                      'Для дополнительных мест'
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          <details className={styles.breakdown}>
            <summary>Посмотреть подробный расчёт</summary>
            {quote ? (
              <div className={styles.breakdownBody}>
                <p>
                  Команда: {users} {userLabel(users)}. Расчёт за один месяц:
                </p>
                <dl>
                  {quote.breakdown
                    .filter((band) => band.quantity > 0)
                    .map((band) => (
                      <div key={band.from}>
                        <dt>
                          {band.quantity} × {money(band.price)}
                        </dt>
                        <dd>{money(band.subtotal)}</dd>
                      </div>
                    ))}
                  <div className={styles.breakdownTotal}>
                    <dt>Рабочие места за месяц</dt>
                    <dd>{money(quote.monthlyTotal)}</dd>
                  </div>
                  {yearly && (
                    <div className={styles.breakdownTotal}>
                      <dt>За год: {money(quote.monthlyTotal)} × 10 месяцев</dt>
                      <dd>{money(quote.workplacesTotal)}</dd>
                    </div>
                  )}
                  {quote.addons.map((addon) => (
                    <div key={addon.id}>
                      <dt>
                        {addon.name} · за компанию{yearly ? ', 12 месяцев' : ''}
                      </dt>
                      <dd>{money(addon.total)}</dd>
                    </div>
                  ))}
                  <div className={styles.breakdownTotal}>
                    <dt>Вся подписка {suffix}</dt>
                    <dd>{money(quote.total)}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <p className={styles.breakdownBody}>Укажите количество пользователей для расчёта.</p>
            )}
          </details>
        </section>

        <section className={styles.questions} aria-labelledby="questions-title">
          <div className={styles.questionsIntro}>
            <ShieldCheckIcon />
            <h2 id="questions-title">Понятные условия</h2>
            <p>Вы управляете командой — стоимость подстраивается под её размер.</p>
          </div>
          <div className={styles.faq}>
            <details>
              <summary>Кто считается пользователем?</summary>
              <p>
                Сотрудник с личным доступом в кабинет организации. Вы выбираете количество рабочих
                мест и приглашаете коллег. Количество проживающих не увеличивает стоимость подписки.
              </p>
            </details>
            <details>
              <summary>Что делать, если состав команды изменился?</summary>
              <p>
                Место уволившегося сотрудника можно передать новому. Дополнительные места
                оплачиваются за оставшееся время с учётом скидки. Уменьшение количества действует со
                следующего оплачиваемого периода.
              </p>
            </details>
            <details>
              <summary>Как сочетаются скидки за количество и оплату года?</summary>
              <p>
                Сначала рассчитываем стоимость месяца с учётом количества пользователей. При оплате
                за год умножаем её на 10 — доступ действует все 12 месяцев. Эти скидки относятся к
                рабочим местам. Дополнительные услуги оплачиваются по своей цене за каждый месяц.
              </p>
            </details>
            <details>
              <summary>Нужно ли покупать услуги каждому сотруднику?</summary>
              <p>
                Нет, каждую услугу организация оплачивает один раз за выбранный период. Telegram
                подключает каждый сотрудник, которому нужны уведомления. Журнал действий относится
                ко всей организации, а просматривать его может владелец. Права сотрудников
                сохраняются.
              </p>
            </details>
          </div>
        </section>

        <footer className={styles.footer}>
          <span>Домовой — учёт персонала и проживания</span>
          <Link to="/preview/pricing">Другие варианты оформления тарифов</Link>
        </footer>
      </main>

      {showTrial && quote && (
        <Modal
          title="Пробный доступ для вашей команды"
          testId="calculator-trial"
          onClose={() => setShowTrial(false)}
          protectChanges={false}
        >
          <div className={styles.trialDialog}>
            <span className={styles.previewBadge}>Тестовый просмотр</span>
            <h3>
              {users} {userLabel(users)} · 30 дней бесплатно
            </h3>
            <p>
              Выбранная подписка после подключения стоит{' '}
              <strong>
                {money(quote.total)} {suffix}
              </strong>
              .{yearly && ' Это единый платёж за 12 месяцев.'}
            </p>
            <dl className={styles.dialogItems}>
              <div>
                <dt>Рабочие места</dt>
                <dd>{money(quote.workplacesTotal)}</dd>
              </div>
              {quote.addons.map((addon) => (
                <div key={addon.id}>
                  <dt>{addon.name} · за компанию</dt>
                  <dd>{money(addon.total)}</dd>
                </div>
              ))}
            </dl>
            <p>
              На этой тестовой странице можно проверить расчёт. Регистрация и оплата не выполняются.
            </p>
            <button type="button" className="btn btn--primary" onClick={() => setShowTrial(false)}>
              Вернуться к расчёту
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
