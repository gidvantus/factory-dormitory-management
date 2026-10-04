import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface SiteHeaderProps {
  /** Кнопки шапки: на главной это вход и регистрация, в кабинете — выход. */
  actions?: ReactNode;
}

/** Шапка в стиле лендинга: логотип ведёт на главную. */
export function SiteHeader({ actions }: SiteHeaderProps): JSX.Element {
  return (
    <header className="site-header" data-testid="site-header">
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
        {actions ? <div className="nav__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
