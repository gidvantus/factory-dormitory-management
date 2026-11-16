import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AccessRights } from './AccessRights';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

const ROWS = ['manager', 'admin', 'commandant'].map((role) => ({
  role,
  import_enabled: true,
  export_enabled: true,
  overview_enabled: true,
  dormitories_enabled: true,
  personnel_enabled: true,
  statistics_enabled: true,
  documents_enabled: true,
  shop_enabled: true,
  organization_enabled: true,
  members_enabled: true,
  profile_enabled: true,
}));

function show(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/access-rights']}>
        <AccessRights />
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

describe('Права доступа', () => {
  it('показывает все права, активную вкладку и сохраняет только изменённое право', async () => {
    const network = show([
      { status: 200, body: ROWS },
      { status: 200, body: { ...ROWS[0], import_enabled: false } },
    ]);
    const checkbox = await screen.findByRole('checkbox', { name: 'Менеджер: импорт' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(33);
    expect(screen.getByRole('link', { name: 'Права доступа' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.setup().click(checkbox);
    await screen.findByText('Изменения сохранены');
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Менеджер: экспорт' })).toBeChecked();
    expect(network.calls[1].url).toBe('/api/access-rights/manager');
    expect(network.calls[1].init.method).toBe('PATCH');
    expect(JSON.parse(String(network.calls[1].init.body))).toEqual({ import_enabled: false });
  });

  it('возвращает прежнюю галочку при ошибке сохранения', async () => {
    show([
      { status: 200, body: ROWS },
      { status: 502, body: { detail: 'Основной API недоступен' } },
    ]);
    const checkbox = await screen.findByRole('checkbox', { name: 'Комендант: экспорт' });
    await userEvent.setup().click(checkbox);
    expect(await screen.findByRole('alert')).toHaveTextContent('Основной API недоступен');
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
  });

  it('позволяет повторить загрузку после ошибки', async () => {
    show([{ reject: true }, { status: 200, body: ROWS }]);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Повторить загрузку' }));
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(33));
  });
});
