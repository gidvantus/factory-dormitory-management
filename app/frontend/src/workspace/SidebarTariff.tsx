import { Link } from 'react-router-dom';

import { useSubscription } from '../auth/SubscriptionProvider';
import { useTrial } from '../auth/TrialProvider';
import { TariffPrice } from '../components/TariffPrice';
import { daysPhrase, daysWord, formatTariffDate } from '../components/tariffText';
import type { Tariff } from '../api/client';
import styles from './Workspace.module.css';
import { WorkspaceIcon } from './WorkspaceIcon';

/**
 * Карточка тарифа в левой панели кабинета — единственное место, где тариф
 * организации назван.
 *
 * Раздела «Тарифы» в кабинете нет: прайс живёт на публичной странице
 * `/pricing`, и «О тарифе» ведёт туда же. Карточка только показывает состояние —
 * тариф привязывается при покупке или администратором платформы.
 *
 * Срок здесь обязателен: «до какого числа оплачено» — тот вопрос, за которым
 * человек и заходит в панель. Дату и остаток дней отдаёт сервер
 * (`app/subscription.py`): клиент их не вычитает и правила «за 14 дней» не
 * повторяет — оно приходит готовым полем `is_expiring` и меняет только слово на
 * кнопке.
 *
 * Данные не запрашиваются заново: `SubscriptionProvider` и `TrialProvider`
 * оборачивают всю оболочку кабинета (`Cabinet.tsx`), поэтому карточка читает тот
 * же ответ, что и обзор, и предупреждение о сроке.
 *
 * Состояние не кодируется одним цветом: у закрытого кабинета есть подпись
 * «Доступ закрыт» и текст причины, у ошибки — причина и кнопка «Повторить».
 */
type SidebarAccess = 'paid' | 'trial' | 'none' | 'locked';

/**
 * Вид карточки. `data-access` отвечает за доступ, `data-state` — за оформление:
 * у `locked` другая рамка, у `expiring` остаток дней набран жирным, у `loading`
 * держится высота, чтобы панель не прыгала при появлении данных.
 */
export type SidebarTariffState =
  'loading' | 'error' | 'trial' | 'paid' | 'expiring' | 'locked' | 'none';

export interface SidebarTariffCardProps {
  state: SidebarTariffState;
  /** Действующий тариф; у состояний `trial`/`none`/`locked` его нет. */
  tariff?: Tariff | null;
  /** Момент окончания оплаченного периода; `null` — бессрочный тариф. */
  endsAt?: string | null;
  /** Остаток дней тарифа — считает сервер. */
  daysLeft?: number;
  /** Остаток дней пробного периода. */
  trialDaysLeft?: number;
  /** Конец пробного периода; `null` — остаток есть, а даты нет. */
  trialEndsAt?: string | null;
  /** Текст сбоя чтения подписки. */
  error?: string;
  /** Перечитать подписку; нужен только состоянию `error`. */
  onRetry?: () => void;
}

/**
 * Разметка карточки без обращения к сети: данные приходят пропсами.
 *
 * Отделена от `SidebarTariff` ради дизайн-примерочной
 * (`pages/SidebarTariffDesignPreview.tsx`): ей нужны те же классы и тексты в
 * четырёх состояниях, но на константах страницы, без запросов. Так примерочная
 * показывает настоящую карточку, а не её копию, которая со временем разойдётся
 * с продуктом.
 */
