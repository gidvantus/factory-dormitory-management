import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

import { RequireAuth } from './auth/RequireAuth';
import { Activate } from './pages/Activate';
import { Cabinet } from './pages/Cabinet';
import { ForgotPassword } from './pages/ForgotPassword';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Pricing } from './pages/Pricing';
import { Dormitories } from './workspace/Dormitories';
import { DormitoryDetails } from './workspace/dormitories/DormitoryDetails';
import { Members } from './workspace/Members';
import { Organization } from './workspace/Organization';
import { PersonalData } from './workspace/PersonalData';
import { TariffCatalog } from './workspace/TariffCatalog';
import { Tariffs } from './workspace/Tariffs';
import { WorkspaceOverview } from './workspace/WorkspaceOverview';
import { DormitoryDesignPreview } from './pages/DormitoryDesignPreview';

const StatisticsDesignPreview = lazy(() =>
  import('./pages/StatisticsDesignPreview').then((module) => ({
    default: module.StatisticsDesignPreview,
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
 * `/pricing` тоже вне `RequireAuth`: прайс публичный, а в кабинете живёт раздел
 * «Тариф» с тарифом самой организации (`/cabinet/tariffs`) и отдельный
 * прайс-лист для владельца и администратора (`/cabinet/tariffs/catalog`).
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/preview/dormitory-settings" element={<DormitoryDesignPreview />} />
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
        <Route path="tariffs" element={<Tariffs />} />
        <Route path="tariffs/catalog" element={<TariffCatalog />} />
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
        <Route path="profile" element={<PersonalData />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
