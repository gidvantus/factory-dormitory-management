import { Navigate, Route, Routes } from 'react-router-dom';

import { RequireOperator } from './auth/RequireOperator';
import { Home } from './pages/Home';
import { Login } from './pages/Login';

/**
 * Маршруты кабинета оператора.
 *
 * `/login` — форма входа без проверки сессии; `/` — пустая страница под
 * `RequireOperator` (аноним уезжает на `/login`); всё остальное редиректит на
 * `/`, чтобы старый адрес не давал 404.
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireOperator>
            <Home />
          </RequireOperator>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
