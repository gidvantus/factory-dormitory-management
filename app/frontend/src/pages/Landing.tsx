import { useLocation, useNavigate } from 'react-router-dom';

import { AuthDialog } from '../components/AuthDialog';
import type { AuthMode } from '../components/AuthDialog';
import { SiteHeader } from '../components/SiteHeader';
import { useSession } from '../auth/SessionProvider';

/** Маршрут открывает окно входа или регистрации: так форма доступна по прямой ссылке. */
function dialogFromPath(pathname: string): AuthMode | null {
  if (pathname === '/login') {
    return 'login';
  }
  if (pathname === '/register') {
    return 'register';
  }
  return null;
}

/** Главная страница в стиле лендинга: вход и регистрация открываются модальным окном. */
export function Landing(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { status } = useSession();
  const dialog = dialogFromPath(location.pathname);

  return (
    <div className="app" data-testid="landing">
      <SiteHeader
        actions={
          status === 'authenticated' ? (
            <button
              className="btn btn--ink btn--sm"
              type="button"
              data-testid="nav-cabinet"
              onClick={() => navigate('/cabinet')}
            >
              Личный кабинет
            </button>
          ) : (
            <>
              <button
                className="btn btn--outline btn--sm"
                type="button"
                data-testid="nav-login"
                onClick={() => navigate('/login')}
              >
                Войти
              </button>
              <button
                className="btn btn--primary btn--sm"
                type="button"
                data-testid="nav-register"
                onClick={() => navigate('/register')}
              >
                Регистрация
              </button>
            </>
          )
        }
      />

      <main>
        <section className="hero">
          <div className="container hero__grid">
            <div className="hero__copy">
              <p className="eyebrow">Учёт проживающих без таблиц Excel</p>
              <h1>Все общежития, комнаты и люди — на одном экране</h1>
              <p className="hero__lead">
                Домовой ведёт учёт рабочих, которые живут в общежитиях: заселение и выселение,
                комнаты и места, кадровые данные и отчёты по занятости. Комендант видит актуальную
                картину по каждому зданию, а не сводку недельной давности.
              </p>
              <div className="hero__actions">
                <button
                  className="btn btn--primary"
                  type="button"
                  data-testid="hero-register"
                  onClick={() => navigate('/register')}
                >
                  Зарегистрироваться
                </button>
                <button
                  className="btn btn--outline"
                  type="button"
                  data-testid="hero-login"
                  onClick={() => navigate('/login')}
                >
                  Войти
                </button>
              </div>
              <p className="hero__note">
                Пароль придумывает сервер и показывает его один раз — сохраните его при регистрации.
              </p>
              <dl className="stats">
                <div className="stat">
                  <dt className="stat__label">мест под контролем</dt>
                  <dd className="stat__value">4 800</dd>
                </div>
                <div className="stat">
                  <dt className="stat__label">общежитий в одном окне</dt>
                  <dd className="stat__value">12</dd>
                </div>
              </dl>
            </div>

            <div className="hero__art" aria-hidden="true">
              <p className="hero__art-title">
                <span>Общежитие №3</span>
                <span className="tag">Занятость 92%</span>
              </p>
              <div className="tiles">
                <div className="tile">
                  <p className="tile__value">420</p>
                  <p className="tile__label">мест всего</p>
                </div>
                <div className="tile">
                  <p className="tile__value">388</p>
                  <p className="tile__label">занято</p>
                </div>
                <div className="tile">
                  <p className="tile__value">32</p>
                  <p className="tile__label">свободно</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section section--alt">
          <div className="container">
            <div className="section__head">
              <p className="eyebrow">Возможности</p>
              <h2>Всё, что нужно для учёта общежития</h2>
              <p>
                Реестры, заселение и отчётность живут в одной системе и обновляются сразу — без
                выгрузок и ручной сверки.
              </p>
            </div>

            <div className="cards">
              <article className="card">
                <span className="icon-badge" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  </svg>
                </span>
                <h3>Реестр проживающих</h3>
                <p>
                  Единая карточка человека: ФИО, подразделение, должность, статус проживания и
                  история заселений.
                </p>
              </article>

              <article className="card">
                <span className="icon-badge icon-badge--peach" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <path d="M10 17l5-5-5-5" />
                    <path d="M15 12H3" />
                  </svg>
                </span>
                <h3>Заселение и выселение</h3>
                <p>
                  Операции с историей: кто, куда, когда и на каком основании. Переселение в два
                  клика, без потери данных.
                </p>
              </article>

              <article className="card">
                <span className="icon-badge icon-badge--sky" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 3v18h18" />
                    <rect x="6" y="12" width="3.2" height="6" rx="1" />
                    <rect x="11" y="8" width="3.2" height="10" rx="1" />
                    <rect x="16" y="14" width="3.2" height="4" rx="1" />
                  </svg>
                </span>
                <h3>Отчёты по занятости</h3>
                <p>
                  Заполняемость по зданиям, подразделениям и периодам: отчёт собирается сам и
                  выгружается в Excel.
                </p>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container">
          © 2026 Домовой. CRM для учёта рабочих, проживающих в общежитиях.
        </div>
      </footer>

      {dialog ? <AuthDialog mode={dialog} onClose={() => navigate('/')} /> : null}
    </div>
  );
}
