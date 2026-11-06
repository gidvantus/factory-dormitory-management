import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { ExtraSeatBand } from '../../api/client';
import { LicenseCalculator } from '../../components/LicenseCalculator';
import type { LicenseOption, LicenseOrder } from '../../components/LicenseCalculator';
import { Modal } from '../../components/Modal';
import { SiteHeader } from '../../components/SiteHeader';
import { formatKopecks } from '../../components/money';
import { ComingSoonAddons, money, PreviewNavigation } from './PreviewShared';
import { ImprovementsStorePreview } from './ImprovementsStorePreview';
import styles from './PricingCalculatorPreview.module.css';

/**
 * Числа макета: на боевой странице те же данные приходят из `/api/tariffs` и
 * `/api/tariffs/extra-seats`, а здесь они захардкожены, потому что страница
 * тестовая и не ходит в API. Компонент расчёта один и тот же — макет передаёт
 * ему свои данные пропсами.
 */
const PREVIEW_LICENSES: LicenseOption[] = [
  {
    id: null,
    period: 'half_year',
    label: '6 месяцев',
    name: 'Домовой · 6 месяцев',
    amount: '60000.00',
    priceLabel: '60 000 ₽ за 6 месяцев',
    includedMembers: 5,
  },
  {
    id: null,
    period: 'year',
    label: '12 месяцев',
    name: 'Домовой · 12 месяцев',
    amount: '100000.00',
    priceLabel: '100 000 ₽ за 12 месяцев',
    includedMembers: 10,
  },
];

/** Ступени макета: та же шкала, что у сервера, но посчитанная здесь для примера. */
const PREVIEW_BANDS: ExtraSeatBand[] = [
  { from: 1, to: 9, discount_percent: 0 },
  { from: 10, to: 19, discount_percent: 10 },
  { from: 20, to: 29, discount_percent: 20 },
  { from: 30, to: 39, discount_percent: 30 },
  { from: 40, to: 49, discount_percent: 40 },
  { from: 50, to: 100, discount_percent: 50 },
].map((band) => ({
  ...band,
  unit_amount: ((1500 * (100 - band.discount_percent)) / 100).toFixed(2),
}));

const PREVIEW_MAX_SEATS = 100;

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
  const [order, setOrder] = useState<LicenseOrder | null>(null);

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
            Выберите лицензию на 6 месяцев или год и добавьте места, если сотрудников больше, чем
            включено в лицензию.
          </p>
        </header>

        <LicenseCalculator
          licenses={PREVIEW_LICENSES}
          bands={PREVIEW_BANDS}
          maxQuantity={PREVIEW_MAX_SEATS}
          onBuy={setOrder}
        />

        <div className={styles.storeAddons}>
          <ComingSoonAddons />
        </div>

        <footer className={styles.footer}>
          <span>Домовой — учёт персонала и проживания</span>
          <Link to="/preview/pricing">Другие варианты оформления тарифов</Link>
        </footer>
      </main>

      {order !== null && (
        <Modal
          title="Ваш заказ"
          testId="calculator-order"
          onClose={() => setOrder(null)}
          protectChanges={false}
        >
          <div className={styles.trialDialog}>
            <span className={styles.previewBadge}>Тестовый просмотр</span>
            <h3>
              Лицензия на {order.tariff.label}
              {order.seats > 0 ? ` · ${order.seats} мест` : ''}
            </h3>
            <p>
              Стоимость за полный срок <strong>{formatKopecks(order.totalKopecks)}</strong>.
            </p>
            <dl className={styles.dialogItems}>
              <div>
                <dt>Лицензия · {order.tariff.label}</dt>
                <dd>{formatKopecks(order.totalKopecks - order.seatsTotalKopecks)}</dd>
              </div>
              {order.seats > 0 && (
                <div>
                  <dt>
                    Доп. места · {order.seats} ({money(order.unitKopecks / 100)} × {order.seats})
                  </dt>
                  <dd>{formatKopecks(order.seatsTotalKopecks)}</dd>
                </div>
              )}
            </dl>
            <p>Это предварительный расчёт на тестовой странице.</p>
            <button className="btn btn--primary" type="button" onClick={() => setOrder(null)}>
              Вернуться к расчёту
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
