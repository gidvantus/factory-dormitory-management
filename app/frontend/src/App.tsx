import { Route, Routes } from 'react-router-dom';

import { RequireAuth } from './auth/RequireAuth';
import { Cabinet } from './pages/Cabinet';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Dormitories } from './workspace/Dormitories';
import { DormitoryDetails } from './workspace/dormitories/DormitoryDetails';
import { PersonalData } from './workspace/PersonalData';
import { WorkspaceOverview } from './workspace/WorkspaceOverview';

/**
 * Главная — лендинг; вход и регистрация открываются на ней же модальным окном,
 * но остаются отдельными адресами `/login` и `/register`, чтобы на них можно
 * было сослаться и обновить страницу.
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Landing />} />
      <Route path="/register" element={<Landing />} />
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
        <Route path="dormitories/:dormitoryId" element={<DormitoryDetails />} />
        <Route path="profile" element={<PersonalData />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
