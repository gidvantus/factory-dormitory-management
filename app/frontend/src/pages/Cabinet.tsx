import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useSession } from '../auth/SessionProvider';
import { TrialProvider, useTrial } from '../auth/TrialProvider';
import { subscribeToTrialExpired } from '../auth/trial';
import { SolutionsProvider, useSolutions } from '../workspace/SolutionsProvider';
import { TELEGRAM_NOTIFICATIONS_CODE } from '../workspace/solutions';
import { userInitials } from '../workspace/userInitials';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import styles from '../workspace/Workspace.module.css';

const sectionTitles: Record<string, string> = {
  '/cabinet': 'Обзор',
  '/cabinet/dormitories': 'Общежития',
  '/cabinet/tariffs': 'Тариф',
  '/cabinet/shop': 'Магазин улучшений',
  '/cabinet/notifications': 'Уведомления',
  '/cabinet/documents': 'Документы',
  '/cabinet/organization': 'Организация',
  '/cabinet/organization/members': 'Сотрудники',
  '/cabinet/personnel': 'Персонал',
  '/cabinet/statistics': 'Статистика',
  '/cabinet/profile': 'Личные данные',
};

/**
 * Разделы, закрытые после окончания пробного периода.
 *
 * Список ведётся явно, а не «всё, кроме перечисленного»: открытыми остаются
 * «Обзор», «Тариф», «Магазин улучшений», «Документы», «Организация» и «Личные
 * данные», и новый рабочий раздел должен появиться здесь осознанно, а не
 * закрыться случайно.
 */
const CLOSED_SECTIONS = [
  '/cabinet/dormitories',
  '/cabinet/personnel',
  '/cabinet/statistics',
  '/cabinet/organization/members',
];

function isClosedSection(path: string): boolean {
  return CLOSED_SECTIONS.some((section) => path === section || path.startsWith(`${section}/`));
}

/**
 * Оболочка кабинета вместе с состоянием пробного периода и правами на решения.
 *
 * `SolutionsProvider` стоит рядом с `TrialProvider` и оборачивает ту же оболочку:
 * пункт меню платной функции появляется по праву организации, а право читается
 * один раз на весь кабинет.
 */
export function Cabinet(): JSX.Element {
  return (
    <TrialProvider>
      <SolutionsProvider>
        <CabinetShell />
      </SolutionsProvider>
    </TrialProvider>
  );
}

