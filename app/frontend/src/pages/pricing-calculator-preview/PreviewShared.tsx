import { Link } from 'react-router-dom';

import { ADDONS } from './pricing';
import type { AddonId } from './pricing';
import styles from './PricingCalculatorPreview.module.css';

export const money = (amount: number): string =>
  `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)}\u00a0₽`;

export function PreviewNavigation({ active }: { active: 'license' | 'store' }): JSX.Element {
  return (
    <nav className={styles.previewNavigation} aria-label="Разделы макета">
      <Link
        className="btn btn--segment"
        aria-current={active === 'license' ? 'page' : undefined}
        to="/preview/pricing-calculator"
      >
        Лицензия и пользователи
      </Link>
      <Link
        className="btn btn--segment"
        aria-current={active === 'store' ? 'page' : undefined}
        to="/preview/pricing-calculator?view=store"
      >
        Магазин улучшений
      </Link>
    </nav>
  );
}

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

export function ComingSoonAddons(): JSX.Element {
  return (
    <fieldset className={styles.addonsField} disabled>
      <legend>Услуги для всей компании</legend>
      <p className={styles.addonsHint}>Дополнительные возможности для вашей команды.</p>
      <div className={styles.addonList}>
        {ADDONS.map((addon) => (
          <label className={styles.addon} key={addon.id}>
            <input type="checkbox" disabled aria-label={`${addon.name} — скоро будет доступно`} />
            <span className={styles.addonContent}>
              <span className={styles.addonTitle}>
                <span className={styles.addonIcon} data-addon={addon.id}>
                  <AddonIcon id={addon.id} />
                </span>
                <strong>{addon.name}</strong>
              </span>
              <span className={styles.comingSoon}>Скоро будет доступно</span>
              <span className={styles.addonDescription}>{addon.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
