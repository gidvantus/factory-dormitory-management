import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { RequireAuth } from './auth/RequireAuth';
import { CookieConsent } from './components/CookieConsent';
import { Activate } from './pages/Activate';
import { Cabinet } from './pages/Cabinet';
import { Document } from './pages/Document';
import { ForgotPassword } from './pages/ForgotPassword';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Pricing } from './pages/Pricing';
import { Dormitories } from './workspace/Dormitories';
import { DormitoryDetails } from './workspace/dormitories/DormitoryDetails';
import { Documents } from './workspace/Documents';
import { Journal } from './workspace/Journal';
import { Members } from './workspace/Members';
import { Notifications } from './workspace/Notifications';
import { Organization } from './workspace/Organization';
import { PersonalData } from './workspace/PersonalData';
import { Shop } from './workspace/Shop';
import { WorkspaceOverview } from './workspace/WorkspaceOverview';
import { DormitoryDesignPreview } from './pages/DormitoryDesignPreview';

const StatisticsDesignPreview = lazy(() =>
  import('./pages/StatisticsDesignPreview').then((module) => ({
    default: module.StatisticsDesignPreview,
  })),
);
const PricingDesignPreview = lazy(() =>
  import('./pages/PricingDesignPreview').then((module) => ({
    default: module.PricingDesignPreview,
  })),
);
const DashboardTariffDesignPreview = lazy(() =>
  import('./pages/DashboardTariffDesignPreview').then((module) => ({
    default: module.DashboardTariffDesignPreview,
  })),
);
const ShopDesignPreview = lazy(() =>
  import('./pages/ShopDesignPreview').then((module) => ({
    default: module.ShopDesignPreview,
  })),
);
const PersonnelWorkspaceDesignPreview = lazy(() =>
  import('./pages/personnel-workspace-preview/PersonnelWorkspaceDesignPreview').then((module) => ({
    default: module.PersonnelWorkspaceDesignPreview,
  })),
);
const PersonnelTabsDesignPreview = lazy(() =>
  import('./pages/personnel-tabs-preview/PersonnelTabsDesignPreview').then((module) => ({
    default: module.PersonnelTabsDesignPreview,
  })),
);
const Statistics = lazy(() =>
  import('./workspace/Statistics').then((module) => ({ default: module.Statistics })),
);
const PersonnelDesignPreview = lazy(() =>
  import('./pages/personnel-preview/PersonnelDesignPreview').then((module) => ({
    default: module.PersonnelDesignPreview,
  })),
);
const Personnel = lazy(() =>
  import('./workspace/Personnel').then((module) => ({ default: module.Personnel })),
);

/**
 * Главная — лендинг; вход и регистрация открываются на ней же модальным окном,
 * но остаются отдельными адресами `/login` и `/register`, чтобы на них можно
 * было сослаться и обновить страницу. Экран активации стоит вне `RequireAuth`:
 * неактивный пользователь обязан до него дойти. Запрос восстановления пароля —
 * тоже отдельный адрес `/forgot-password`: на него ссылаются из формы входа и
 * из письма, и он доступен без сессии, как и `/activate`. Страница тарифов
 * `/pricing` тоже вне `RequireAuth`: прайс публичный, и отдельного раздела
 * «Тарифы» в кабинете больше нет — старые кабинетные адреса
 * (`/cabinet/tariffs`, `/cabinet/tariffs/catalog`) редиректят сюда же, поэтому
 * редиректы стоят рядом с `/pricing`, а не внутри дерева `/cabinet`: по старой
 * закладке анонимный посетитель обязан попасть на прайс, а не на экран входа.
 * Публичные документы `/documents/:code` — там же, вне `RequireAuth`: на них
 * ведут ссылки из подвала, и открывать их обязан анонимный посетитель.
 * Плашка согласия на cookie смонтирована рядом с маршрутами, а не внутри них:
 * так она видна и на публичных экранах, и во всём кабинете, и при этом не
 * перемонтируется при переходах — согласие не сбрасывается навигацией.
 */
