import { render, screen } from '@testing-library/react';
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
