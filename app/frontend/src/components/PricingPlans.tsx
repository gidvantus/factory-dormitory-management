import type { Tariff } from '../api/client';
import house from '../assets/dorm-house.svg';
import { ArrowRightIcon, CheckIcon, HouseWindowIcon, UsersIcon } from './landing/icons';
import { TariffPrice } from './TariffPrice';
import styles from './PricingPlans.module.css';

interface PricingPlansProps {
  tariffs: Tariff[];
  ownedTariffId: number | null;
  buying: boolean;
  onBuy: (id: number) => void;
}

/** «04 Акцент»: выделяем Стандарт по имени, не по позиции или ID в базе. */
export function PricingPlans({
  tariffs,
  ownedTariffId,
  buying,
  onBuy,
}: PricingPlansProps): JSX.Element {
  const featured = tariffs.find(
    (tariff) => tariff.name.trim().toLocaleLowerCase('ru') === 'стандарт',
  );
  const others = tariffs.filter((tariff) => tariff !== featured);
  const hasTariff = ownedTariffId !== null;

  function card(tariff: Tariff, prominent = false): JSX.Element {
    const owned = tariff.id === ownedTariffId;
    // Разбиваем только предложения для оформления. Текст условий целиком остаётся серверным.
    const sentences = tariff.description?.split(/(?<=[.!?])\s+/) ?? [];
    const maximum = tariff.name.trim().toLocaleLowerCase('ru') === 'максимум';
    return (
      <article
        className={`${styles.card} ${prominent ? styles.featured : ''}`}
        key={tariff.id}
        data-testid="tariff-card"
        data-owned={owned || undefined}
        data-featured={prominent || undefined}
      >
        {prominent && <p className={styles.label}>Для ежедневной работы</p>}
        <div className={styles.cardHead}>
          <h3 data-testid="tariff-name">{tariff.name}</h3>
          {owned ? (
            <span className="tag tag--ok" data-testid="tariff-owned">
              Куплен
            </span>
          ) : (
            !prominent && (
              <span className={styles.icon} data-tone={maximum ? 'peach' : 'butter'}>
                {maximum ? <UsersIcon /> : <HouseWindowIcon />}
              </span>
            )
          )}
        </div>
        {prominent && (
          <>
            <p className={styles.lead}>
              Порядок в общежитиях.
              <br />
              {tariff.period === 'half_year' ? 'На полгода вперёд.' : 'Всё в одном месте.'}
            </p>
            <img className={styles.house} src={house} alt="" width="420" height="460" />
          </>
        )}
        <div className={styles.description} data-testid="tariff-description">
          {prominent
            ? sentences.map((sentence, index) => (
                <p className={styles.feature} key={index}>
                  <CheckIcon />
                  <span>
                    {sentence}
                    {index < sentences.length - 1 ? ' ' : ''}
                  </span>
                </p>
              ))
            : tariff.description}
        </div>
        <div className={styles.bottom}>
          <TariffPrice label={tariff.price_label} className={styles.price} testId="tariff-price" />
          <button
            className={`btn ${prominent ? 'btn--primary' : 'btn--outline'} ${styles.buy}`}
            type="button"
            data-testid="tariff-buy"
            disabled={buying || hasTariff}
            aria-busy={buying || undefined}
            title={hasTariff ? 'Тариф организации уже выбран' : undefined}
            onClick={() => onBuy(tariff.id)}
          >
            {buying ? 'Выставляем счёт…' : 'Купить'}
            <ArrowRightIcon />
          </button>
        </div>
      </article>
    );
  }

  return (
    <div className={featured && others.length > 0 ? styles.spotlight : styles.singleColumn}>
      {featured && card(featured, true)}
      {others.length > 0 && (
        <div className={featured ? styles.sidePlans : styles.fallback}>
          {others.map((tariff) => card(tariff))}
        </div>
      )}
    </div>
  );
}
