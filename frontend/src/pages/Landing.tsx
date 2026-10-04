import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useSession } from '../auth/SessionProvider';
import { AuthDialog } from '../components/AuthDialog';
import type { AuthMode } from '../components/AuthDialog';
import heroScene from '../assets/landing/hero-scene.svg';
import avatarKomendant from '../assets/landing/avatar-komendant.svg';
import avatarKadrovik from '../assets/landing/avatar-kadrovik.svg';
import avatarRukovoditel from '../assets/landing/avatar-rukovoditel.svg';
import dormHouse from '../assets/landing/dorm-house.svg';
import cat from '../assets/landing/cat.svg';
import dog from '../assets/landing/dog.svg';
import styles from './Landing.module.css';

function classes(names: string): string {
  return names
    .split(' ')
    .map((name) => styles[name])
    .join(' ');
}

function dialogFromPath(pathname: string): AuthMode | null {
  if (pathname === '/login') return 'login';
  if (pathname === '/register') return 'register';
  return null;
}

/** Полный исходный лендинг, дополненный рабочими формами входа и регистрации. */
export function Landing(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { status } = useSession();
  const dialog = dialogFromPath(location.pathname);
  const pageRef = useRef<HTMLDivElement>(null);
  const [demoStatus, setDemoStatus] = useState('');

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const header = page.querySelector<HTMLElement>('#site-header');
    const onScroll = (): void => {
      if (header) header.dataset.scrolled = String(window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = reducedMotion ? 'auto' : 'smooth';

    let observer: IntersectionObserver | undefined;
    if ('IntersectionObserver' in window && !reducedMotion) {
      page.classList.add(styles.js);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add(styles['is-visible']);
              observer?.unobserve(entry.target);
            }
          }
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
      );
      page.querySelectorAll('.' + styles.reveal).forEach((element) => observer?.observe(element));
    }

    return () => {
      window.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      page.classList.remove(styles.js);
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
    };
  }, []);

  function handleDemoSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem('email');
    if (!(field instanceof HTMLInputElement)) return;
    if (!field.value.trim() || !field.checkValidity()) {
      setDemoStatus('Укажите рабочую почту — например, ivanov@company.ru.');
      field.focus();
      return;
    }
    setDemoStatus('Спасибо! Это демонстрационная форма: заявка никуда не отправлена.');
  }

  return (
    <>
      <div className={styles.page} data-testid="landing" ref={pageRef}>
        <a className={classes('skip-link')} href="#main">
          К основному содержанию
        </a>

        <header className={classes('site-header')} id="site-header" data-testid="site-header">
          <div className={classes('container nav')}>
            <a className={classes('logo')} href="#top">
              <svg
                className={classes('logo__mark')}
                viewBox="0 0 40 40"
                aria-hidden="true"
                focusable="false"
              >
                <rect width="40" height="40" rx="12" fill="#DCEEE4" />
                <path
                  d="M9 19 20 9l11 10"
                  fill="none"
                  stroke="#27313D"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M12.5 19v12h15V19"
                  fill="none"
                  stroke="#27313D"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M17 31v-6h6v6"
                  fill="none"
                  stroke="#27313D"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Домовой</span>
            </a>

            <nav className={classes('nav__links')} aria-label="Основная навигация">
              <a href="#roles">Кому подходит</a>
              <a href="#features">Возможности</a>
              <a href="#how">Как работает</a>
              <a href="#interface">Интерфейс</a>
              <a href="#faq">Вопросы</a>
            </nav>

            <div className={classes('nav__actions')}>
              {status === 'authenticated' ? (
                <button
                  className={classes('btn btn--ink btn--sm')}
                  type="button"
                  data-testid="nav-cabinet"
                  onClick={() => navigate('/cabinet')}
                >
                  Личный кабинет
                </button>
              ) : (
                <>
                  <button
                    className={classes('btn btn--outline btn--sm')}
                    type="button"
                    data-testid="nav-login"
                    onClick={() => navigate('/login')}
                  >
                    Войти
                  </button>
                  <button
                    className={classes('btn btn--primary btn--sm')}
                    type="button"
                    data-testid="nav-register"
                    onClick={() => navigate('/register')}
                  >
                    Регистрация
                  </button>
                </>
              )}
            </div>
          </div>
        </header>

        <main id="main">
          <span id="top"></span>

          {/* ===================== Герой ===================== */}
          <section className={classes('hero')} id="hero">
            <div className={classes('container hero__grid')}>
              <div className={classes('hero__copy')}>
                <p className={classes('eyebrow')}>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 21h18" />
                    <path d="M5 21V8l7-5 7 5v13" />
                    <path d="M10 21v-5h4v5" />
                  </svg>
                  Учёт проживающих без таблиц Excel
                </p>

                <h1>Все общежития, комнаты и люди — на одном экране</h1>

                <p className={classes('hero__lead')}>
                  Домовой ведёт учёт рабочих, которые живут в общежитиях: заселение и выселение,
                  комнаты и места, кадровые данные и отчёты по занятости. Комендант видит актуальную
                  картину по каждому зданию, а не сводку недельной давности.
                </p>

                <div className={classes('hero__actions')}>
                  <a className={classes('btn btn--primary')} href="#demo">
                    Запросить демо
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12h13" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </a>
                  <a className={classes('btn btn--outline')} href="#features">
                    Посмотреть возможности
                  </a>
                </div>

                <p className={classes('hero__note')}>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                  Работает в вашем контуре: данные проживающих не уходят наружу
                </p>

                <dl className={classes('stats')}>
                  <div className={classes('stat')}>
                    <dt className={classes('stat__label')}>мест под контролем</dt>
                    <dd className={classes('stat__value')}>4 800</dd>
                  </div>
                  <div className={classes('stat')}>
                    <dt className={classes('stat__label')}>общежитий в одном окне</dt>
                    <dd className={classes('stat__value')}>12</dd>
                  </div>
                  <div className={classes('stat')}>
                    <dt className={classes('stat__label')}>времени на отчёт по занятости</dt>
                    <dd className={classes('stat__value')}>1 мин</dd>
                  </div>
                </dl>
              </div>

              <div className={classes('hero__art')}>
                <div className={classes('hero__blob')} aria-hidden="true"></div>
                <img src={heroScene} alt="" width="880" height="600" />

                <div className={classes('float-card float-card--occupancy')}>
                  <span className={classes('float-card__dot')} aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 3v18h18" />
                      <path d="M7 16l4-5 3 3 5-7" />
                    </svg>
                  </span>
                  <span>
                    <span className={classes('float-card__value')}>92%</span>
                    <span className={classes('float-card__label')}>занятость мест</span>
                  </span>
                </div>

                <div className={classes('float-card float-card--free')}>
                  <span className={classes('float-card__dot')} aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 21h18" />
                      <path d="M5 21V8l7-5 7 5v13" />
                      <path d="M10 21v-5h4v5" />
                    </svg>
                  </span>
                  <span>
                    <span className={classes('float-card__value')}>46</span>
                    <span className={classes('float-card__label')}>свободных мест сегодня</span>
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* ===================== Кому подходит ===================== */}
          <section className={classes('section section--alt')} id="roles">
            <div className={classes('container')}>
              <div className={classes('section__head section__head--center reveal')}>
                <p className={classes('eyebrow')}>Роли</p>
                <h2>Одна система — три разных рабочих дня</h2>
                <p>
                  Комендант заселяет, кадры сверяют, руководитель смотрит заполняемость. Каждый
                  видит только то, что нужно его роли.
                </p>
              </div>

              <div className={classes('cards cards--3')}>
                <article className={classes('card card--role reveal')}>
                  <div className={classes('card--role__head')}>
                    <img src={avatarKomendant} alt="" width="84" height="84" />
                    <div>
                      <h3>Коменданту</h3>
                      <p>Ежедневная работа с общежитием</p>
                    </div>
                  </div>
                  <div className={classes('card--role__body')}>
                    <ul className={classes('check-list')}>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Заселить человека в свободное место за минуту
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Видеть, кто живёт в комнате и с какого числа
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Отметить выезд и освободить место
                      </li>
                    </ul>
                  </div>
                </article>

                <article className={classes('card card--role reveal')}>
                  <div className={classes('card--role__head')}>
                    <img src={avatarKadrovik} alt="" width="84" height="84" />
                    <div>
                      <h3>Кадровой службе</h3>
                      <p>Данные о людях и документах</p>
                    </div>
                  </div>
                  <div className={classes('card--role__body')}>
                    <ul className={classes('check-list')}>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Карточка рабочего с подразделением и статусом
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        История проживания: где и когда жил человек
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Выгрузка списков для проверок и отчётности
                      </li>
                    </ul>
                  </div>
                </article>

                <article className={classes('card card--role reveal')}>
                  <div className={classes('card--role__head')}>
                    <img src={avatarRukovoditel} alt="" width="84" height="84" />
                    <div>
                      <h3>Руководителю</h3>
                      <p>Заполняемость и расходы</p>
                    </div>
                  </div>
                  <div className={classes('card--role__body')}>
                    <ul className={classes('check-list')}>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Заполняемость по каждому зданию и комнате
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Сводка по подразделениям и сменам
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Где есть резерв мест, а где уже тесно
                      </li>
                    </ul>
                  </div>
                </article>
              </div>
            </div>
          </section>

          {/* ===================== Возможности ===================== */}
          <section className={classes('section')} id="features">
            <div className={classes('container')}>
              <div className={classes('section__head reveal')}>
                <p className={classes('eyebrow')}>Возможности</p>
                <h2>Всё, что нужно для учёта общежития</h2>
                <p>
                  Никаких надстроек и макросов: реестры, заселение и отчётность живут в одной
                  системе и обновляются сразу.
                </p>
              </div>

              <div className={classes('cards cards--3')}>
                <article className={classes('card card--feature reveal')}>
                  <span className={classes('icon-badge')} aria-hidden="true">
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
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </span>
                  <h3>Реестр проживающих</h3>
                  <p>
                    Единая карточка человека: ФИО, подразделение, должность, контакты, статус
                    проживания и фото.
                  </p>
                </article>

                <article className={classes('card card--feature reveal')}>
                  <span className={classes('icon-badge icon-badge--peach')} aria-hidden="true">
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

                <article className={classes('card card--feature reveal')}>
                  <span className={classes('icon-badge icon-badge--sky')} aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 21h18" />
                      <path d="M5 21V8l7-5 7 5v13" />
                      <path d="M10 21v-5h4v5" />
                      <path d="M9 11h.01" />
                      <path d="M15 11h.01" />
                    </svg>
                  </span>
                  <h3>Общежития, комнаты, места</h3>
                  <p>
                    Структура зданий до конкретного места: этаж, комната, койка. Свободные места
                    видны сразу.
                  </p>
                </article>

                <article className={classes('card card--feature reveal')}>
                  <span className={classes('icon-badge icon-badge--butter')} aria-hidden="true">
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
                    Заполняемость по зданиям, подразделениям и периодам. Отчёт собирается сам и
                    выгружается в Excel.
                  </p>
                </article>

                <article className={classes('card card--feature reveal')}>
                  <span className={classes('icon-badge icon-badge--lilac')} aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="2" y="5" width="20" height="14" rx="2.5" />
                      <circle cx="8" cy="11" r="2" />
                      <path d="M5.5 16c.4-1.4 1.4-2.2 2.5-2.2s2.1.8 2.5 2.2" />
                      <path d="M14 10h5" />
                      <path d="M14 14h3" />
                    </svg>
                  </span>
                  <h3>Кадровые данные и документы</h3>
                  <p>
                    Связка с кадровым учётом, вложения: договоры, заявления, копии документов — в
                    карточке человека.
                  </p>
                </article>

                <article className={classes('card card--feature reveal')}>
                  <span className={classes('icon-badge')} aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                  </span>
                  <h3>Роли и доступы</h3>
                  <p>
                    Комендант видит своё общежитие, кадры — данные людей, руководитель — сводку.
                    Права настраиваются.
                  </p>
                </article>
              </div>
            </div>
          </section>

          {/* ===================== Как это работает ===================== */}
          <section className={classes('section section--alt')} id="how">
            <div className={classes('container')}>
              <div className={classes('section__head reveal')}>
                <p className={classes('eyebrow')}>Внедрение</p>
                <h2>Как это работает</h2>
                <p>
                  Стартуем с вашими данными: переносим то, что уже есть в таблицах, и запускаем учёт
                  за две недели.
                </p>
              </div>

              <ol className={classes('steps')}>
                <li className={classes('step reveal')}>
                  <h3>Заводим общежития</h3>
                  <p>
                    Здания, этажи, комнаты и места — по вашей структуре. Можно импортом из таблицы.
                  </p>
                </li>
                <li className={classes('step reveal')}>
                  <h3>Переносим людей</h3>
                  <p>
                    Загружаем список рабочих из Excel или 1С, проверяем дубли и статусы вместе с
                    кадровой службой.
                  </p>
                </li>
                <li className={classes('step reveal')}>
                  <h3>Заселяем</h3>
                  <p>
                    Комендант распределяет людей по свободным местам, ведёт переселения и выселения.
                  </p>
                </li>
                <li className={classes('step reveal')}>
                  <h3>Смотрим отчёты</h3>
                  <p>
                    Заполняемость и история проживания доступны сразу, без выгрузок и ручной сверки.
                  </p>
                </li>
              </ol>
            </div>
          </section>

          {/* ===================== Интерфейс ===================== */}
          <section className={classes('section')} id="interface">
            <div className={classes('container')}>
              <div className={classes('section__head section__head--center reveal')}>
                <p className={classes('eyebrow')}>Интерфейс</p>
                <h2>Понятный экран вместо семи вкладок</h2>
                <p>
                  Рабочее место коменданта: занятость по зданию, свободные места и список
                  проживающих с быстрыми действиями.
                </p>
              </div>

              <div className={classes('mockup reveal')}>
                <div className={classes('mockup__bar')}>
                  <span className={classes('mockup__dots')} aria-hidden="true">
                    <span></span>
                    <span></span>
                    <span></span>
                  </span>
                  <span className={classes('mockup__url')}>domovoy.local/dormitory/3</span>
                </div>

                <div className={classes('mockup__body')}>
                  <nav className={classes('app-nav')} aria-label="Разделы системы (макет)">
                    <p className={classes('app-nav__title')}>Домовой</p>
                    <ul>
                      <li aria-current="page">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <rect x="3" y="3" width="8" height="8" rx="2" />
                          <rect x="13" y="3" width="8" height="5" rx="2" />
                          <rect x="13" y="10" width="8" height="11" rx="2" />
                          <rect x="3" y="13" width="8" height="8" rx="2" />
                        </svg>
                        Обзор
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                        </svg>
                        Проживающие
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 21h18" />
                          <path d="M5 21V8l7-5 7 5v13" />
                          <path d="M10 21v-5h4v5" />
                        </svg>
                        Общежития
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M2 5v15" />
                          <path d="M2 11h20v9" />
                          <path d="M2 16h20" />
                          <path d="M6 11V7h5a3 3 0 0 1 3 3v1" />
                        </svg>
                        Комнаты и места
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                          <path d="M10 17l5-5-5-5" />
                          <path d="M15 12H3" />
                        </svg>
                        Заселения
                      </li>
                      <li>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 3v18h18" />
                          <rect x="6" y="12" width="3.2" height="6" rx="1" />
                          <rect x="11" y="8" width="3.2" height="10" rx="1" />
                          <rect x="16" y="14" width="3.2" height="4" rx="1" />
                        </svg>
                        Отчёты
                      </li>
                    </ul>
                  </nav>

                  <div className={classes('app-main')}>
                    <div className={classes('app-main__head')}>
                      <h3>Общежитие №3 · ул. Фрунзенская, 12</h3>
                      <span className={classes('tag tag--ok')}>Занятость 92%</span>
                    </div>

                    <div className={classes('tiles')}>
                      <div className={classes('tile')}>
                        <p className={classes('tile__value')}>420</p>
                        <p className={classes('tile__label')}>мест всего</p>
                      </div>
                      <div className={classes('tile')}>
                        <p className={classes('tile__value')}>388</p>
                        <p className={classes('tile__label')}>занято</p>
                      </div>
                      <div className={classes('tile')}>
                        <p className={classes('tile__value')}>32</p>
                        <p className={classes('tile__label')}>свободно</p>
                      </div>
                    </div>

                    <div className={classes('table-wrap')}>
                      <table>
                        <caption>Проживающие · обновлено сегодня, 08:15</caption>
                        <thead>
                          <tr>
                            <th scope="col">Проживающий</th>
                            <th scope="col">Комната</th>
                            <th scope="col">Подразделение</th>
                            <th scope="col">Заезд</th>
                            <th scope="col">Статус</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className={classes('person')}>
                              <span data-tone="mint">ИП</span>
                              <span>Иванов П. С.</span>
                            </td>
                            <td>214 · место 2</td>
                            <td>СМУ-4</td>
                            <td>12.03.2026</td>
                            <td>
                              <span className={classes('tag tag--ok')}>Проживает</span>
                            </td>
                          </tr>
                          <tr>
                            <td className={classes('person')}>
                              <span data-tone="peach">СА</span>
                              <span>Сидоров А. В.</span>
                            </td>
                            <td>214 · место 3</td>
                            <td>СМУ-4</td>
                            <td>02.04.2026</td>
                            <td>
                              <span className={classes('tag tag--ok')}>Проживает</span>
                            </td>
                          </tr>
                          <tr>
                            <td className={classes('person')}>
                              <span data-tone="lilac">КМ</span>
                              <span>Кузнецов М. И.</span>
                            </td>
                            <td>108 · место 1</td>
                            <td>Участок №2</td>
                            <td>18.02.2026</td>
                            <td>
                              <span className={classes('tag tag--wait')}>Переселение</span>
                            </td>
                          </tr>
                          <tr>
                            <td className={classes('person')}>
                              <span>ГА</span>
                              <span>Гафуров А. Р.</span>
                            </td>
                            <td>307 · место 4</td>
                            <td>Ремонтный цех</td>
                            <td>05.05.2026</td>
                            <td>
                              <span className={classes('tag tag--ok')}>Проживает</span>
                            </td>
                          </tr>
                          <tr>
                            <td className={classes('person')}>
                              <span data-tone="mint">ЕО</span>
                              <span>Егоров О. Н.</span>
                            </td>
                            <td>—</td>
                            <td>Участок №1</td>
                            <td>—</td>
                            <td>
                              <span className={classes('tag tag--out')}>Выселен 20.09</span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ===================== Отчёты ===================== */}
          <section className={classes('section section--alt')} id="reports">
            <div className={classes('container report')}>
              <div className={classes('reveal')}>
                <p className={classes('eyebrow')}>Отчётность</p>
                <h2>Отчёты, которые не нужно собирать вручную</h2>
                <p className={classes('hero__lead')}>
                  Заполняемость пересчитывается при каждом заселении. Руководитель открывает отчёт и
                  видит картину по зданиям, подразделениям и периодам — без писем «пришлите
                  актуальный список».
                </p>
                <p className={classes('note')}>
                  Пример данных для демонстрации. В системе отчёты строятся по вашим общежитиям.
                </p>
              </div>

              <div
                className={classes('chart reveal')}
                role="img"
                aria-label="Заполняемость общежитий: №1 — 84%, №2 — 96%, №3 — 92%, №4 — 71%, №5 — 88%"
              >
                <div className={classes('chart__row')}>
                  <span className={classes('chart__name')}>Общежитие №1</span>
                  <span className={classes('chart__track')}>
                    <span className={classes('chart__fill')} style={{ width: '84%' }}></span>
                  </span>
                  <span className={classes('chart__value')}>84%</span>
                </div>
                <div className={classes('chart__row')}>
                  <span className={classes('chart__name')}>Общежитие №2</span>
                  <span className={classes('chart__track')}>
                    <span
                      className={classes('chart__fill')}
                      data-tone="peach"
                      style={{ width: '96%' }}
                    ></span>
                  </span>
                  <span className={classes('chart__value')}>96%</span>
                </div>
                <div className={classes('chart__row')}>
                  <span className={classes('chart__name')}>Общежитие №3</span>
                  <span className={classes('chart__track')}>
                    <span
                      className={classes('chart__fill')}
                      data-tone="sky"
                      style={{ width: '92%' }}
                    ></span>
                  </span>
                  <span className={classes('chart__value')}>92%</span>
                </div>
                <div className={classes('chart__row')}>
                  <span className={classes('chart__name')}>Общежитие №4</span>
                  <span className={classes('chart__track')}>
                    <span
                      className={classes('chart__fill')}
                      data-tone="butter"
                      style={{ width: '71%' }}
                    ></span>
                  </span>
                  <span className={classes('chart__value')}>71%</span>
                </div>
                <div className={classes('chart__row')}>
                  <span className={classes('chart__name')}>Общежитие №5</span>
                  <span className={classes('chart__track')}>
                    <span className={classes('chart__fill')} style={{ width: '88%' }}></span>
                  </span>
                  <span className={classes('chart__value')}>88%</span>
                </div>
              </div>
            </div>
          </section>

          {/* ===================== Отзывы ===================== */}
          <section className={classes('section')} id="reviews">
            <div className={classes('container')}>
              <div className={classes('section__head reveal')}>
                <p className={classes('eyebrow')}>Отзывы</p>
                <h2>Что говорят те, кто ведёт учёт каждый день</h2>
              </div>

              <div className={classes('cards cards--2')}>
                <figure className={classes('card quote reveal')}>
                  <blockquote>
                    «Раньше сверка занимала полдня: обзвонишь комендантов, сведёшь таблицы, найдёшь
                    расхождения. Теперь открываю отчёт и вижу, где живёт человек.»
                  </blockquote>
                  <figcaption>
                    <img src={avatarKomendant} alt="" width="56" height="56" />
                    <span>
                      <strong>Ирина Петровна</strong>комендант общежития №3
                    </span>
                  </figcaption>
                </figure>

                <figure className={classes('card quote reveal')}>
                  <blockquote>
                    «Кадры и общежитие наконец говорят на одном языке: один человек — одна карточка,
                    одна история проживания. Спорных ситуаций стало заметно меньше.»
                  </blockquote>
                  <figcaption>
                    <img src={avatarRukovoditel} alt="" width="56" height="56" />
                    <span>
                      <strong>Анна Сергеева</strong>руководитель кадровой службы
                    </span>
                  </figcaption>
                </figure>
              </div>
            </div>
          </section>

          {/* ===================== Вопросы ===================== */}
          <section className={classes('section section--alt')} id="faq">
            <div className={classes('container')}>
              <div className={classes('section__head section__head--center reveal')}>
                <p className={classes('eyebrow')}>Вопросы</p>
                <h2>Частые вопросы</h2>
              </div>

              <div className={classes('faq reveal')}>
                <details open>
                  <summary>Можно перенести данные из Excel?</summary>
                  <p>
                    Да. Мы принимаем таблицы со списком рабочих и структурой общежитий: комнаты,
                    места, этажи. На старте помогаем привести данные к единому виду и проверяем
                    дубли.
                  </p>
                </details>
                <details>
                  <summary>Система работает без интернета?</summary>
                  <p>
                    Домовой разворачивается в вашем контуре, во внутренней сети предприятия. Внешний
                    доступ не нужен, данные проживающих не покидают вашу инфраструктуру.
                  </p>
                </details>
                <details>
                  <summary>Сколько человек может работать одновременно?</summary>
                  <p>
                    Ограничений на число комендантов и кадровиков нет: роли настраиваются, каждый
                    видит свои общежития и разделы. Одновременная работа десятков пользователей —
                    штатный режим.
                  </p>
                </details>
                <details>
                  <summary>Ведётся ли история проживания?</summary>
                  <p>
                    Да. Сохраняются заселения, переселения и выселения с датами. По карточке
                    человека видно всю цепочку: где жил, когда и по какому основанию выехал.
                  </p>
                </details>
                <details>
                  <summary>Что с выгрузками и отчётностью?</summary>
                  <p>
                    Любой список и отчёт выгружается в Excel. Заполняемость считается автоматически
                    по зданиям, подразделениям и периодам.
                  </p>
                </details>
              </div>
            </div>
          </section>

          {/* ===================== Призыв ===================== */}
          <section className={classes('section')} id="demo">
            <div className={classes('container')}>
              <div className={classes('cta-band reveal')}>
                <div>
                  <p className={classes('eyebrow')}>Демо</p>
                  <h2>Покажем Домового на ваших общежитиях</h2>
                  <p>
                    Созвонимся на 30 минут, разберём вашу структуру общежитий и покажем, как будет
                    выглядеть учёт после внедрения.
                  </p>

                  <form
                    className={classes('cta-form')}
                    id="demo-form"
                    onSubmit={handleDemoSubmit}
                    noValidate
                  >
                    <label htmlFor="demo-email">Рабочая почта</label>
                    <div className={classes('cta-form__row')}>
                      <input
                        type="email"
                        id="demo-email"
                        name="email"
                        placeholder="ivanov@company.ru"
                        autoComplete="email"
                        required
                      />
                      <button className={classes('btn btn--ink')} type="submit">
                        Запросить демо
                      </button>
                    </div>
                    <p className={classes('cta-form__hint')}>
                      Нажимая кнопку, вы соглашаетесь на обработку контактных данных. Это прототип
                      страницы: заявка никуда не отправляется.
                    </p>
                    <p
                      className={classes('cta-form__hint')}
                      id="demo-status"
                      role="status"
                      aria-live="polite"
                    >
                      {demoStatus}
                    </p>
                  </form>
                </div>

                <div className={classes('cta-band__art')}>
                  <img
                    className={classes('art-house')}
                    src={dormHouse}
                    alt=""
                    width="420"
                    height="460"
                  />
                  <img className={classes('art-cat')} src={cat} alt="" width="200" height="200" />
                  <img className={classes('art-dog')} src={dog} alt="" width="200" height="200" />
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className={classes('site-footer')}>
          <div className={classes('container')}>
            <div className={classes('footer__grid')}>
              <div className={classes('footer__about')}>
                <a className={classes('logo')} href="#top">
                  <svg
                    className={classes('logo__mark')}
                    viewBox="0 0 40 40"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <rect width="40" height="40" rx="12" fill="#DCEEE4" />
                    <path
                      d="M9 19 20 9l11 10"
                      fill="none"
                      stroke="#27313D"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M12.5 19v12h15V19"
                      fill="none"
                      stroke="#27313D"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M17 31v-6h6v6"
                      fill="none"
                      stroke="#27313D"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Домовой</span>
                </a>
                <p>
                  CRM для учёта рабочих, проживающих в общежитиях: реестр, комнаты и места,
                  заселение, отчётность.
                </p>
              </div>

              <div>
                <h3>Продукт</h3>
                <ul>
                  <li>
                    <a href="#features">Возможности</a>
                  </li>
                  <li>
                    <a href="#interface">Интерфейс</a>
                  </li>
                  <li>
                    <a href="#reports">Отчётность</a>
                  </li>
                  <li>
                    <a href="#how">Внедрение</a>
                  </li>
                </ul>
              </div>

              <div>
                <h3>Роли</h3>
                <ul>
                  <li>
                    <a href="#roles">Коменданту</a>
                  </li>
                  <li>
                    <a href="#roles">Кадровой службе</a>
                  </li>
                  <li>
                    <a href="#roles">Руководителю</a>
                  </li>
                </ul>
              </div>

              <div>
                <h3>Связь</h3>
                <ul>
                  <li>
                    <a href="#demo">Запросить демо</a>
                  </li>
                  <li>
                    <a href="#faq">Частые вопросы</a>
                  </li>
                </ul>
              </div>
            </div>

            <div className={classes('footer__bottom')}>
              <span>© 2026 Домовой. Прототип лендинга, версия 1.</span>
              <span>Иллюстрации нарисованы для проекта.</span>
            </div>
          </div>
        </footer>
      </div>
      {dialog ? <AuthDialog mode={dialog} onClose={() => navigate('/')} /> : null}
    </>
  );
}
