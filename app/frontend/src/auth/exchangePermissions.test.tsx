import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { SessionProvider } from './SessionProvider';
import { useExchangePermissions } from './exchangePermissions';
import { mockFetch } from '../test/mockFetch';

afterEach(() => vi.unstubAllGlobals());

function Actions(): JSX.Element {
  const permissions = useExchangePermissions();
  return (
    <>
      {permissions.import_enabled && <button>Импорт</button>}
      {permissions.export_enabled && <button>Экспорт</button>}
    </>
  );
}

it('скрывает действия, пока права не получены', () => {
  render(<Actions />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('перечитывает права при возвращении в окно без выхода из кабинета', async () => {
  let canExport = true;
  mockFetch(() => ({
    status: 200,
    body: {
      email: 'manager@example.com',
      full_name: 'Менеджер',
      created_at: '2026-11-10T10:00:00Z',
      is_active: true,
      role: 'manager',
      permissions: { import_enabled: false, export_enabled: canExport },
    },
  }));
  render(
    <MemoryRouter>
      <SessionProvider>
        <Actions />
      </SessionProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Экспорт' });
  expect(screen.queryByRole('button', { name: 'Импорт' })).not.toBeInTheDocument();
  canExport = false;
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
});
