import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../App';
import { SessionProvider } from '../auth/SessionProvider';

export function renderApp(route = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}
