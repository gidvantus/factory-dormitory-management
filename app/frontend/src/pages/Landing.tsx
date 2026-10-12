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
import { useHashScroll } from '../components/landing/useHashScroll';
import { useReveal } from '../components/landing/useReveal';
import { siteNav } from '../components/siteNav';
import { useSession } from '../auth/SessionProvider';

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
 * Приход по адресу с якорем (`/#features`) открывает нужный раздел: разметку
 * главной рисует именно эта страница, и только она знает про её разделы.
 */
export function Landing(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { status } = useSession();
  const dialog = dialogFromPath(location.pathname);

  useReveal();
  useHashScroll(location.hash);

  return (
    <div className="app" data-testid="landing">
      <a className="skip-link" href="#main">
        К основному содержанию
      </a>

      <SiteHeader nav={NAV} actions={<SiteActions />} />

      <main id="main">
        <Hero
          onRegister={() => navigate('/register')}
          onLogin={() => navigate('/login')}
          authenticated={status === 'authenticated'}
          onCabinet={() => navigate('/cabinet')}
        />
        <RolesSection />
        <FeaturesSection />
        <StepsSection />
        <InterfaceSection />
        <ReportsSection />
        <FaqSection />
        <CtaSection
          onRegister={() => navigate('/register')}
          onLogin={() => navigate('/login')}
          authenticated={status === 'authenticated'}
          onCabinet={() => navigate('/cabinet')}
        />
      </main>

      <SiteFooter />

      {dialog ? <AuthDialog mode={dialog} onClose={() => navigate('/')} /> : null}
    </div>
  );
}
