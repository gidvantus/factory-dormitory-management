import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface NavLink {
  href: string;
  label: string;
}

interface SiteHeaderProps {
  /** Кнопки шапки: на главной это вход и регистрация, в кабинете — выход. */
  actions?: ReactNode;
  /** Якоря разделов страницы; на экранах без разделов список пустой. */
  nav?: NavLink[];
}

/** Шапка в стиле лендинга: логотип ведёт на главную, меню — по разделам страницы. */
export function SiteHeader({ actions, nav }: SiteHeaderProps): JSX.Element {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="site-header" data-testid="site-header" data-scrolled={scrolled}>
      <div className="container nav">
        <Link className="logo" to="/" data-testid="logo-link">
          <svg className="logo__mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
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
        </Link>

        {nav && nav.length > 0 ? (
          <nav className="nav__links" aria-label="Основная навигация">
            {nav.map((link) =>
              // Якорь раздела — обычная ссылка, внутренний адрес — `Link`:
              // переход по нему не должен перезагружать приложение.
              link.href.startsWith('#') ? (
                <a href={link.href} key={link.href}>
                  {link.label}
                </a>
              ) : (
                <Link to={link.href} key={link.href}>
                  {link.label}
                </Link>
              ),
            )}
          </nav>
        ) : null}

        {actions ? <div className="nav__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
