import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

import { ExchangePermissionsContext } from '../auth/exchangePermissions';
import type { ExchangePermissions } from '../auth/exchangePermissions';

export function renderWithExchangePermissions(
  ui: ReactElement,
  permissions: ExchangePermissions = { import_enabled: true, export_enabled: true },
): ReturnType<typeof render> {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ExchangePermissionsContext.Provider value={permissions}>
        {children}
      </ExchangePermissionsContext.Provider>
    ),
  });
}
