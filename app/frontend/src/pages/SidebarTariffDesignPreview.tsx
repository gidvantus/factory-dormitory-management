import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { Tariff } from '../api/client';
import { SidebarTariffCard } from '../workspace/SidebarTariff';
import type { SidebarTariffState } from '../workspace/SidebarTariff';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../workspace/WorkspaceIcon';
import workspace from '../workspace/Workspace.module.css';
import lab from './PricingDesignPreview.module.css';
import styles from './SidebarTariffDesignPreview.module.css';

/**
 * Дизайн-примерочная карточки тарифа в левой панели (#124).
 *
 * Показывает ту же карточку, что стоит в кабинете (`SidebarTariff.Card`), в
 * панели 248 px и в узком варианте 220 px — так видны перенос названия и даты
 * на тех ширинах, что есть в продукте (`Workspace.module.css`).
 *
 * Данные — константы страницы: ни `/api/tariffs/current`, ни `/api/trial` не
 * запрашиваются, аккаунт не нужен. Состояний четыре: пробный идёт, тариф
 * куплен со сроком, осталось 5 дней (`is_expiring`), кабинет закрыт. Загрузка,
 * ошибка, отсутствие тарифа и бессрочный тариф описаны в `mockups/124/notes.md`
 * и покрыты тестами карточки: в примерочной показывается то, что человек ещё не
 * видел глазами, а не каталог всех ветвей.
 *
 * Лиловый «вид A» из первой итерации макета здесь не воспроизводится: дизайнер
 * его отклонил и убрал из макета после выбора человека, а примерочная не должна
 * показывать вариант, который не будет реализован.
 */

/** Тариф для констант макета: сервер отдаёт его целиком, здесь важно только имя и цена. */
function tariff(name: string, priceLabel: string): Tariff {
  return {
    id: 1,
    name,
    description: null,
    amount: '0.00',
    currency: 'RUB',
    period: 'month',
    unit_label: null,
    position: 1,
    max_members: null,
    tooltip: null,
    group_code: null,
    price_label: priceLabel,
  };
}

interface PreviewState {
  key: string;
  label: string;
  /** Состояние карточки: оно же `data-state` в разметке. */
  state: SidebarTariffState;
  brief: string;
  note: string;
}

const STATES: readonly PreviewState[] = [
  {
    key: 'trial',
    label: 'Пробный идёт',
    state: 'trial',
    brief: 'осталось 29 дней, до 01.12.2026',
    note: 'Тарифа ещё нет, поэтому карточка называет срок пробного периода и ведёт на прайс. Остаток считает сервер.',
  },
  {
    key: 'paid',
    label: 'Куплен со сроком',
    state: 'paid',
    brief: 'Оплачен до 02.12.2026 · осталось 12 дней',
    note: 'Основной вид: название тарифа, дата «Оплачен до» и одна кнопка «О тарифе». Срок стоит сразу под названием.',
  },
  {
    key: 'expiring',
    label: 'Осталось 5 дней',
    state: 'expiring',
    brief: 'Оплачен до 12.11.2026 · осталось 5 дней',
    note: 'То же состояние, что приходит с `is_expiring`: остаток дней набран жирным, а кнопка называется «Продлить тариф». Цвет не меняется.',
  },
  {
    key: 'locked',
    label: 'Кабинет закрыт',
    state: 'locked',
    brief: 'Срок тарифа или пробного периода закончился',
    note: 'Закрытый кабинет: подпись «Доступ закрыт» с замком, причина и та же единственная кнопка «Выбрать тариф». Рамка мягко-жёлтая, как у предупреждения на обзоре.',
  },
];

const NAV: { name: string; icon: WorkspaceIconName }[] = [
  { name: 'Обзор', icon: 'overview' },
  { name: 'Общежития', icon: 'house' },
  { name: 'Документы', icon: 'document' },
  { name: 'Персонал', icon: 'people' },
  { name: 'Магазин улучшений', icon: 'info' },
];

