import { Link } from 'react-router-dom';

import { SiteHeader } from '../components/SiteHeader';

/** Заглушка для неизвестного маршрута — в том же оформлении, что и остальные экраны. */
export function NotFound(): JSX.Element {
  return (
    <div className="app" data-testid="not-found-page">
      <SiteHeader />
      <main className="container centered">
        <div>
          <p className="eyebrow">404</p>
          <h1>Страница не найдена</h1>
          <p className="hero__lead" data-testid="not-found">
            Такого адреса у Домового нет. Вернитесь на главную и начните оттуда.
          </p>
          <p>
            <Link className="btn btn--primary" to="/" data-testid="not-found-home">
              На главную
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
