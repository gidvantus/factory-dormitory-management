import { useLocation, useNavigate } from 'react-router-dom';

import { AuthDialog } from '../components/AuthDialog';
import type { AuthMode } from '../components/AuthDialog';
import { SiteActions } from '../components/SiteActions';
import { SiteHeader } from '../components/SiteHeader';
import { CtaSection } from '../components/landing/CtaSection';
import { FaqSection } from '../components/landing/FaqSection';
import { FeaturesSection } from '../components/landing/FeaturesSection';
import { Hero } from '../components/landing/Hero';
import { InterfaceSection } from '../components/landing/InterfaceSection';
import { ReportsSection } from '../components/landing/ReportsSection';
import { RolesSection } from '../components/landing/RolesSection';
import { SiteFooter } from '../components/landing/SiteFooter';
import { StepsSection } from '../components/landing/StepsSection';
import { useReveal } from '../components/landing/useReveal';
import { siteNav } from '../components/siteNav';

/** Меню главной: якоря её разделов плюс отдельный адрес тарифов. */
const NAV = siteNav({ onHome: true, withPricing: true });

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
  const dialog = dialogFromPath(location.pathname);

  useReveal();

  return (
    <div className="app" data-testid="landing">
      <a className="skip-link" href="#main">
        К основному содержанию
      </a>

      <SiteHeader nav={NAV} actions={<SiteActions />} />

      <main id="main">
        <Hero onRegister={() => navigate('/register')} onLogin={() => navigate('/login')} />
        <RolesSection />
        <FeaturesSection />
        <StepsSection />
        <InterfaceSection />
        <ReportsSection />
        <FaqSection />
        <CtaSection onRegister={() => navigate('/register')} onLogin={() => navigate('/login')} />
      </main>

      <SiteFooter />

      {dialog ? <AuthDialog mode={dialog} onClose={() => navigate('/')} /> : null}
    </div>
  );
}
