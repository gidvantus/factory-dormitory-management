import { Link, useLocation } from 'react-router-dom';

/**
 * Навигация кабинета: два раздела — организации и пользователи.
 *
 * Активный раздел помечен `aria-current="page"` и подчёркиванием на линии шапки:
 * цвет в метке не участвует, а скринридер читает «текущая страница». Раздел
 * «Организации» — корень кабинета (`/`), его карточки (`/organizations/:id`) тоже
 * относятся к нему, поэтому активность считается по префиксу пути, а не
 * сравнением с `/`.
 */
export function OperatorNav(): JSX.Element {
  const { pathname } = useLocation();
  const onUsers = pathname === '/users' || pathname.startsWith('/users/');
  const onOrganizations = pathname === '/' || pathname.startsWith('/organizations/');

  return (
    <nav className="nav" aria-label="Разделы кабинета">
      <Link
        className="nav__link"
        to="/"
        aria-current={onOrganizations ? 'page' : undefined}
        data-testid="operator-nav-organizations"
      >
        Организации
      </Link>
      <Link
        className="nav__link"
        to="/users"
        aria-current={onUsers ? 'page' : undefined}
        data-testid="operator-nav-users"
      >
        Пользователи
      </Link>
    </nav>
  );
}
