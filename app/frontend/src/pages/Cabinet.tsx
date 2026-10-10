import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useSession } from '../auth/SessionProvider';
import { userInitials } from '../workspace/userInitials';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import styles from '../workspace/Workspace.module.css';

const sectionTitles: Record<string, string> = {
  '/cabinet': 'Обзор',
  '/cabinet/dormitories': 'Общежития',
  '/cabinet/organization': 'Организация',
  '/cabinet/organization/members': 'Сотрудники',
  '/cabinet/profile': 'Личные данные',
};

/** Общая оболочка рабочего пространства и вложенных страниц. */
export function Cabinet(): JSX.Element {
  const { user, logout } = useSession();
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
                onClick={closeMenu}
                data-testid="workspace-nav-dormitories"
              >
                <WorkspaceIcon name="house" />
                Общежития
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
              onClick={closeMenu}
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
          <Outlet />
        </main>
      </div>
    </div>
  );
}
