import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { CheckIcon } from '../components/landing/icons';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../workspace/WorkspaceIcon';
import workspace from '../workspace/Workspace.module.css';
import dashboard from '../workspace/dashboard/Dashboard.module.css';
import lab from './PricingDesignPreview.module.css';
import styles from './DashboardTariffDesignPreview.module.css';

// Снимок состояния из запроса пользователя. Данные макета не связаны с аккаунтом.
const trial = { days: 29, end: '12.11.2026', endLong: '12 ноября 2026' };
const variants = [
  {
    name: 'Компактная лента',
    short: 'Лента',
    note: 'Статус, срок и действие в одной ленте. Мягкий зелёный акцент, минимум высоты.',
  },
  {
    name: 'Две зоны',
    short: 'Две зоны',
    note: 'Слева — тариф организации, справа — пробный доступ. Два разных факта больше не смешиваются.',
  },
  {
    name: 'Счётчик дней',
    short: 'Счётчик',
    note: 'Крупный остаток дней и спокойная карточка. Срок заметен сразу, даже при беглом просмотре.',
  },
  {
    name: 'Линия этапов',
    short: 'Этапы',
    note: 'Понятный путь от начала работы до выбора тарифа. Текущий этап выделен цветом и подписью.',
  },
  {
    name: 'Тихая строка',
    short: 'Минимум',
    note: 'Только статус и срок. Дополнительная информация раскрывается по нажатию «Подробнее».',
  },
] as const;
type BlockProps = { paid: boolean; onAction: () => void };

function Status({ paid }: { paid: boolean }): JSX.Element {
  return (
    <span className={styles.status}>
      <span />
      {paid ? 'Тариф активен' : 'Пробный доступ'}
    </span>
  );
}

