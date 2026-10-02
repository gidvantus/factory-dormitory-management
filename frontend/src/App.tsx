import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { RequireAuth } from './auth/RequireAuth';
import { Cabinet } from './pages/Cabinet';
import { Login } from './pages/Login';
import { Register } from './pages/Register';

export function App(): JSX.Element {
  return (
    <>
      <nav>
        <Link to="/register" data-testid="nav-register">
          Регистрация
        </Link>{' '}
        <Link to="/login" data-testid="nav-login">
          Вход
        </Link>{' '}
        <Link to="/cabinet" data-testid="nav-cabinet">
          Кабинет
        </Link>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/cabinet" replace />} />
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<Login />} />
          <Route
            path="/cabinet"
            element={
              <RequireAuth>
                <Cabinet />
              </RequireAuth>
            }
          />
          <Route path="*" element={<p data-testid="not-found">Страница не найдена</p>} />
        </Routes>
      </main>
    </>
  );
}
