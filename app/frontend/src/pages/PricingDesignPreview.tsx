import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import house from '../assets/dorm-house.svg';
import { Modal } from '../components/Modal';
import { SiteHeader } from '../components/SiteHeader';
import {
  ArrowRightIcon,
  CheckIcon,
  HouseWindowIcon,
  UsersIcon,
  ChartLineIcon,
} from '../components/landing/icons';
import styles from './PricingDesignPreview.module.css';

// Изолированный снимок прайса из 0030_pricing_plans.py для сравнения дизайнов.
// Макет не обращается к API покупки и не меняет тариф организации.
const plans = [
  {
    name: 'Старт',
    amount: '10 000',
    period: 'в месяц',
    duration: '1 месяц',
    audience: 'Для небольшой команды',
    users: 'До 10 пользователей',
    features: ['Реестр проживающих', 'Комнаты и места', 'Базовые отчёты'],
    short: 'Реестр проживающих, комнаты и базовые отчёты.',
    tone: 'butter',
    Icon: HouseWindowIcon,
  },
  {
    name: 'Стандарт',
    amount: '50 000',
    period: 'за 6 месяцев',
    duration: '6 месяцев',
    audience: 'Для ежедневного управления',
    users: 'До 15 пользователей',
    features: ['Все разделы системы', 'Расширенная отчётность', 'Статистика'],
    short: 'Все разделы, расширенная отчётность и статистика.',
    tone: 'mint',
    Icon: ChartLineIcon,
  },
  {
    name: 'Максимум',
    amount: '90 000',
    period: 'в год',
    duration: '12 месяцев',
    audience: 'Для команды любого размера',
    users: 'Без лимита пользователей',
    features: ['Все разделы системы', 'Без лимита пользователей', 'Приоритетная поддержка'],
    short: 'Все разделы и приоритетная поддержка.',
    tone: 'peach',
    Icon: UsersIcon,
  },
] as const;
type Plan = (typeof plans)[number];
type Choose = (plan: Plan) => void;

const variants = [
  {
    name: 'Мягкие карточки',
    short: 'Карточки',
    description: 'Три самостоятельные карточки, больше воздуха и мягкий акцент на «Стандарте».',
    note: 'Самый близкий к лендингу: привычная структура, пастельные детали и ясная иерархия цены.',
  },
  {
    name: 'Единая панель',
    short: 'Панель',
    description: 'Тарифы собраны в одну спокойную панель. Условия удобно сравнивать по строкам.',
    note: 'Для спокойной подачи: меньше отдельных рамок, ровные колонки и все различия перед глазами.',
  },
  {
    name: 'Компактные строки',
    short: 'Строки',
    description: 'Название, состав и цена в одной строке. Весь выбор занимает минимум места.',
    note: 'Для компактной страницы: планы легко просматривать сверху вниз, а цена всегда рядом с кнопкой.',
  },
  {
    name: 'Главный акцент',
    short: 'Акцент',
    description: '«Стандарт» занимает главную позицию, а два других тарифа остаются рядом.',
    note: 'Если хочется направить внимание на «Стандарт». Иллюстрация продолжает визуальный язык лендинга.',
  },
  {
    name: 'Выбор с деталями',
    short: 'Выбор',
    description: 'Выберите тариф слева — справа появятся его стоимость и подробные условия.',
    note: 'Для последовательного выбора: меньше повторяющегося текста, один тариф в фокусе. Попробуйте переключить.',
  },
] as const;

function Price({ plan }: { plan: Plan }): JSX.Element {
  return (
    <div className={styles.price}>
      <strong>
        {plan.amount}
        <span> ₽</span>
      </strong>
      <span className={styles.period}>{plan.period}</span>
    </div>
  );
}

function PlanIcon({ plan }: { plan: Plan }): JSX.Element {
  return (
    <span className={styles.planIcon} data-tone={plan.tone}>
      <plan.Icon />
    </span>
  );
}

