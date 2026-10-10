import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider } from '../auth/SessionProvider';
import { mockFetch } from '../test/mockFetch';
import { Cabinet } from './Cabinet';

const INACTIVE = {
  email: 'worker@example.com',
  full_name: 'Иванов Иван Иванович',
  created_at: '2026-01-01T00:00:00Z',
  is_active: false,
};

/**
 * Оболочка кабинета монтируется без `RequireAuth`: неактивного туда штатно
 * не пускают, а плашка — страховка на случай смены состояния сессии.
 */
function renderCabinet(profile: typeof INACTIVE): ReturnType<typeof render> {
  mockFetch((url) =>
    url.includes('/api/me')
      ? { status: 200, body: profile }
      : { status: 404, body: { detail: 'Не найдено' } },
  );
  return render(
    <MemoryRouter initialEntries={['/cabinet']}>
      <SessionProvider>
        <Routes>
          <Route path="/cabinet" element={<Cabinet />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('плашка активации в кабинете', () => {
  it('показывается, пока кабинет не активирован', async () => {
    renderCabinet(INACTIVE);

    expect(await screen.findByTestId('activation-banner')).toHaveTextContent(
      'Кабинет не активирован',
    );
    expect(screen.getByRole('link', { name: 'запросите письмо ещё раз' })).toHaveAttribute(
      'href',
      '/activate',
    );
  });

  it('при активированном кабинете плашки нет', async () => {
    renderCabinet({ ...INACTIVE, is_active: true });

    expect(await screen.findByTestId('cabinet-page')).toBeInTheDocument();
    expect(screen.queryByTestId('activation-banner')).not.toBeInTheDocument();
  });
});

describe('пункты меню учётной записи', () => {
  function renderCabinetAt(route: string): ReturnType<typeof render> {
    mockFetch((url) =>
      url.includes('/api/me')
        ? { status: 200, body: { ...INACTIVE, is_active: true } }
        : { status: 404, body: { detail: 'Не найдено' } },
    );
    return render(
      <MemoryRouter initialEntries={[route]}>
        <SessionProvider>
          <Routes>
            <Route path="/cabinet" element={<Cabinet />}>
              <Route path="organization" element={<p>Страница организации</p>} />
              <Route path="organization/members" element={<p>Страница сотрудников</p>} />
              <Route path="profile" element={<p>Личные данные</p>} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
  }

  it('ставит «Организацию» выше «Личных данных» и ведёт на свой адрес', async () => {
    const user = userEvent.setup();
    renderCabinetAt('/cabinet');

    const organization = await screen.findByTestId('workspace-nav-organization');
    const profile = screen.getByTestId('workspace-nav-profile');

    expect(organization).toHaveTextContent('Организация');
    expect(organization).toHaveAttribute('href', '/cabinet/organization');
    // Порядок проверяется по разметке, а не по глазомеру: ссылка обязана идти выше.
    expect(
      organization.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(organization);
    expect(await screen.findByText('Страница организации')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-nav-organization')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('заголовок вкладки на странице организации — «Организация — Домовой»', async () => {
    renderCabinetAt('/cabinet/organization');

    expect(await screen.findByTestId('workspace-nav-organization')).toBeInTheDocument();
    expect(document.title).toBe('Организация — Домовой');
  });

  it('ставит «Сотрудников» рядом с «Организацией» и ведёт на свой адрес', async () => {
    const user = userEvent.setup();
    renderCabinetAt('/cabinet');

    const organization = await screen.findByTestId('workspace-nav-organization');
    const members = screen.getByTestId('workspace-nav-members');

    expect(members).toHaveTextContent('Сотрудники');
    expect(members).toHaveAttribute('href', '/cabinet/organization/members');
    expect(
      organization.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(members);
    expect(await screen.findByText('Страница сотрудников')).toBeInTheDocument();
  });

  it('заголовок вкладки на странице сотрудников — «Сотрудники — Домовой»', async () => {
    renderCabinetAt('/cabinet/organization/members');

    expect(await screen.findByTestId('workspace-nav-members')).toBeInTheDocument();
    expect(document.title).toBe('Сотрудники — Домовой');
  });

  it('подсвечивает ровно один пункт меню: «Сотрудники» не подсвечивает «Организацию»', async () => {
    renderCabinetAt('/cabinet/organization/members');

    const members = await screen.findByTestId('workspace-nav-members');
    expect(members).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('workspace-nav-organization')).not.toHaveAttribute('aria-current');
  });
});
