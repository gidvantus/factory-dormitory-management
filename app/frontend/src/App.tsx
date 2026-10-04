import { Route, Routes } from 'react-router-dom';

import { RequireAuth } from './auth/RequireAuth';
import { Cabinet } from './pages/Cabinet';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';

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
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