function Features({ plan }: { plan: Plan }): JSX.Element {
  return (
    <ul className={styles.features}>
      {plan.features.map((feature) => (
        <li key={feature}>
          <CheckIcon />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

function ChooseButton({
  plan,
  onChoose,
  primary = false,
}: {
  plan: Plan;
  onChoose: Choose;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`btn ${primary ? 'btn--primary' : 'btn--outline'} ${styles.choose}`}
      onClick={() => onChoose(plan)}
      aria-label={`Выбрать тариф «${plan.name}»`}
    >
      Выбрать {plan.name.toLocaleLowerCase('ru')}
      <ArrowRightIcon />
    </button>
  );
}

function Cards({ onChoose }: { onChoose: Choose }): JSX.Element {
  return (
    <div className={styles.cards}>
      {plans.map((plan, index) => (
        <article className={styles.card} data-featured={index === 1} key={plan.name}>
          <div className={styles.cardTop}>
            <PlanIcon plan={plan} />
            <span className={styles.duration}>{plan.duration}</span>
          </div>
          <div>
            <h3>{plan.name}</h3>
            <p className={styles.muted}>{plan.audience}</p>
          </div>
          <Price plan={plan} />
          <p className={styles.userLine}>
            <UsersIcon />
            {plan.users}
          </p>
          <Features plan={plan} />
          <ChooseButton plan={plan} onChoose={onChoose} primary={index === 1} />
        </article>
      ))}
    </div>
  );
}

function Panel({ onChoose }: { onChoose: Choose }): JSX.Element {
  return (
    <div className={styles.panel}>
      {plans.map((plan, index) => (
        <article className={styles.panelColumn} key={plan.name}>
          <div className={styles.panelTop} data-tone={plan.tone}>
            <span className={styles.panelNumber}>0{index + 1}</span>
            <span className={styles.duration}>{plan.duration}</span>
            <h3>{plan.name}</h3>
            <p>{plan.audience}</p>
          </div>
          <div className={styles.panelBody}>
            <Price plan={plan} />
            <div className={styles.detailLine}>
              <span>Команда</span>
              <strong>{plan.users}</strong>
            </div>
            <div className={styles.detailLine}>
              <span>Возможности</span>
              <Features plan={plan} />
            </div>
            <ChooseButton plan={plan} onChoose={onChoose} primary={index === 1} />
          </div>
        </article>
      ))}
    </div>
  );
}

function Rows({ onChoose }: { onChoose: Choose }): JSX.Element {
  return (
    <div className={styles.rows}>
      {plans.map((plan, index) => (
        <article className={styles.planRow} data-featured={index === 1} key={plan.name}>
          <div className={styles.rowName}>
            <PlanIcon plan={plan} />
            <div>
              <h3>{plan.name}</h3>
              <p className={styles.muted}>{plan.duration}</p>
            </div>
          </div>
          <div className={styles.rowDetails}>
            <strong>{plan.users}</strong>
            <p className={styles.muted}>{plan.short}</p>
          </div>
          <Price plan={plan} />
          <ChooseButton plan={plan} onChoose={onChoose} primary={index === 1} />
        </article>
      ))}
    </div>
  );
}

function Spotlight({ onChoose }: { onChoose: Choose }): JSX.Element {
  const standard = plans[1];
  return (
    <div className={styles.spotlight}>
      <article className={styles.featuredPlan}>
        <span className={styles.label}>Всё для ежедневной работы</span>
        <h3>{standard.name}</h3>
        <p className={styles.featuredLead}>
          Порядок в общежитиях.
          <br />
          На полгода вперёд.
        </p>
        <img className={styles.house} src={house} alt="" width="420" height="460" />
        <div className={styles.featuredDetails}>
          <p className={styles.userLine}>
            <UsersIcon />
            {standard.users}
          </p>
          <Features plan={standard} />
        </div>
        <div className={styles.featuredBottom}>
          <Price plan={standard} />
          <ChooseButton plan={standard} onChoose={onChoose} primary />
        </div>
      </article>
      <div className={styles.sidePlans}>
        {[plans[0], plans[2]].map((plan) => (
          <article className={styles.sidePlan} key={plan.name}>
            <div className={styles.cardTop}>
              <div>
                <h3>{plan.name}</h3>
                <p className={styles.muted}>{plan.users}</p>
              </div>
              <PlanIcon plan={plan} />
            </div>
            <p className={styles.muted}>{plan.short}</p>
            <div className={styles.sideBottom}>
              <Price plan={plan} />
              <ChooseButton plan={plan} onChoose={onChoose} />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Selector({ onChoose }: { onChoose: Choose }): JSX.Element {
  const [selected, setSelected] = useState(1);
  const plan = plans[selected];
  return (
    <div className={styles.selector}>
      <fieldset className={styles.planOptions}>
        <legend>Какой тариф подходит вашей команде?</legend>
        {plans.map((option, index) => (
          <label className={styles.option} key={option.name} data-selected={selected === index}>
            <input
              type="radio"
              name="preview-plan"
              value={option.name}
              checked={selected === index}
              onChange={() => setSelected(index)}
            />
            <PlanIcon plan={option} />
            <span>
              <strong>{option.name}</strong>
              <span className={styles.muted}>{option.users}</span>
            </span>
            <span className={styles.optionDuration}>{option.duration}</span>
          </label>
        ))}
        <p className={styles.selectionHint}>Выберите план, чтобы посмотреть условия.</p>
      </fieldset>
      <article className={styles.selectedPlan} aria-live="polite" aria-atomic="true">
        <div className={styles.cardTop}>
          <span className={styles.label}>{plan.duration} с «Домовым»</span>
          <plan.Icon />
        </div>
        <h3>{plan.name}</h3>
        <p className={styles.muted}>{plan.audience}</p>
        <Price plan={plan} />
        <p className={styles.userLine}>
          <UsersIcon />
          {plan.users}
        </p>
        <Features plan={plan} />
        <ChooseButton plan={plan} onChoose={onChoose} primary />
      </article>
    </div>
  );
}

const layouts = [Cards, Panel, Rows, Spotlight, Selector];

function Preview({
  index,
  onChoose,
  all,
}: {
  index: number;
  onChoose: Choose;
  all: boolean;
}): JSX.Element {
  const Layout = layouts[index];
  const variant = variants[index];
  return (
    <section
      className={styles.preview}
      id={`variant-${index + 1}`}
      aria-labelledby={`variant-title-${index + 1}`}
      data-variant={index + 1}
    >
      <div className={styles.variantCaption}>
        <span>Вариант 0{index + 1}</span>
        <h2 id={`variant-title-${index + 1}`}>{variant.name}</h2>
      </div>
      <div className={styles.previewHeading}>
        <p className="eyebrow">Тарифы</p>
        <h2>Сколько стоит «Домовой»</h2>
        <p>Выберите удобный формат работы для вашей команды.</p>
      </div>
      <Layout onChoose={onChoose} />
      <p className={styles.underPlans}>Без установки, доплат за отчёты и скрытых условий.</p>
      <div className={styles.designNote}>
        <span>О дизайне</span>
        <p>{all ? variant.description : variant.note}</p>
      </div>
    </section>
  );
}

export function PricingDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get('variant') ?? 1);
  const active =
    Number.isInteger(requested) && requested >= 1 && requested <= 5 ? requested - 1 : 0;
  const all = params.get('view') === 'all';
  const [chosen, setChosen] = useState<Plan | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = '5 вариантов тарифов — Домовой';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  function showVariant(index: number): void {
    setParams({ variant: String(index + 1) }, { preventScrollReset: true });
  }

  return (
    <div className={`app ${styles.page}`} data-testid="pricing-design-preview">
      <a className="skip-link" href="#pricing-preview-main">
        К вариантам тарифов
      </a>
      <SiteHeader
        actions={
          <Link className="btn btn--outline btn--sm" to="/pricing">
            Текущие тарифы
          </Link>
        }
      />
      <main id="pricing-preview-main">
        <div className={styles.lab}>
          <div className="container">
            <div className={styles.labTop}>
              <span className={styles.labLabel}>
                <span />
                Дизайн-примерочная
              </span>
              <span className={styles.labMeta}>Домовой / Тарифы / 5 вариантов</span>
            </div>
            <div className={styles.labHeading}>
              <div>
                <h1>Тарифы, по-домовому</h1>
                <p>Пять способов оформить одни и те же условия. Переключайте и сравнивайте.</p>
              </div>
              <span className={styles.testBadge}>Тестовая страница</span>
            </div>
            <div className={styles.switcher}>
              <nav className={styles.variantNav} aria-label="Варианты дизайна тарифов">
                {variants.map((variant, index) => (
                  <button
                    type="button"
                    className={`btn btn--sm ${!all && index === active ? 'btn--ink' : 'btn--outline'}`}
                    key={variant.name}
                    aria-pressed={!all && index === active}
                    onClick={() => showVariant(index)}
                  >
                    <span className={styles.navNumber}>0{index + 1}</span>
                    {variant.short}
                  </button>
                ))}
              </nav>
              <button
                type="button"
                className={`btn btn--sm ${all ? 'btn--ink' : 'btn--outline'}`}
                aria-pressed={all}
                onClick={() =>
                  setParams(all ? { variant: String(active + 1) } : { view: 'all' }, {
                    preventScrollReset: true,
                  })
                }
              >
                Все варианты
              </button>
            </div>
          </div>
        </div>
        <div className="container">
          {all ? (
            variants.map((_, index) => (
              <Preview key={index} index={index} onChoose={setChosen} all />
            ))
          ) : (
            <Preview key={active} index={active} onChoose={setChosen} all={false} />
          )}
        </div>
      </main>
      <footer className={styles.previewFooter}>
        <div className="container">
          <p>Макеты на основе прайса проекта: «Старт», «Стандарт», «Максимум».</p>
          <Link to="/">
            На главную <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </footer>
      {chosen && (
        <Modal
          title={`Тариф «${chosen.name}»`}
          testId="pricing-preview-choice"
          onClose={() => setChosen(null)}
        >
          <div className={styles.modalContent}>
            <Price plan={chosen} />
            <p>
              {chosen.users}. {chosen.short}
            </p>
            <p className={styles.muted}>
              Это пример работы кнопки в макете. Тариф не оформляется, счёт не выставляется.
            </p>
            <button type="button" className="btn btn--primary" onClick={() => setChosen(null)}>
              Продолжить сравнение
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
