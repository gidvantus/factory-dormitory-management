import { useLocation, useNavigate } from 'react-router-dom';

import { AuthDialog } from '../components/AuthDialog';
import type { AuthMode } from '../components/AuthDialog';
import { SiteHeader } from '../components/SiteHeader';
import { CtaSection } from '../components/landing/CtaSection';
import { FaqSection } from '../components/landing/FaqSection';
import { FeaturesSection } from '../components/landing/FeaturesSection';
import { Hero } from '../components/landing/Hero';
import { InterfaceSection } from '../components/landing/InterfaceSection';
import { ReportsSection } from '../components/landing/ReportsSection';
import { ReviewsSection } from '../components/landing/ReviewsSection';
import { RolesSection } from '../components/landing/RolesSection';
import { SiteFooter } from '../components/landing/SiteFooter';
import { StepsSection } from '../components/landing/StepsSection';
import { useReveal } from '../components/landing/useReveal';
import { useSession } from '../auth/SessionProvider';

/** Разделы страницы для меню в шапке. */
const NAV = [
  { href: '#roles', label: 'Кому подходит' },
  { href: '#features', label: 'Возможности' },
  { href: '#how', label: 'Как работает' },
  { href: '#interface', label: 'Интерфейс' },
  { href: '#faq', label: 'Вопросы' },
];

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

/**
 * Главная страница: весь контент лендинга плюс рабочая регистрация и вход.
 * Формы живут в модальном окне, чтобы не дублировать разметку в каждом блоке.
 */
export function Landing(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { status } = useSession();
  const dialog = dialogFromPath(location.pathname);

  useReveal();

  return (
    <div className="app" data-testid="landing">
      <a className="skip-link" href="#main">
        К основному содержанию
      </a>

      <SiteHeader
        nav={NAV}
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

      <main id="main">
        <Hero onRegister={() => navigate('/register')} onLogin={() => navigate('/login')} />
        <RolesSection />
        <FeaturesSection />
        <StepsSection />
        <InterfaceSection />
        <ReportsSection />
        <ReviewsSection />
        <FaqSection />
        <CtaSection onRegister={() => navigate('/register')} onLogin={() => navigate('/login')} />
      </main>

      <SiteFooter />

      {dialog ? <AuthDialog mode={dialog} onClose={() => navigate('/')} /> : null}
    </div>
  );
}
