import { useId, useState } from 'react';

import type { OrganizationTariff, Tariff, TariffPeriod } from '../api/client';
import { ArrowRightIcon, InfoIcon, UsersIcon } from './landing/icons';
import { TariffPrice } from './TariffPrice';
import { formatTariffDate } from './tariffText';
import styles from './PricingPlans.module.css';

/**
 * Порядок сроков в переключателе: от короткого к длинному.
 *
 * `half_year` и `once` остались в наборе ради уже проданных строк прайса —
 * «Стандарт» продавался на полгода, — поэтому переключатель не выдумывает
 * сроков, а показывает те, что есть в ответе `/api/tariffs`.
 */
const PERIOD_ORDER: readonly TariffPeriod[] = ['month', 'quarter', 'half_year', 'year', 'once'];

const PERIOD_LABELS: Record<TariffPeriod, string> = {
  month: '1 месяц',
  quarter: '3 месяца',
  half_year: '6 месяцев',
  year: '12 месяцев',
  once: 'разово',
};

/** Срок по умолчанию: месяц. Контракт: период не выбран — показан месячный. */
const DEFAULT_PERIOD: TariffPeriod = 'month';

/**
 * Ярус прайса: имя плашки и её строки по срокам.
 *
 * Ярус задаёт `group_code` — строки одного яруса с разными сроками делят его.
 * У прежних строк (до сетки из #99) кода нет, и ярусом считается само имя:
 * такая строка стоит в прайсе одна, а не слипается с чужой.
 */
interface Tier {
  key: string;
  title: string;
  position: number;
  rows: Map<TariffPeriod, Tariff>;
}

function tierKey(tariff: Tariff): string {
  return tariff.group_code ?? `name:${tariff.name}`;
}

/**
 * Имя яруса без суффикса срока.
 *
 * В сетке прайса строка называется «Старт · 3 месяца»: сервер держит срок в
 * `period` и `price_label`, а имя — данные. Плашка показывает ярус один раз,
 * поэтому суффикс срока («· …») с имени снимается: рядом стоит переключатель,
 * и второй раз срок в заголовке только путал бы.
 */
function tierTitle(name: string): string {
  return name.split('·')[0]?.trim() || name;
}

/** «до 5 сотрудников» / «без ограничения»: предел мест берётся из строки прайса. */
function seatsLabel(maxMembers: number | null): string {
  return maxMembers === null ? 'без ограничения' : `до ${maxMembers} сотрудников`;
}

function groupTiers(tariffs: Tariff[]): Tier[] {
  const tiers = new Map<string, Tier>();
  for (const tariff of tariffs) {
    const key = tierKey(tariff);
    const tier = tiers.get(key) ?? {
      key,
      title: tierTitle(tariff.name),
      position: tariff.position,
      rows: new Map<TariffPeriod, Tariff>(),
    };
    tier.position = Math.min(tier.position, tariff.position);
    tier.rows.set(tariff.period, tariff);
    tiers.set(key, tier);
  }
  return [...tiers.values()].sort((left, right) => left.position - right.position);
}

/** Сроки, которые действительно есть в прайсе: переключатель их не выдумывает. */
function availablePeriods(tariffs: Tariff[]): TariffPeriod[] {
  const present = new Set(tariffs.map((tariff) => tariff.period));
  return PERIOD_ORDER.filter((period) => present.has(period));
}

/** Первый по порядку срок яруса: запасной вариант, если выбранного нет. */
function firstRow(tier: Tier): Tariff | null {
  for (const period of PERIOD_ORDER) {
    const row = tier.rows.get(period);
    if (row) return row;
  }
  return null;
}

/** Цена яруса за выбранный срок: строки нет — показываем ближайшую имеющуюся. */
function rowForPeriod(tier: Tier, period: TariffPeriod): Tariff | null {
  return tier.rows.get(period) ?? firstRow(tier);
}

interface PricingPlansProps {
  tariffs: Tariff[];
  /** Подписка организации; `null` — смотрит аноним. */
  subscription: OrganizationTariff | null;
  buying: boolean;
  onBuy: (tariff: Tariff) => void;
}

/**
 * Прайс: ярусы в один ряд, срок — одной строкой над ними.
 *
 * Раньше плашки выделялись по имени («стандарт» был акцентом лендинга). С
 * сеткой #99 ярусы равны, и акцент получает то, что организация уже купила
 * (`data-owned`): иначе после смены прайса лендинг терял бы выделение вовсе.
 *
 * Цену, срок и места отдаёт сервер: страница показывает `price_label`, `period`
 * и `max_members` как есть и не считает скидки сама.
 */
