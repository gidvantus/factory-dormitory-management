import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { TariffPrice } from '../components/TariffPrice';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../workspace/WorkspaceIcon';
import workspace from '../workspace/Workspace.module.css';
import lab from './PricingDesignPreview.module.css';
import context from './DashboardTariffDesignPreview.module.css';
import s from './ShopDesignPreview.module.css';

// Изолированный пример из 0035_solutions.py. Макет не запрашивает каталог и не создаёт счета.
const solution = {
  name: 'Уведомления в Telegram',
  description: 'Сообщения о событиях, которые вас касаются',
  price: '500 ₽ в месяц',
  expires: 'до 14 ноября 2026',
};
const variants = [
  {
    name: 'Витрина',
    note: 'Крупный акцент на решении и пример сообщения. Продолжает выбранный дизайн тарифов «Акцент».',
  },
  {
    name: 'Карточка',
    note: 'Самостоятельная карточка продукта и короткая инструкция рядом. Подойдёт для расширения каталога.',
  },
  {
    name: 'Лента',
    note: 'Название, стоимость и действие в одной строке. Подробности раскрываются по желанию.',
  },
  {
    name: 'Конструктор',
    note: 'Выбор решения слева, итог и действие справа. Попробуйте снять и вернуть галочку.',
  },
  {
    name: 'Сценарий',
    note: 'Сначала показываем, как работает улучшение. Переключайте шаги, чтобы увидеть каждый экран.',
  },
] as const;
const features = [
  'События в привычном мессенджере',
  'Выбор нужных уведомлений',
  'Тестовое сообщение для проверки связи',
];
const steps = [
  { name: 'Оплатите счёт', text: 'Он появится в разделе «Документы» после покупки.' },
  { name: 'Подключите Telegram', text: 'Откройте настройки уведомлений и свяжите свой аккаунт.' },
  { name: 'Выберите события', text: 'Отметьте, какие уведомления вы хотите получать.' },
];
type DesignProps = { owned: boolean; onAction: () => void; onSettings: () => void };

function Symbol({
  kind = 'plane',
}: {
  kind?: 'plane' | 'spark' | 'check' | 'arrow' | 'bell';
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'plane' && (
        <>
          <path d="m21 3-6 18-4-8-8-4 18-6Z" />
          <path d="m11 13 5-5" />
        </>
      )}
      {kind === 'spark' && (
        <>
          <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
          <path d="M20 2v4M18 4h4" />
        </>
      )}
      {kind === 'check' && <path d="m5 12 4 4L19 6" />}
      {kind === 'arrow' && <path d="M4 12h15m-6-6 6 6-6 6" />}
      {kind === 'bell' && (
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </>
      )}
    </svg>
  );
}

