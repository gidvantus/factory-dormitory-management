import heroScene from '../../assets/hero-scene.svg';
import { ChartLineIcon, HouseIcon } from './icons';

interface HeroProps {
  /** Открыть окно регистрации: главное действие страницы. */
  onRegister: () => void;
  /** Открыть окно входа для тех, у кого уже есть доступ. */
  onLogin: () => void;
}

/** Герой: заголовок и иллюстрация с плашками занятости. */
export function Hero({ onRegister, onLogin }: HeroProps): JSX.Element {
  return (
    <section className="hero" id="hero">
      <div className="container hero__grid">
        <div className="hero__copy">
          <p className="eyebrow">
            <HouseIcon strokeWidth={2} />
            Учёт проживающих без таблиц Excel
          </p>

          <h1>Все общежития, комнаты и люди — на одном экране</h1>

          <p className="hero__lead">
            Домовой ведёт учёт рабочих, которые живут в общежитиях: заселение и выселение, комнаты и
            места, кадровые данные и отчёты по занятости. Комендант видит актуальную картину по
            каждому зданию, а не сводку недельной давности.
          </p>

          <div className="hero__actions">
            <button
              className="btn btn--primary"
              type="button"
              data-testid="hero-register"
              onClick={onRegister}
            >
              Зарегистрироваться
            </button>
            <button
              className="btn btn--outline"
              type="button"
              data-testid="hero-login"
              onClick={onLogin}
            >
              Войти
            </button>
          </div>
        </div>

        <div className="hero__art">
          <div className="hero__blob" aria-hidden="true" />
          <img src={heroScene} alt="" width="880" height="600" />

          <div className="float-card float-card--occupancy">
            <span className="float-card__dot" aria-hidden="true">
              <ChartLineIcon strokeWidth={2} />
            </span>
            <span>
              <span className="float-card__value">92%</span>
              <span className="float-card__label">занятость мест</span>
            </span>
          </div>

          <div className="float-card float-card--free">
            <span className="float-card__dot" aria-hidden="true">
              <HouseIcon strokeWidth={2} />
            </span>
            <span>
              <span className="float-card__value">46</span>
              <span className="float-card__label">свободных мест сегодня</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