export function App(): JSX.Element {
  return (
    <>
      <CookieConsent />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/preview/dormitory-settings" element={<DormitoryDesignPreview />} />
        <Route
          path="/preview/personnel-tabs"
          element={
            <Suspense fallback={<p role="status">Загрузка вариантов персонала…</p>}>
              <PersonnelTabsDesignPreview />
            </Suspense>
          }
        />
        <Route
          path="/preview/personnel-workspace"
          element={
            <Suspense fallback={<p role="status">Загрузка вариантов рабочей поверхности…</p>}>
              <PersonnelWorkspaceDesignPreview />
            </Suspense>
          }
        />
        <Route
          path="/preview/shop"
          element={
            <Suspense fallback={<p role="status">Загрузка вариантов магазина…</p>}>
              <ShopDesignPreview />
            </Suspense>
          }
        />
        <Route
          path="/preview/overview-tariff"
          element={
            <Suspense fallback={<p role="status">Загрузка вариантов блока тарифа…</p>}>
              <DashboardTariffDesignPreview />
            </Suspense>
          }
        />
        <Route
          path="/preview/pricing"
          element={
            <Suspense fallback={<p role="status">Загрузка вариантов тарифов…</p>}>
              <PricingDesignPreview />
            </Suspense>
          }
        />
        <Route
          path="/preview/personnel"
          element={
            <Suspense fallback={<p role="status">Загрузка макета…</p>}>
              <PersonnelDesignPreview />
            </Suspense>
          }
        />
        <Route
          path="/preview/statistics"
          element={
            <Suspense fallback={<p role="status">Загрузка макета…</p>}>
              <StatisticsDesignPreview />
            </Suspense>
          }
        />
        <Route path="/login" element={<Landing />} />
        <Route path="/register" element={<Landing />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/pricing" element={<Pricing />} />
        {/* Старые кабинетные адреса прайса: раздела «Тарифы» больше нет, но закладки
            не должны давать 404 или экран входа — редирект ведёт на публичный прайс. */}
        <Route path="/cabinet/tariffs" element={<Navigate to="/pricing" replace />} />
        <Route path="/cabinet/tariffs/catalog" element={<Navigate to="/pricing" replace />} />
        <Route path="/documents/:code" element={<Document />} />
        <Route path="/activate" element={<Activate />} />
        <Route path="/activate/:token" element={<Activate />} />
        <Route
          path="/cabinet"
          element={
            <RequireAuth>
              <Cabinet />
            </RequireAuth>
          }
        >
          <Route index element={<WorkspaceOverview />} />
          <Route path="dormitories" element={<Dormitories />} />
          <Route path="dormitories/:dormitoryId/*" element={<DormitoryDetails />} />
          <Route path="organization" element={<Organization />} />
          <Route path="organization/members" element={<Members />} />
          {/* «Магазин улучшений» работает и на закрытом пробном периоде: решение
              покупают именно тогда, когда кабинет закрыт. */}
          <Route path="shop" element={<Shop />} />
          {/* «Уведомления» — платная функция: без права организации страница
              сама показывает состояние «решение не подключено». */}
          <Route path="notifications" element={<Notifications />} />
          {/* Раздел «Документы» работает и на закрытом пробном периоде: счёт
              выставляется именно тогда, когда кабинет закрыт. */}
          <Route path="documents" element={<Documents />} />
          <Route
            path="personnel"
            element={
              <Suspense fallback={<p role="status">Загружаем персонал…</p>}>
                <Personnel />
              </Suspense>
            }
          />
          <Route
            path="statistics"
            element={
              <Suspense fallback={<p>Загрузка статистики…</p>}>
                <Statistics />
              </Suspense>
            }
          />
          <Route
            path="statistics/:reportId"
            element={
              <Suspense fallback={<p>Загрузка отчёта…</p>}>
                <Statistics />
              </Suspense>
            }
          />
          {/* «Журнал действий» — раздел владельца организации. Права проверяет
              сервер (403 остальным ролям), экран показывает это состояние сам. */}
          <Route path="journal" element={<Journal />} />
          <Route path="profile" element={<PersonalData />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
