import { Navigate, Route, Routes } from 'react-router-dom';

import { RequireOperator } from './auth/RequireOperator';
import { Login } from './pages/Login';
import { OrganizationCard } from './pages/OrganizationCard';
import { Organizations } from './pages/Organizations';

/**
 * Маршруты кабинета оператора.
 *
 * `/login` — форма входа без проверки сессии; `/` — список организаций под
 * `RequireOperator` (аноним уезжает на `/login`); `/organizations/:id` —
 * карточка организации под той же проверкой; всё остальное редиректит на `/`,
 * чтобы старый адрес не давал 404.
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireOperator>
            <Organizations />
          </RequireOperator>
        }
      />
      <Route
        path="/organizations/:id"
        element={
          <RequireOperator>
            <OrganizationCard />
          </RequireOperator>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