function ProductIcon({ tone = 'mint' }: { tone?: 'mint' | 'sky' }): JSX.Element {
  return (
    <span className={s.productIcon} data-tone={tone}>
      <Symbol />
    </span>
  );
}
function Status({ owned }: { owned: boolean }): JSX.Element {
  return (
    <span className={s.status} data-owned={owned}>
      <span />
      {owned ? 'Подключено' : 'Дополнительное решение'}
    </span>
  );
}
function Price(): JSX.Element {
  return <TariffPrice label={solution.price} className={s.price} />;
}
function Action({ owned, onAction }: DesignProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn--primary btn--compact ${s.action}`}
      data-testid="shop-preview-buy"
      onClick={onAction}
    >
      {owned ? 'Продлить' : 'Купить'}
      <Symbol kind="arrow" />
    </button>
  );
}
function Benefits(): JSX.Element {
  return (
    <ul className={s.benefits}>
      {features.map((feature) => (
        <li key={feature}>
          <Symbol kind="check" />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}
function ActiveNote(props: DesignProps): JSX.Element | null {
  if (!props.owned) return null;
  return (
    <div className={s.activeNote}>
      <span>
        <Symbol kind="check" />
        Действует {solution.expires}
      </span>
      <button type="button" className="btn btn--ghost btn--compact" onClick={props.onSettings}>
        Настроить
      </button>
    </div>
  );
}
function ChatPreview(): JSX.Element {
  return (
    <div className={s.chat} aria-label="Пример уведомления">
      <div className={s.chatHead}>
        <span className={s.botAvatar}>
          <WorkspaceIcon name="house" />
        </span>
        <div>
          <strong>Домовой</strong>
          <span>Уведомления в Telegram</span>
        </div>
        <Symbol kind="bell" />
      </div>
      <div className={s.chatBody}>
        <span className={s.today}>Сегодня</span>
        <div className={s.message}>
          <strong>Всё на связи 👋</strong>
          <p>
            Это тестовое уведомление от «Домового». Здесь будут появляться события, которые вас
            касаются.
          </p>
          <span className={s.messageTime}>
            12:30 <Symbol kind="check" />
          </span>
        </div>
        <div className={s.messageHint}>
          <Symbol kind="check" />
          Вы сами выбираете уведомления
        </div>
      </div>
    </div>
  );
}
function PurchaseBar(props: DesignProps): JSX.Element {
  return (
    <div className={s.purchaseBar}>
      <div>
        <span className={s.caption}>Дополнительно к вашему тарифу</span>
        <Price />
      </div>
      <div className={s.purchaseAction}>
        {props.owned && <span className={s.caption}>Действует {solution.expires}</span>}
        <Action {...props} />
      </div>
    </div>
  );
}

function Showcase(props: DesignProps): JSX.Element {
  return (
    <div className={s.showcase}>
      <div className={s.showcaseMain}>
        <div className={s.showcaseCopy}>
          <div className={s.row}>
            <ProductIcon />
            <Status owned={props.owned} />
          </div>
          <h3>{solution.name}</h3>
          <p className={s.muted}>{solution.description}.</p>
          <Benefits />
          {props.owned && (
            <button
              className="btn btn--ghost btn--compact"
              type="button"
              onClick={props.onSettings}
            >
              Настроить уведомления
            </button>
          )}
        </div>
        <div className={s.showcaseScene}>
          <ChatPreview />
        </div>
      </div>
      <PurchaseBar {...props} />
    </div>
  );
}
function Card(props: DesignProps): JSX.Element {
  return (
    <div className={s.cardLayout}>
      <article className={s.productCard}>
        <div className={s.cardCover}>
          <ProductIcon tone="sky" />
          <span className={s.coverLabel}>Домовой + Telegram</span>
          <div className={s.coverMessage}>
            <Symbol kind="bell" />
            <span>
              Нужные события —<br />
              <strong>всегда под рукой</strong>
            </span>
            <Symbol kind="check" />
          </div>
        </div>
        <div className={s.cardBody}>
          <Status owned={props.owned} />
          <h3>{solution.name}</h3>
          <p className={s.muted}>{solution.description}.</p>
          <ActiveNote {...props} />
          <div className={s.cardBottom}>
            <Price />
            <Action {...props} />
          </div>
        </div>
      </article>
      <aside className={s.guide}>
        <span className={s.eyebrow}>Всего три шага</span>
        <h3>
          Легко подключить.
          <br />
          Удобно пользоваться.
        </h3>
        <ol className={s.steps}>
          {steps.map((step, index) => (
            <li key={step.name}>
              <span>0{index + 1}</span>
              <div>
                <strong>{step.name}</strong>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className={s.guideNote}>
          <WorkspaceIcon name="info" />
          Решение оплачивается отдельно от основного тарифа.
        </p>
      </aside>
    </div>
  );
}
function Ribbon(props: DesignProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={s.catalog}>
      <div className={s.catalogHead}>
        <h3>Доступные решения</h3>
        <span className={s.count}>01</span>
      </div>
      <div className={s.catalogRow}>
        <ProductIcon />
        <div className={s.catalogCopy}>
          <h3>{solution.name}</h3>
          <p className={s.muted}>{solution.description}.</p>
          <Status owned={props.owned} />
        </div>
        <Price />
        <Action {...props} />
      </div>
      <div className={s.catalogFoot}>
        <button
          type="button"
          className={`btn btn--ghost btn--compact ${s.detailsButton}`}
          aria-expanded={expanded}
          aria-controls="shop-ribbon-details"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Скрыть подробности' : 'Что входит в решение'}
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
        <span className={s.caption}>
          {props.owned ? `Действует ${solution.expires}` : 'Оплата по счёту · Отдельно от тарифа'}
        </span>
      </div>
      {expanded && (
        <div className={s.catalogDetails} id="shop-ribbon-details">
          <Benefits />
          <p className={s.muted}>
            После оплаты подключите свой Telegram в разделе «Уведомления» и выберите нужные события.
          </p>
          {props.owned && (
            <button
              className="btn btn--ghost btn--compact"
              type="button"
              onClick={props.onSettings}
            >
              Открыть настройки
            </button>
          )}
        </div>
      )}
    </div>
  );
}
function Builder(props: DesignProps): JSX.Element {
  const [selected, setSelected] = useState(true);
  return (
    <div className={s.builder}>
      <div className={s.selection}>
        <div className={s.selectionHeading}>
          <span className={s.stepNumber}>01</span>
          <h3>Выберите улучшение</h3>
        </div>
        <label className={s.selectCard} data-selected={selected}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => setSelected(e.target.checked)}
          />
          <ProductIcon />
          <span>
            <strong>{solution.name}</strong>
            <span>{solution.description}.</span>
          </span>
          <span className={s.selectPrice}>
            500 ₽<small>в месяц</small>
          </span>
        </label>
        <div className={s.selectionBody}>
          <Status owned={props.owned} />
          <Benefits />
          <ActiveNote {...props} />
        </div>
      </div>
      <aside className={s.order}>
        <div className={s.selectionHeading}>
          <span className={s.stepNumber}>02</span>
          <h3>{props.owned ? 'Продление решения' : 'Ваш выбор'}</h3>
        </div>
        <p className={s.orderLine}>
          <span>Выбрано решений</span>
          <strong>{selected ? '1' : '0'}</strong>
        </p>
        <div className={s.orderTotal}>
          <span className={s.caption}>Итого в месяц</span>
          <strong>{selected ? '500' : '0'} ₽</strong>
        </div>
        <p className={s.muted}>
          {selected ? 'Уведомления в Telegram' : 'Выберите улучшение слева'}
        </p>
        <button
          type="button"
          className="btn btn--primary btn--compact"
          disabled={!selected}
          data-testid="shop-preview-buy"
          onClick={props.onAction}
        >
          {props.owned ? 'Продлить' : 'Перейти к покупке'}
          <Symbol kind="arrow" />
        </button>
        <p className={s.orderHint}>
          Счёт появится в «Документах». Решение станет доступно после оплаты.
        </p>
      </aside>
    </div>
  );
}
const storySteps = [
  {
    name: 'Получайте',
    title: 'Нужные события —\nтам, где удобно.',
    text: 'Сообщения от «Домового» приходят в ваш Telegram. Рабочие уведомления остаются под рукой.',
  },
  {
    name: 'Выбирайте',
    title: 'Только то,\nчто касается вас.',
    text: 'Выберите нужные подписки в настройках. Уведомления можно включать и отключать.',
  },
  {
    name: 'Проверяйте',
    title: 'Убедитесь,\nчто всё на связи.',
    text: 'Отправьте тестовое сообщение из настроек, чтобы проверить подключение Telegram.',
  },
];
function Story(props: DesignProps): JSX.Element {
  const [step, setStep] = useState(0);
  return (
    <div className={s.story}>
      <div className={s.storyMain}>
        <div className={s.storyScene}>
          {step === 0 ? (
            <ChatPreview />
          ) : step === 1 ? (
            <div className={s.sampleSettings}>
              <span className={s.sampleIcon}>
                <Symbol kind="bell" />
              </span>
              <strong>Ваши уведомления</strong>
              <p>Выбирайте подписки в настройках «Домового».</p>
              <div className={s.settingExample}>
                <span>Выбранные события</span>
                <span className={s.fakeSwitch} aria-hidden="true" />
              </div>
              <span className={s.caption}>Пример настроек</span>
            </div>
          ) : (
            <div className={s.sampleSettings}>
              <span className={s.sampleIcon}>
                <Symbol kind="check" />
              </span>
              <strong>Всё работает</strong>
              <p>Тестовое сообщение доставлено в ваш Telegram.</p>
              <div className={s.testMessage}>
                <Symbol />
                <span>
                  Домовой
                  <br />
                  <strong>Это тестовое уведомление</strong>
                </span>
              </div>
              <span className={s.caption}>Пример проверки подключения</span>
            </div>
          )}
        </div>
        <div className={s.storyCopy}>
          <Status owned={props.owned} />
          <p className={s.eyebrow}>{solution.name}</p>
          <h3>{storySteps[step].title}</h3>
          <p className={s.muted}>{storySteps[step].text}</p>
          <div className={s.storyTabs} role="group" aria-label="Сценарий использования">
            {storySteps.map((item, index) => (
              <button
                className={`btn btn--compact ${step === index ? 'btn--primary' : 'btn--ghost'}`}
                key={item.name}
                type="button"
                aria-pressed={step === index}
                onClick={() => setStep(index)}
              >
                <span>0{index + 1}</span>
                {item.name}
              </button>
            ))}
          </div>
          {props.owned && (
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={props.onSettings}
            >
              Настроить уведомления
            </button>
          )}
        </div>
      </div>
      <PurchaseBar {...props} />
    </div>
  );
}
const designs = [Showcase, Card, Ribbon, Builder, Story];
const nav: { label: string; icon: WorkspaceIconName }[] = [
  { label: 'Обзор', icon: 'overview' },
  { label: 'Общежития', icon: 'house' },
  { label: 'Тарифы', icon: 'chart' },
  { label: 'Магазин улучшений', icon: 'info' },
  { label: 'Документы', icon: 'document' },
  { label: 'Персонал', icon: 'people' },
  { label: 'Статистика', icon: 'chart' },
];

export function ShopDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const value = Number(params.get('variant') ?? 1);
  const active = Number.isInteger(value) && value >= 1 && value <= 5 ? value - 1 : 0;
  const all = params.get('view') === 'all';
  const owned = params.get('state') === 'owned';
  const [dialog, setDialog] = useState<'purchase' | 'settings' | null>(null);
  useEffect(() => {
    const title = document.title;
    document.title = 'Магазин улучшений — 5 вариантов — Домовой';
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
    <div className={`${context.page} ${s.page}`} data-testid="shop-design-preview">
      <a className="skip-link" href="#shop-preview">
        К макету магазина
      </a>
      <header className={lab.lab}>
        <div className={context.container}>
          <div className={lab.labTop}>
            <Link className={context.labBrand} to="/">
              <WorkspaceIcon name="house" />
              Домовой<span>/ Дизайн-примерочная</span>
            </Link>
            <Link className={context.previousPreview} to="/cabinet/shop">
              Открыть текущий магазин ↗
            </Link>
          </div>
          <div className={lab.labHeading}>
            <div>
              <h1>Магазин улучшений</h1>
              <p>Пять вариантов в вашем рабочем пространстве. Выберите тот, который ближе.</p>
            </div>
            <span className={lab.testBadge}>Тестовая страница</span>
          </div>
          <div className={lab.switcher}>
            <nav className={lab.variantNav} aria-label="Варианты дизайна магазина">
              {variants.map((variant, index) => (
                <button
                  type="button"
                  className={`btn btn--sm ${!all && active === index ? 'btn--ink' : 'btn--outline'}`}
                  key={variant.name}
                  aria-pressed={!all && active === index}
                  onClick={() => update({ variant: String(index + 1), view: null })}
                >
                  <span className={lab.navNumber}>0{index + 1}</span>
                  {variant.name}
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
      <main className={context.container} id="shop-preview">
        <div className={context.stateBar}>
          <div
            className={context.stateButtons}
            role="group"
            aria-label="Состояние решения в макете"
          >
            <span>Состояние:</span>
            <button
              className={`btn btn--compact ${owned ? 'btn--ghost' : 'btn--primary'}`}
              type="button"
              aria-pressed={!owned}
              onClick={() => update({ state: null })}
            >
              Не подключено
            </button>
            <button
              className={`btn btn--compact ${owned ? 'btn--primary' : 'btn--ghost'}`}
              type="button"
              aria-pressed={owned}
              onClick={() => update({ state: 'owned' })}
            >
              Подключено
            </button>
          </div>
          <span className={context.snapshot}>Пример из каталога · 500 ₽ в месяц</span>
        </div>
        <div className={`${workspace.shell} ${context.frame} ${s.frame}`}>
          <aside className={context.sidebar} aria-label="Контекст рабочего пространства">
            <div className={context.sidebarBrand}>
              <span className={s.productIcon}>
                <WorkspaceIcon name="house" />
              </span>
              <strong>Домовой</strong>
            </div>
            <p className={context.sidebarCaption}>Рабочее пространство</p>
            <ul>
              {nav.map((item, index) => (
                <li key={item.label} className={context.contextNav} data-active={index === 3}>
                  <WorkspaceIcon name={item.icon} />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
            <div className={context.sidebarFoot}>
              <WorkspaceIcon name="info" />
              <span>
                Макет магазина
                <br />
                Для сравнения дизайна
              </span>
            </div>
          </aside>
          <div className={context.workspace}>
            <div className={context.topbar}>
              <span>
                Рабочее пространство <span aria-hidden="true">/</span>
                <strong>Магазин улучшений</strong>
              </span>
              <span className={context.contextBadge}>Предпросмотр</span>
            </div>
            <div className={s.content}>
              <div className={s.pageHeading}>
                <span className={s.eyebrow}>Больше возможностей для вашей команды</span>
                <h2>Магазин улучшений</h2>
                <p>Дополнительные решения — отдельно от тарифа.</p>
              </div>
              <div className={s.variants}>
                {(all ? [0, 1, 2, 3, 4] : [active]).map((index) => {
                  const Design = designs[index];
                  return (
                    <section
                      className={s.variant}
                      data-variant={index + 1}
                      key={index}
                      aria-labelledby={`shop-variant-${index}`}
                    >
                      <div className={s.variantHeading}>
                        <span>0{index + 1}</span>
                        <h2 id={`shop-variant-${index}`}>{variants[index].name}</h2>
                      </div>
                      <Design
                        owned={owned}
                        onAction={() => setDialog('purchase')}
                        onSettings={() => setDialog('settings')}
                      />
                      <p className={s.designNote}>{variants[index].note}</p>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <p className={s.footer}>
          Это пример дизайна на данных из каталога. Кнопки демонстрационные: счета не создаются,
          настройки аккаунта не меняются.
        </p>
      </main>
      {dialog && (
        <Modal
          title={
            dialog === 'settings'
              ? 'Настройка уведомлений'
              : owned
                ? 'Продление решения'
                : 'Покупка решения'
          }
          testId="shop-preview-dialog"
          onClose={() => setDialog(null)}
        >
          <div className={s.dialogBody}>
            <ProductIcon />
            <h3>{solution.name}</h3>
            {dialog === 'purchase' ? (
              <>
                <Price />
                <p>После выбора дизайна эта кнопка будет выставлять счёт в разделе «Документы».</p>
              </>
            ) : (
              <p>Здесь будет переход к подключению Telegram и выбору уведомлений.</p>
            )}
            <p className={s.muted}>Сейчас это демонстрация интерфейса.</p>
            <button
              className="btn btn--primary btn--compact"
              type="button"
              onClick={() => setDialog(null)}
            >
              Вернуться к макету
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