export function PricingPlans({
  tariffs,
  subscription,
  buying,
  onBuy,
}: PricingPlansProps): JSX.Element {
  const tiers = groupTiers(tariffs);
  const periods = availablePeriods(tariffs);
  const [chosen, setChosen] = useState<TariffPeriod>(DEFAULT_PERIOD);
  const [openTip, setOpenTip] = useState<string | null>(null);
  const tipsId = useId();

  // Выбранный срок мог исчезнуть вместе с прайсом: тогда показываем первый из
  // тех, что есть, а не пустую сетку.
  const period = periods.includes(chosen) ? chosen : (periods[0] ?? DEFAULT_PERIOD);

  const ownedKey = subscription?.tariff ? tierKey(subscription.tariff) : null;
  const paidAhead = subscription?.next ?? null;
  // Продление свободного слота начнётся ровно в момент конца оплаченного
  // периода: граница исключающая, отдельного поля начала у сервера нет. Когда
  // будущий слот уже оплачен, это не «следующий период», а начало уже купленного
  // — тогда карточка говорит о нём другим текстом и берёт дату из `next.starts_at`.
  const renewalStartsAt = paidAhead ? null : (subscription?.ends_at ?? null);

  function card(tier: Tier): JSX.Element | null {
    const row = rowForPeriod(tier, period);
    if (row === null) return null;
    const owned = tier.key === ownedKey;
    const tipOpen = openTip === tier.key;
    const endsAt = owned && subscription?.ends_at ? formatTariffDate(subscription.ends_at) : '';

    return (
      <li key={tier.key}>
        <article
          className={styles.card}
          data-testid="tariff-card"
          data-tier={tier.key}
          data-owned={owned || undefined}
        >
          <div className={styles.cardHead}>
            <h3 data-testid="tariff-name">{tier.title}</h3>
            {owned && (
              <span className="tag tag--ok" data-testid="tariff-owned">
                Куплен
              </span>
            )}
          </div>

          <p className={styles.seats}>
            <UsersIcon />
            <span data-testid="tariff-seats">{seatsLabel(row.max_members)}</span>
            {row.tooltip && (
              <button
                className={styles.tip}
                type="button"
                aria-label={`Что считается местом на «${tier.title}»`}
                aria-expanded={tipOpen}
                aria-controls={tipOpen ? `${tipsId}-${tier.key}` : undefined}
                data-testid="tariff-tooltip"
                onClick={() => setOpenTip(tipOpen ? null : tier.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setOpenTip(null);
                }}
              >
                <InfoIcon />
              </button>
            )}
          </p>
          {row.tooltip && tipOpen && (
            <span
              className={styles.tipBox}
              role="tooltip"
              id={`${tipsId}-${tier.key}`}
              data-testid="tariff-tooltip-text"
            >
              {row.tooltip}
            </span>
          )}

          <p className={styles.description} data-testid="tariff-description">
            {row.description}
          </p>

          <div className={styles.bottom}>
            <TariffPrice label={row.price_label} className={styles.price} testId="tariff-price" />
            <button
              className={`btn ${owned ? 'btn--primary' : 'btn--outline'} ${styles.buy}`}
              type="button"
              data-testid="tariff-buy"
              disabled={buying}
              aria-busy={buying || undefined}
              onClick={() => onBuy(row)}
            >
              {buying ? 'Выставляем счёт…' : owned ? 'Продлить' : 'Купить'}
              <ArrowRightIcon />
            </button>
          </div>

          {endsAt && (
            <p className={styles.term} data-testid="tariff-term">
              Оплачен до {endsAt}
            </p>
          )}
          {owned && paidAhead && (
            // Будущий слот занят: это не «следующий период», а уже оплаченный.
            // Дословное макетное «Продление оплачено до …» требует `next.ends_at`,
            // которого в контракте нет, поэтому дата — только начало периода.
            <p className={styles.note} data-testid="tariff-next-paid">
              Продление оплачено: «{paidAhead.tariff.name}» с{' '}
              {formatTariffDate(paidAhead.starts_at)}
            </p>
          )}
          {owned && renewalStartsAt && (
            <p className={styles.note} data-testid="tariff-next-start">
              На будущий период — с {formatTariffDate(renewalStartsAt)}
            </p>
          )}
        </article>
      </li>
    );
  }

  return (
    <div className={styles.plans} data-testid="pricing-plans">
      {periods.length > 1 && (
        <div className={styles.periodBar}>
          <div
            className={styles.periodSwitch}
            role="radiogroup"
            aria-label="Срок оплаты"
            data-testid="tariff-period-switch"
          >
            {periods.map((option) => (
              <button
                className={styles.periodOption}
                key={option}
                type="button"
                role="radio"
                aria-checked={option === period}
                data-testid="tariff-period-option"
                data-period={option}
                onClick={() => setChosen(option)}
              >
                {PERIOD_LABELS[option]}
              </button>
            ))}
          </div>
          <p className={styles.periodHint}>
            Срок начинается в день оплаты. Цену за выбранный срок собирает сервер.
          </p>
        </div>
      )}

      <ul className={styles.grid}>{tiers.map(card)}</ul>
    </div>
  );
}
