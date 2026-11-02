import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { UnsavedChangesProvider } from './components/UnsavedChanges';

import { App } from './App';
import { SessionProvider } from './auth/SessionProvider';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Не найден узел #root');
}
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <SessionProvider>
        <UnsavedChangesProvider>
          <App />
        </UnsavedChangesProvider>
      </SessionProvider>
    ),
  },
]);

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
