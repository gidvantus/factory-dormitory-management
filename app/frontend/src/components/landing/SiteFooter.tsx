import { Link } from 'react-router-dom';

interface FooterColumn {
  title: string;
  links: Array<{ label: string; href: string }>;
}

const COLUMNS: FooterColumn[] = [
  {
    title: 'Продукт',
    links: [
      { label: 'Возможности', href: '#features' },
      { label: 'Интерфейс', href: '#interface' },
      { label: 'Отчётность', href: '#reports' },
      { label: 'Внедрение', href: '#how' },
      { label: 'Тарифы', href: '/pricing' },
    ],
  },
  {
    title: 'Роли',
    links: [
      { label: 'Коменданту', href: '#roles' },
      { label: 'Кадровой службе', href: '#roles' },
      { label: 'Руководителю', href: '#roles' },
    ],
  },
  {
    title: 'Связь',
    links: [
      { label: 'Запросить демо', href: '#demo' },
      { label: 'Частые вопросы', href: '#faq' },
      { label: 'Регистрация', href: '/register' },
    ],
  },
];

/** Подвал: логотип, разделы страницы и копирайт. */
export function SiteFooter(): JSX.Element {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer__grid">
          <div className="footer__about">
            <Link className="logo" to="/">
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
            <p>
              CRM для учёта рабочих, проживающих в общежитиях: реестр, комнаты и места, заселение,
              отчётность.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h3>{column.title}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.href.startsWith('#') ? (
                      <a href={link.href}>{link.label}</a>
                    ) : (
                      <Link to={link.href}>{link.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="footer__bottom">
          <span>© 2026 Домовой. CRM для учёта рабочих, проживающих в общежитиях.</span>
          <span>Иллюстрации нарисованы для проекта.</span>
        </div>
      </div>
    </footer>
  );
}
