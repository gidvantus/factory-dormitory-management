import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';
import { SessionProvider } from './SessionProvider';
import { sections } from './sectionPermissions';
import { Cabinet } from '../pages/Cabinet';
import { mockFetch } from '../test/mockFetch';

afterEach(() => vi.unstubAllGlobals());
it.each(sections)(
  'скрывает раздел $label и не монтирует его экран по прямой ссылке',
  async (section) => {
    const page = vi.fn(() => <p>Закрытые данные</p>);
    const profile = {
      email: 'worker@example.com',
      full_name: 'Сотрудник',
      created_at: '2026-01-01T00:00:00Z',
      is_active: true,
      role: 'manager',
      permissions: { import_enabled: true, export_enabled: true, [section.key]: false },
    };
    mockFetch((url) => {
      if (url.endsWith('/me')) return { status: 200, body: profile };
      if (url.endsWith('/trial'))
        return {
          status: 200,
          body: {
            locked: false,
            is_active: false,
            ends_at: null,
            days_left: 0,
            member_limit: null,
          },
        };
      if (url.endsWith('/tariffs/current'))
        return { status: 200, body: { current: null, is_paid: false, next: null } };
      if (url.endsWith('/solutions')) return { status: 200, body: { items: [] } };
      if (url.endsWith('/solutions/entitlements')) return { status: 200, body: [] };
      return { status: 404, body: { detail: 'Не найдено' } };
    });
    const Page = page;
    render(
      <MemoryRouter initialEntries={[section.path]}>
        <SessionProvider>
          <Routes>
            <Route
              path="/cabinet"
              element={
                <RequireAuth>
                  <Cabinet />
                </RequireAuth>
              }
            >
              <Route index element={<Page />} />
              <Route path="*" element={<Page />} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Раздел недоступен' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: section.label })).not.toBeInTheDocument();
    expect(page).not.toHaveBeenCalled();
  },
);