export function SidebarTariffDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const requested = params.get('state');
  const active = STATES.find((item) => item.key === requested) ?? STATES[1];
  const narrow = params.get('width') === '220';

  useEffect(() => {
    const title = document.title;
    document.title = 'Тариф в левой панели — Домовой';
    return () => {
      document.title = title;
    };
  }, []);

  function update(key: string, value: string | null): void {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      },
      { preventScrollReset: true },
    );
  }

  function card(state: SidebarTariffState): JSX.Element {
    if (state === 'trial') {
      return (
        <SidebarTariffCard state="trial" trialDaysLeft={29} trialEndsAt="2026-12-01T00:00:00Z" />
      );
    }
    if (state === 'expiring') {
      return (
        <SidebarTariffCard
          state="expiring"
          tariff={tariff('Рост', '12 000 ₽ в месяц')}
          endsAt="2026-11-12T00:00:00Z"
          daysLeft={5}
        />
      );
    }
    if (state === 'locked') {
      return <SidebarTariffCard state="locked" />;
    }
    return (
      <SidebarTariffCard
        state="paid"
        tariff={tariff('Рост', '12 000 ₽ в месяц')}
        endsAt="2026-12-02T00:00:00Z"
        daysLeft={12}
      />
    );
  }

  return (
    <div className={`app ${styles.page}`} data-testid="sidebar-tariff-design-preview">
      <a className="skip-link" href="#sidebar-tariff-preview">
        К панели с карточкой
      </a>
      <header className={lab.lab}>
        <div className={styles.container}>
          <div className={lab.labTop}>
            <Link className={styles.labBrand} to="/">
              <WorkspaceIcon name="house" />
              Домовой<span>/ Дизайн-примерочная</span>
            </Link>
            <Link to="/preview/overview-tariff" className={styles.previousPreview}>
              Варианты блока тарифа на обзоре ↗
            </Link>
          </div>
          <div className={lab.labHeading}>
            <div>
              <h1>Тариф в левой панели</h1>
              <p>Карточка на своём месте в панели кабинета: ширина 248 px, на 1100 px — 220 px.</p>
            </div>
            <span className={lab.testBadge}>Тестовая страница</span>
          </div>
        </div>
      </header>
      <main className={styles.container} id="sidebar-tariff-preview">
        <div className={styles.stateBar}>
          <div className={styles.stateButtons} role="group" aria-label="Состояние карточки">
            <span>Состояние:</span>
            {STATES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`btn btn--compact ${item.key === active.key ? 'btn--primary' : 'btn--ghost'}`}
                aria-pressed={item.key === active.key}
                onClick={() => update('state', item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className={styles.stateButtons} role="group" aria-label="Ширина панели">
            <span>Панель:</span>
            <button
              type="button"
              className={`btn btn--compact ${narrow ? 'btn--ghost' : 'btn--primary'}`}
              aria-pressed={!narrow}
              onClick={() => update('width', null)}
            >
              248 px
            </button>
            <button
              type="button"
              className={`btn btn--compact ${narrow ? 'btn--primary' : 'btn--ghost'}`}
              aria-pressed={narrow}
              onClick={() => update('width', '220')}
            >
              220 px
            </button>
          </div>
        </div>

        <div className={styles.stage}>
          <div
            className={`${workspace.shell} ${styles.frame}`}
            data-width={narrow ? 'narrow' : 'wide'}
          >
            <aside className={workspace.sidebar} aria-label="Боковая панель кабинета">
              <span className={workspace.brand}>
                <svg className={workspace['brand-mark']} viewBox="0 0 40 40" aria-hidden="true">
                  <rect width="40" height="40" rx="12" fill="#DCEEE4" />
                  <g
                    fill="none"
                    stroke="#27313D"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 19 20 9l11 10M12.5 19v12h15V19M17 31v-6h6v6" />
                  </g>
                </svg>
                <span className={workspace['brand-name']}>Домовой</span>
              </span>
              <nav aria-label="Основные разделы макета">
                <p className={workspace['nav-label']}>Рабочее пространство</p>
                <ul className={workspace['nav-list']}>
                  {NAV.map((item, index) => (
                    <li key={item.name}>
                      <span
                        className={workspace['nav-link']}
                        aria-current={index === 0 ? 'page' : undefined}
                      >
                        <WorkspaceIcon name={item.icon} />
                        {item.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className={workspace['sidebar-bottom']}>
                {card(active.state)}
                <nav className={workspace['account-nav']} aria-label="Учётная запись">
                  <span className={workspace['nav-link']}>
                    <WorkspaceIcon name="building" />
                    Организация
                  </span>
                  <span className={workspace['nav-link']}>
                    <WorkspaceIcon name="people" />
                    Сотрудники
                  </span>
                  <span className={workspace['nav-link']}>
                    <WorkspaceIcon name="profile" />
                    Личные данные
                  </span>
                </nav>
                <div className={workspace.account}>
                  <span className={workspace['account-avatar']} aria-hidden="true">
                    ИИ
                  </span>
                  <div className={workspace['account-info']}>
                    <p className={workspace['account-name']}>Иванов Иван Иванович</p>
                    <p className={workspace['account-email']}>owner@example.com</p>
                  </div>
                  <span className={workspace.logout} aria-hidden="true">
                    <WorkspaceIcon name="door" />
                  </span>
                </div>
              </div>
            </aside>
          </div>
          <div className={styles.aside}>
            <h2 className={styles.asideTitle}>{active.label}</h2>
            <p className={styles.asideBrief} data-testid="sidebar-tariff-preview-brief">
              {active.brief}
            </p>
            <p className={styles.asideNote}>{active.note}</p>
            <dl className={styles.facts}>
              <div>
                <dt>data-access</dt>
                <dd>
                  {active.state === 'locked'
                    ? 'locked'
                    : active.state === 'trial'
                      ? 'trial'
                      : 'paid'}
                </dd>
              </div>
              <div>
                <dt>Состояние</dt>
                <dd>{active.state}</dd>
              </div>
              <div>
                <dt>Ширина</dt>
                <dd>{narrow ? '220 px (карточка 196)' : '248 px (карточка 212)'}</dd>
              </div>
            </dl>
          </div>
        </div>

        <p className={styles.footerNote}>
          Данные и действия на этой странице демонстрационные: запросов в API нет, тариф организации
          не меняется. Лиловый «вид A» отклонён дизайнером после выбора человека и здесь не
          показывается — реализуется одна карточка.
        </p>
      </main>
    </div>
  );
}
