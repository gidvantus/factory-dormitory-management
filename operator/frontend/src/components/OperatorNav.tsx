import { Link, useLocation } from 'react-router-dom';

/**
 * Навигация кабинета: пять разделов — организации, счета, тарифы, пользователи
 * и реквизиты поставщика.
 *
 * Активный раздел помечен `aria-current="page"` и подчёркиванием на линии шапки:
 * цвет в метке не участвует, а скринридер читает «текущая страница». Раздел
 * «Организации» — корень кабинета (`/`), его карточки (`/organizations/:id`) тоже
 * относятся к нему, поэтому активность считается по префиксу пути, а не
 * сравнением с `/`. У счетов, тарифов и реквизитов своих карточек нет: экран —
 * единственное место действий, но префикс считается так же, как у остальных
 * разделов. Порядок вкладок — порядок макета постановки (`mockups/178/`):
 * тарифы стоят между счетами и пользователями, «Реквизиты» — последние, после
 * «Пользователей» (`Контракт половин` #179).
 */
export function OperatorNav(): JSX.Element {
  const { pathname } = useLocation();
  const onUsers = pathname === '/users' || pathname.startsWith('/users/');
  const onTariffs = pathname === '/tariffs' || pathname.startsWith('/tariffs/');
  const onInvoices = pathname === '/invoices' || pathname.startsWith('/invoices/');
  const onCompany = pathname === '/company' || pathname.startsWith('/company/');
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
        to="/invoices"
        aria-current={onInvoices ? 'page' : undefined}
        data-testid="operator-nav-invoices"
      >
        Счета
      </Link>
      <Link
        className="nav__link"
        to="/tariffs"
        aria-current={onTariffs ? 'page' : undefined}
        data-testid="operator-nav-tariffs"
      >
        Тарифы
      </Link>
      <Link
        className="nav__link"
        to="/users"
        aria-current={onUsers ? 'page' : undefined}
        data-testid="operator-nav-users"
      >
        Пользователи
      </Link>
      <Link
        className="nav__link"
        to="/company"
        aria-current={onCompany ? 'page' : undefined}
        data-testid="operator-nav-company"
      >
        Реквизиты
      </Link>
    </nav>
  );
}
