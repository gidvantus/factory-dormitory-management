import { Navigate, Route, Routes } from 'react-router-dom';

import { RequireOperator } from './auth/RequireOperator';
import { Invoices } from './pages/Invoices';
import { Login } from './pages/Login';
import { OrganizationCard } from './pages/OrganizationCard';
import { Organizations } from './pages/Organizations';
import { Tariffs } from './pages/Tariffs';
import { UserCard } from './pages/UserCard';
import { Users } from './pages/Users';

/**
 * Маршруты кабинета оператора.
 *
 * `/login` — форма входа без проверки сессии; `/` — список организаций под
 * `RequireOperator` (аноним уезжает на `/login`); `/organizations/:id` —
 * карточка организации; `/invoices` — реестр счетов всех организаций;
 * `/tariffs` — прайс платформы с правкой и снятием с продажи; `/users` — список
 * учётных записей платформы; `/users/:id` — карточка пользователя. Всё остальное
 * редиректит на `/`, чтобы старый адрес не давал 404.
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
      <Route
        path="/invoices"
        element={
          <RequireOperator>
            <Invoices />
          </RequireOperator>
        }
      />
      <Route
        path="/tariffs"
        element={
          <RequireOperator>
            <Tariffs />
          </RequireOperator>
        }
      />
      <Route
        path="/users"
        element={
          <RequireOperator>
            <Users />
          </RequireOperator>
        }
      />
      <Route
        path="/users/:id"
        element={
          <RequireOperator>
            <UserCard />
          </RequireOperator>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