function Action({ paid, onAction }: BlockProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn ${paid ? 'btn--ghost' : 'btn--primary'} btn--compact ${styles.action}`}
      onClick={onAction}
    >
      {paid ? 'О тарифе' : 'Выбрать тариф'}
      <WorkspaceIcon name="chevron" />
    </button>
  );
}

function Ribbon(props: BlockProps): JSX.Element {
  return (
    <div className={`${styles.tariff} ${styles.ribbon}`}>
      <span className={styles.iconTile}>
        <WorkspaceIcon name={props.paid ? 'chart' : 'house'} />
      </span>
      <div className={styles.ribbonCopy}>
        <div className={styles.inlineTitle}>
          <h3>{props.paid ? 'Тариф «Стандарт»' : 'Пробный период активен'}</h3>
          <Status paid={props.paid} />
        </div>
        <p className={styles.muted}>
          {props.paid
            ? 'До 15 пользователей · Все разделы системы'
            : 'Ваш тариф пока не выбран. Знакомьтесь с возможностями «Домового».'}
        </p>
      </div>
      <div className={styles.ribbonTerm}>
        <strong>{props.paid ? '50 000 ₽' : `${trial.days} дней`}</strong>
        <span>{props.paid ? 'за 6 месяцев' : `до ${trial.end}`}</span>
      </div>
      <Action {...props} />
    </div>
  );
}

function Split(props: BlockProps): JSX.Element {
  return (
    <div className={`${styles.tariff} ${styles.split}`}>
      <div className={styles.splitMain}>
        <span className={styles.kicker}>Ваш тариф</span>
        <h3>{props.paid ? 'Стандарт' : 'Тариф пока не выбран'}</h3>
        <p className={styles.muted}>
          {props.paid
            ? 'Все разделы, расширенная отчётность и статистика.'
            : 'После покупки здесь появятся название и условия тарифа организации.'}
        </p>
        <Action {...props} />
      </div>
      <div className={styles.splitAside} data-paid={props.paid}>
        <span className={styles.kicker}>{props.paid ? 'Условия тарифа' : 'Пробный период'}</span>
        <p className={styles.splitValue}>
          {props.paid ? '50 000' : trial.days}
          <span>{props.paid ? ' ₽' : ' дней'}</span>
        </p>
        <p className={styles.muted}>
          {props.paid ? 'За 6 месяцев · До 15 пользователей' : `Осталось до ${trial.endLong}`}
        </p>
        <div className={styles.accessNote}>
          <CheckIcon />
          <span>{props.paid ? 'Тариф организации выбран' : 'Пробный доступ действует'}</span>
        </div>
      </div>
    </div>
  );
}

function Counter(props: BlockProps): JSX.Element {
  return (
    <div className={`${styles.tariff} ${styles.counter}`}>
      <div
        className={styles.counterDisk}
        aria-label={props.paid ? 'Тариф выбран' : `Осталось ${trial.days} дней`}
      >
        {props.paid ? (
          <CheckIcon />
        ) : (
          <>
            <strong>{trial.days}</strong>
            <span>дней осталось</span>
          </>
        )}
      </div>
      <div className={styles.counterCopy}>
        <Status paid={props.paid} />
        <h3>{props.paid ? '«Стандарт» для вашей команды' : 'Время познакомиться с «Домовым»'}</h3>
        <p className={styles.muted}>
          {props.paid ? (
            'Все разделы системы и до 15 пользователей.'
          ) : (
            <>
              Пробный период действует до <strong>{trial.end}</strong>.<br />
              Тариф организации пока не выбран.
            </>
          )}
        </p>
      </div>
      <div className={styles.counterAction}>
        {props.paid && (
          <p className={styles.counterPrice}>
            50 000 ₽ <span>/ 6 месяцев</span>
          </p>
        )}
        <Action {...props} />
      </div>
    </div>
  );
}

function Timeline(props: BlockProps): JSX.Element {
  return (
    <div className={`${styles.tariff} ${styles.timeline}`}>
      <div className={styles.timelineTop}>
        <div className={styles.inlineTitle}>
          <h3>Ваш тариф</h3>
          <Status paid={props.paid} />
        </div>
        <span className={styles.muted}>
          {props.paid ? 'Стандарт · 50 000 ₽ за 6 месяцев' : `Осталось ${trial.days} дней`}
        </span>
      </div>
      <ol className={styles.steps} aria-label="Этапы доступа">
        <li data-step="done">
          <span className={styles.stepDot}>
            <CheckIcon />
          </span>
          <div>
            <strong>Начало работы</strong>
            <p>Кабинет активирован</p>
          </div>
        </li>
        <li data-step={props.paid ? 'done' : 'current'}>
          <span className={styles.stepDot}>{props.paid ? <CheckIcon /> : '02'}</span>
          <div>
            <strong>Пробный период</strong>
            <p>{props.paid ? 'Переход на тариф выполнен' : `Действует до ${trial.end}`}</p>
          </div>
        </li>
        <li data-step={props.paid ? 'current' : 'next'}>
          <span className={styles.stepDot}>{props.paid ? <CheckIcon /> : '03'}</span>
          <div>
            <strong>{props.paid ? 'Тариф «Стандарт»' : 'Выбор тарифа'}</strong>
            <p>{props.paid ? 'До 15 пользователей' : 'Тариф пока не выбран'}</p>
          </div>
        </li>
      </ol>
      <div className={styles.timelineBottom}>
        <p>
          {props.paid
            ? 'Условия выбранного тарифа доступны в разделе «Тариф».'
            : 'Вы можете выбрать тариф, когда будете готовы продолжить работу.'}
        </p>
        <Action {...props} />
      </div>
    </div>
  );
}

function Minimal(props: BlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`${styles.tariff} ${styles.minimal}`}>
      <div className={styles.minimalRow}>
        <span className={styles.minimalIcon}>
          <WorkspaceIcon name="chart" />
        </span>
        <h3>Ваш тариф</h3>
        <Status paid={props.paid} />
        <p>
          {props.paid
            ? 'Стандарт · 50 000 ₽ / 6 месяцев'
            : `Ещё ${trial.days} дней · до ${trial.end}`}
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--compact"
          aria-expanded={expanded}
          aria-controls="overview-tariff-details"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Свернуть' : 'Подробнее'}
          <span className={styles.chevron} data-expanded={expanded}>
            <WorkspaceIcon name="chevron" />
          </span>
        </button>
      </div>
      {expanded && (
        <div className={styles.minimalDetails} id="overview-tariff-details">
          <p>
            {props.paid
              ? 'До 15 пользователей. Все разделы, расширенная отчётность и статистика.'
              : 'Тариф организации пока не выбран. Его название и условия появятся здесь после покупки.'}
          </p>
          <Action {...props} />
        </div>
      )}
    </div>
  );
}

const blocks = [Ribbon, Split, Counter, Timeline, Minimal];
const nav: { name: string; icon: WorkspaceIconName }[] = [
  { name: 'Обзор', icon: 'overview' },
  { name: 'Общежития', icon: 'house' },
  { name: 'Персонал', icon: 'people' },
  { name: 'Статистика', icon: 'chart' },
  { name: 'Тариф', icon: 'chart' },
  { name: 'Документы', icon: 'document' },
  { name: 'Организация', icon: 'building' },
];

function ContextMetrics(): JSX.Element {
  return (
    <div className={styles.contextMetrics}>
      <div className={styles.periodContext}>
        <strong>Показатели обзора</strong>
        <span>Условные данные для примера</span>
      </div>
      <div className={dashboard.summary}>
        <div className={`${dashboard.summaryCard} ${dashboard.summaryResidents}`}>
          <div>
            <p className={dashboard.summaryLabel}>Проживает</p>
            <p className={dashboard.summaryValue}>
              128<span>человек</span>
            </p>
            <p className={dashboard.summaryHint}>По всем общежитиям</p>
          </div>
          <span className={dashboard.summaryIcon}>
            <WorkspaceIcon name="people" />
          </span>
        </div>
        <div className={`${dashboard.summaryCard} ${dashboard.summaryAttendance}`}>
          <div>
            <p className={dashboard.summaryLabel}>Вышли на работу</p>
            <p className={dashboard.summaryValue}>
              96<span>человек</span>
            </p>
            <p className={dashboard.summaryHint}>На выбранную дату</p>
          </div>
          <span className={dashboard.summaryIcon}>
            <WorkspaceIcon name="chart" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function DashboardTariffDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get('variant') ?? 1);
  const active =
    Number.isInteger(requested) && requested >= 1 && requested <= 5 ? requested - 1 : 0;
  const all = params.get('view') === 'all';
  const paid = params.get('state') === 'paid';
  const [dialog, setDialog] = useState(false);
  useEffect(() => {
    const title = document.title;
    document.title = 'Блок «Ваш тариф» — 5 вариантов — Домовой';
    return () => {
      document.title = title;
    };
  }, []);

  function update(changes: Record<string, string | null>): void {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        Object.entries(changes).forEach(([key, value]) =>
          value === null ? next.delete(key) : next.set(key, value),
        );
        return next;
      },
      { preventScrollReset: true },
    );
  }

  return (
    <div className={`app ${styles.page}`} data-testid="overview-tariff-design-preview">
      <a className="skip-link" href="#overview-preview">
        К макету обзора
      </a>
      <header className={lab.lab}>
        <div className={styles.container}>
          <div className={lab.labTop}>
            <Link className={styles.labBrand} to="/">
              <WorkspaceIcon name="house" />
              Домовой<span>/ Дизайн-примерочная</span>
            </Link>
            <Link to="/preview/pricing" className={styles.previousPreview}>
              Варианты тарифов лендинга ↗
            </Link>
          </div>
          <div className={lab.labHeading}>
            <div>
              <h1>«Ваш тариф» в обзоре</h1>
              <p>Пять вариантов одного блока — в окружении вашего рабочего пространства.</p>
            </div>
            <span className={lab.testBadge}>Тестовая страница</span>
          </div>
          <div className={lab.switcher}>
            <nav className={lab.variantNav} aria-label="Варианты блока тарифа">
              {variants.map((variant, index) => (
                <button
                  key={variant.name}
                  type="button"
                  className={`btn btn--sm ${!all && active === index ? 'btn--ink' : 'btn--outline'}`}
                  aria-pressed={!all && active === index}
                  onClick={() => update({ variant: String(index + 1), view: null })}
                >
                  <span className={lab.navNumber}>0{index + 1}</span>
                  {variant.short}
                </button>
              ))}
            </nav>
            <button
              type="button"
              className={`btn btn--sm ${all ? 'btn--ink' : 'btn--outline'}`}
              aria-pressed={all}
              onClick={() => update({ view: all ? null : 'all' })}
            >
              Все варианты
            </button>
          </div>
        </div>
      </header>
      <main className={styles.container} id="overview-preview">
        <div className={styles.stateBar}>
          <div className={styles.stateButtons} role="group" aria-label="Состояние тарифа в макете">
            <span>Состояние:</span>
            <button
              type="button"
              className={`btn btn--compact ${paid ? 'btn--ghost' : 'btn--primary'}`}
              aria-pressed={!paid}
              onClick={() => update({ state: null })}
            >
              Пробный период
            </button>
            <button
              type="button"
              className={`btn btn--compact ${paid ? 'btn--primary' : 'btn--ghost'}`}
              aria-pressed={paid}
              onClick={() => update({ state: 'paid' })}
            >
              Тариф куплен
            </button>
          </div>
          <span className={styles.snapshot}>
            {paid
              ? 'Пример: Стандарт · 50 000 ₽ / 6 месяцев'
              : `Ваш пример: ${trial.days} дней · до ${trial.end}`}
          </span>
        </div>
        <div className={`${workspace.shell} ${styles.frame}`}>
          <aside className={styles.sidebar} aria-label="Контекст боковой панели макета">
            <div className={styles.sidebarBrand}>
              <span className={styles.iconTile}>
                <WorkspaceIcon name="house" />
              </span>
              <strong>Домовой</strong>
            </div>
            <p className={styles.sidebarCaption}>Рабочее пространство</p>
            <ul>
              {nav.map((item, index) => (
                <li key={item.name} className={styles.contextNav} data-active={index === 0}>
                  <WorkspaceIcon name={item.icon} />
                  <span>{item.name}</span>
                </li>
              ))}
            </ul>
            <div className={styles.sidebarFoot}>
              <WorkspaceIcon name="info" />
              <p>
                Макет кабинета
                <br />
                <span>Для сравнения дизайна</span>
              </p>
            </div>
          </aside>
          <div className={styles.workspace}>
            <div className={styles.topbar}>
              <span>
                Рабочее пространство <span aria-hidden="true">/</span> <strong>Обзор</strong>
              </span>
              <span className={styles.contextBadge}>Предпросмотр</span>
            </div>
            <div className={`${dashboard.dashboard} ${styles.dashboard}`}>
              <div className={dashboard.heading}>
                <div>
                  <p className={dashboard.eyebrow}>Рабочее пространство</p>
                  <h2 className={styles.overviewTitle}>Обзор</h2>
                  <p className={dashboard.lead}>Проживание и работа — по всем общежитиям</p>
                </div>
                <span className={dashboard.scopeBadge}>
                  <WorkspaceIcon name="house" />
                  Все общежития
                </span>
              </div>
              <div className={styles.variants}>
                {(all ? [0, 1, 2, 3, 4] : [active]).map((index) => {
                  const Block = blocks[index];
                  return (
                    <section
                      key={index}
                      className={styles.variant}
                      data-variant={index + 1}
                      aria-labelledby={`overview-variant-${index}`}
                    >
                      <div className={styles.variantHeading}>
                        <span>0{index + 1}</span>
                        <h2 id={`overview-variant-${index}`}>{variants[index].name}</h2>
                      </div>
                      <Block paid={paid} onAction={() => setDialog(true)} />
                      <p className={styles.designNote}>{variants[index].note}</p>
                    </section>
                  );
                })}
              </div>
              <ContextMetrics />
            </div>
          </div>
        </div>
        <p className={styles.footerNote}>
          Данные и действия на этой странице демонстрационные. Переключение состояния меняет только
          макет.
        </p>
      </main>
      {dialog && (
        <Modal
          title={paid ? 'Тариф «Стандарт»' : 'Выбор тарифа'}
          testId="overview-tariff-preview-action"
          onClose={() => setDialog(false)}
        >
          <div className={styles.dialogBody}>
            {paid ? (
              <>
                <strong className={styles.dialogPrice}>50 000 ₽ за 6 месяцев</strong>
                <p>До 15 пользователей. Все разделы, расширенная отчётность и статистика.</p>
              </>
            ) : (
              <p>
                В рабочем кабинете эта кнопка откроет раздел выбора тарифа. Сейчас можно посмотреть
                подготовленные варианты его оформления.
              </p>
            )}
            <p className={styles.muted}>
              Это демонстрация действия. Тариф организации и счета не изменяются.
            </p>
            <Link className="btn btn--primary" to="/preview/pricing">
              К макетам тарифов
            </Link>
            <button type="button" className="btn btn--outline" onClick={() => setDialog(false)}>
              Вернуться к сравнению
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