export function SidebarTariffCard({
  state,
  tariff = null,
  endsAt = null,
  daysLeft = 0,
  trialDaysLeft = 0,
  trialEndsAt = null,
  error = '',
  onRetry,
}: SidebarTariffCardProps): JSX.Element {
  const access: SidebarAccess =
    state === 'locked'
      ? 'locked'
      : state === 'paid' || state === 'expiring'
        ? 'paid'
        : state === 'trial'
          ? 'trial'
          : 'none';

  return (
    <section
      className={styles['sidebar-tariff']}
      aria-labelledby="sidebar-tariff-title"
      data-testid="sidebar-tariff"
      data-access={access}
      data-state={state}
    >
      {state === 'locked' ? (
        <p className={styles['sidebar-tariff-flag']}>
          <WorkspaceIcon name="lock" />
          Доступ закрыт
        </p>
      ) : (
        <p className={styles['sidebar-tariff-overline']}>Текущий тариф</p>
      )}

      {state === 'loading' && (
        <>
          <h2 className="visually-hidden" id="sidebar-tariff-title">
            Текущий тариф
          </h2>
          <p
            className={styles['sidebar-tariff-note']}
            role="status"
            data-testid="sidebar-tariff-loading"
          >
            Загружаем тариф…
          </p>
          <div className={styles['sidebar-tariff-skeleton']} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </>
      )}

      {state === 'error' && (
        <>
          <h2 className={styles['sidebar-tariff-name']} id="sidebar-tariff-title">
            Не удалось загрузить тариф
          </h2>
          <p
            className={styles['sidebar-tariff-note']}
            role="status"
            data-testid="sidebar-tariff-error"
          >
            {error}
          </p>
          <div className={styles['sidebar-tariff-action']}>
            <button
              type="button"
              className="btn btn--ghost btn--compact btn--sidebar btn--block"
              onClick={onRetry}
            >
              Повторить
            </button>
          </div>
        </>
      )}

      {state === 'trial' && (
        <>
          <h2 className={styles['sidebar-tariff-name']} id="sidebar-tariff-title">
            Пробный период
          </h2>
          <p className={styles['sidebar-tariff-term']}>
            <strong
              className={styles['sidebar-tariff-date']}
              data-testid="sidebar-tariff-trial-days"
            >
              осталось {trialDaysLeft} {daysWord(trialDaysLeft)}
              {trialEndsAt && `, до ${formatTariffDate(trialEndsAt)}`}
            </strong>
          </p>
          <div className={styles['sidebar-tariff-action']}>
            <Link
              className="btn btn--primary btn--compact btn--sidebar btn--block"
              to="/pricing"
              data-testid="sidebar-tariff-choose"
            >
              Выбрать тариф
            </Link>
          </div>
        </>
      )}

      {(state === 'paid' || state === 'expiring') && tariff && (
        <>
          <h2
            className={styles['sidebar-tariff-name']}
            id="sidebar-tariff-title"
            data-testid="sidebar-tariff-name"
          >
            {tariff.name}
          </h2>
          {endsAt ? (
            <p className={styles['sidebar-tariff-term']}>
              <strong className={styles['sidebar-tariff-date']} data-testid="sidebar-tariff-ends">
                Оплачен до {formatTariffDate(endsAt)}
              </strong>
              {daysLeft > 0 && (
                <span className={styles['sidebar-tariff-rest']}>
                  осталось {daysPhrase(daysLeft)}
                </span>
              )}
            </p>
          ) : (
            // Бессрочный тариф: конца нет, поэтому вместо срока — цена.
            <TariffPrice
              label={tariff.price_label}
              className={styles['sidebar-tariff-price']}
              testId="sidebar-tariff-price"
            />
          )}
          <div className={styles['sidebar-tariff-action']}>
            <Link
              className="btn btn--primary btn--compact btn--sidebar btn--block"
              to="/pricing"
              data-testid="sidebar-tariff-link"
            >
              {state === 'expiring' ? 'Продлить тариф' : 'О тарифе'}
            </Link>
          </div>
        </>
      )}

      {state === 'none' && (
        <>
          <h2 className={styles['sidebar-tariff-name']} id="sidebar-tariff-title">
            Тариф не выбран
          </h2>
          <p className={styles['sidebar-tariff-note']} data-testid="sidebar-tariff-empty">
            Его условия появятся здесь после покупки.
          </p>
          <div className={styles['sidebar-tariff-action']}>
            <Link
              className="btn btn--primary btn--compact btn--sidebar btn--block"
              to="/pricing"
              data-testid="sidebar-tariff-choose"
            >
              Выбрать тариф
            </Link>
          </div>
        </>
      )}

      {state === 'locked' && (
        <>
          <h2 className={styles['sidebar-tariff-name']} id="sidebar-tariff-title">
            Кабинет закрыт
          </h2>
          <p className={styles['sidebar-tariff-note']}>
            Срок тарифа или пробного периода закончился. Данные и сотрудники сохранены.
          </p>
          <div className={styles['sidebar-tariff-action']}>
            <Link
              className="btn btn--primary btn--compact btn--sidebar btn--block"
              to="/pricing"
              data-testid="sidebar-tariff-choose"
            >
              Выбрать тариф
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

/** Карточка тарифа на своём месте в панели: состояние берёт из провайдеров. */
export function SidebarTariff(): JSX.Element {
  const { state: subscription, status, error, reload } = useSubscription();
  const { state: trial } = useTrial();

  const tariff = status === 'ready' ? (subscription?.tariff ?? null) : null;
  const endsAt = tariff ? (subscription?.ends_at ?? null) : null;
  // Пробный период без известного конца — всё равно идущий: остаток дней сервер
  // уже посчитал, а показать дату нечем.
  const trialActive = tariff === null && trial?.is_active === true;

  const state: SidebarTariffState =
    trial?.locked === true
      ? 'locked'
      : status === 'loading'
        ? 'loading'
        : status === 'error'
          ? 'error'
          : tariff
            ? subscription?.is_expiring
              ? 'expiring'
              : 'paid'
            : trialActive
              ? 'trial'
              : 'none';

  return (
    <SidebarTariffCard
      state={state}
      tariff={tariff}
      endsAt={endsAt}
      daysLeft={subscription?.days_left ?? 0}
      trialDaysLeft={trial?.days_left ?? 0}
      trialEndsAt={trial?.ends_at ?? null}
      error={error}
      onRetry={reload}
    />
  );
}