function CabinetShell(): JSX.Element {
  const { user, logout } = useSession();
  const { locked } = useTrial();
  const { ownedCodes } = useSolutions();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const trimmedPath = pathname.replace(/\/$/, '');
  const sectionPath = trimmedPath.split('/').slice(0, 3).join('/');
  // Сначала точный адрес, потом общий раздел: у «Сотрудников» свой заголовок,
  // хотя они и вложены в «Организацию».
  const sectionTitle = sectionTitles[trimmedPath] ?? sectionTitles[sectionPath] ?? 'Обзор';
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${sectionTitle} — Домовой`;
    mainRef.current
      ?.querySelector<HTMLElement>('h1, [data-workspace-focus]')
      ?.focus({ preventScroll: true });
    return () => {
      document.title = previousTitle;
    };
  }, [sectionTitle, pathname]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeMenu = (): void => setMenuOpen(false);
    desktop.addEventListener('change', closeMenu);
    return () => desktop.removeEventListener('change', closeMenu);
  }, []);

  useEffect(
    // 403 «пробный период закончился» с рабочей ручки: раздел закрылся, пока
    // пользователь в нём находился. Уводим на обзор — там ссылка на тарифы.
    () =>
      subscribeToTrialExpired(() => {
        if (isClosedSection(trimmedPath)) navigate('/cabinet', { replace: true });
      }),
    [trimmedPath, navigate],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
      if (event.key !== 'Tab') return;
      const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      const first = focusable?.[0];
      const last = focusable?.[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  function closeMenu(): void {
    setMenuOpen(false);
  }

  async function handleLogout(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      setLogoutError('Не удалось выйти из аккаунта. Проверьте соединение и попробуйте ещё раз.');
      setLoggingOut(false);
      closeMenu();
    }
  }

  return (
    <div className={styles.shell} data-testid="cabinet-page" data-menu-open={String(menuOpen)}>
      <button
        className={styles['mobile-backdrop']}
        type="button"
        aria-label="Закрыть меню"
        tabIndex={-1}
        onClick={() => {
          closeMenu();
          toggleRef.current?.focus();
        }}
      />
      <aside
        className={styles.sidebar}
        id="workspace-sidebar"
        aria-label="Боковая панель"
        ref={sidebarRef}
      >
        <Link
          className={styles.brand}
          to="/"
          aria-label="Домовой — главная"
          data-testid="logo-link"
        >
          <svg className={styles['brand-mark']} viewBox="0 0 40 40" aria-hidden="true">
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
          <span className={styles['brand-name']}>Домовой</span>
        </Link>
        <p className={styles['brand-note']}>Учёт проживающих в общежитиях</p>
        <nav aria-label="Основные разделы">
          <p className={styles['nav-label']}>Рабочее пространство</p>
          <ul className={styles['nav-list']}>
            <li>
              <NavLink
                className={styles['nav-link']}
                to="/cabinet"
                end
                onClick={closeMenu}
                data-testid="workspace-nav-overview"
              >
                <WorkspaceIcon name="overview" />
                Обзор
              </NavLink>
            </li>
            <li>
              <NavLink
                className={styles['nav-link']}
                to="/cabinet/dormitories"
                aria-disabled={locked || undefined}
                tabIndex={locked ? -1 : undefined}
                onClick={(event) => {
                  if (locked) event.preventDefault();
                  closeMenu();
                }}
                data-testid="workspace-nav-dormitories"
              >
                <WorkspaceIcon name="house" />
                Общежития
              </NavLink>
            </li>
            <li>
              <NavLink
                className={styles['nav-link']}
                to="/cabinet/tariffs"
                onClick={closeMenu}
                data-testid="workspace-nav-tariffs"
              >
                <WorkspaceIcon name="chart" />
                Тариф
              </NavLink>
            </li>
            <li>
              {/* «Магазин улучшений» открыт всегда: решения покупают именно на
                  закрытом пробном кабинете, когда тарифа ещё нет. */}
              <NavLink
                className={styles['nav-link']}
                to="/cabinet/shop"
                onClick={closeMenu}
                data-testid="workspace-nav-shop"
              >
                <WorkspaceIcon name="info" />
                Магазин улучшений
              </NavLink>
            </li>
            <li>
              {/* «Уведомления» — платная функция: пункт появляется только при
                  действующем праве организации на решение. Прямой заход по
                  адресу показывает состояние «решение не подключено». */}
              {ownedCodes.has(TELEGRAM_NOTIFICATIONS_CODE) && (
                <NavLink
                  className={styles['nav-link']}
                  to="/cabinet/notifications"
                  onClick={closeMenu}
                  data-testid="workspace-nav-notifications"
                >
                  <WorkspaceIcon name="people" />
                  Уведомления
                </NavLink>
              )}
            </li>
            <li>
              {/* «Документы» не перечислены в `CLOSED_SECTIONS`: счета и акты
                  нужны именно на закрытом пробном периоде. */}
              <NavLink
                className={styles['nav-link']}
                to="/cabinet/documents"
                onClick={closeMenu}
                data-testid="workspace-nav-documents"
              >
                <WorkspaceIcon name="document" />
                Документы
              </NavLink>
            </li>
            <li>
              <NavLink
                className={styles['nav-link']}
                to="/cabinet/personnel"
                aria-disabled={locked || undefined}
                tabIndex={locked ? -1 : undefined}
                onClick={(event) => {
                  if (locked) event.preventDefault();
                  closeMenu();
                }}
                data-testid="workspace-nav-personnel"
              >
                <WorkspaceIcon name="people" />
                Персонал
              </NavLink>
            </li>
            <li>
              <NavLink
                className={styles['nav-link']}
                to="/cabinet/statistics"
                aria-disabled={locked || undefined}
                tabIndex={locked ? -1 : undefined}
                onClick={(event) => {
                  if (locked) event.preventDefault();
                  closeMenu();
                }}
                data-testid="workspace-nav-statistics"
              >
                <WorkspaceIcon name="chart" />
                Статистика
              </NavLink>
            </li>
          </ul>
        </nav>
        <div className={styles['sidebar-bottom']}>
          <nav className={styles['account-nav']} aria-label="Учётная запись">
            <NavLink
              className={styles['nav-link']}
              to="/cabinet/organization"
              end
              onClick={closeMenu}
              data-testid="workspace-nav-organization"
            >
              <WorkspaceIcon name="building" />
              Организация
            </NavLink>
            <NavLink
              className={styles['nav-link']}
              to="/cabinet/organization/members"
              aria-disabled={locked || undefined}
              tabIndex={locked ? -1 : undefined}
              onClick={(event) => {
                if (locked) event.preventDefault();
                closeMenu();
              }}
              data-testid="workspace-nav-members"
            >
              <WorkspaceIcon name="people" />
              Сотрудники
            </NavLink>
            <NavLink
              className={styles['nav-link']}
              to="/cabinet/profile"
              onClick={closeMenu}
              data-testid="workspace-nav-profile"
            >
              <WorkspaceIcon name="profile" />
              Личные данные
            </NavLink>
          </nav>
          <div className={styles.account}>
            <span className={styles['account-avatar']} aria-hidden="true">
              {userInitials(user?.full_name ?? '')}
            </span>
            <div className={styles['account-info']}>
              <p className={styles['account-name']} title={user?.full_name}>
                {user?.full_name}
              </p>
              <p className={styles['account-email']} title={user?.email}>
                {user?.email}
              </p>
            </div>
            <button
              className={styles.logout}
              type="button"
              data-testid="logout-button"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              title="Выйти"
              aria-label={loggingOut ? 'Выходим…' : 'Выйти'}
            >
              <WorkspaceIcon name="door" />
            </button>
          </div>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <button
            className={styles['menu-toggle']}
            ref={toggleRef}
            type="button"
            aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
            aria-controls="workspace-sidebar"
            aria-expanded={menuOpen}
            data-testid="workspace-menu-toggle"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <WorkspaceIcon name="menu" />
          </button>
          <div className={styles.breadcrumbs}>
            <span>Рабочее пространство</span>
            <WorkspaceIcon name="chevron" />
            <strong>{sectionTitle}</strong>
          </div>
        </header>
        <main ref={mainRef}>
          {user?.is_active === false && (
            <p className={styles['activation-banner']} data-testid="activation-banner" role="alert">
              Кабинет не активирован: мы отправили письмо со ссылкой. Откройте её или{' '}
              <Link to="/activate">запросите письмо ещё раз</Link>.
            </p>
          )}
          {logoutError && (
            <p className={styles['logout-error']} role="alert">
              {logoutError}
            </p>
          )}
          {locked && isClosedSection(trimmedPath) ? <Navigate to="/cabinet" replace /> : <Outlet />}
        </main>
      </div>
    </div>
  );
}
