import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { RequireOperator } from './RequireOperator';
import { useOperator } from './operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

/** Экран под защитой: показывает логин, который отдал `RequireOperator`. */
function Protected(): JSX.Element {
  const operator = useOperator();
  return <p data-testid="protected">Внутри кабинета: {operator.username}</p>;
}

function renderProtected(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <RequireOperator>
              <Protected />
            </RequireOperator>
          }
        />
        <Route path="/login" element={<p data-testid="login-probe">Форма входа</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return network;
}

describe('RequireOperator', () => {
  it('анонима с 401 уводит на /login', async () => {
    const network = renderProtected([{ status: 401, body: { detail: 'Требуется авторизация' } }]);

    expect(await screen.findByTestId('login-probe')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    expect(network.calls[0].url).toBe('/api/auth/me');
    expect(network.calls[0].init.credentials).toBe('include');
  });

  it('с сессией пускает и отдаёт логин оператора', async () => {
    renderProtected([{ status: 200, body: { username: 'operator' } }]);

    const protectedScreen = await screen.findByTestId('protected');
    expect(protectedScreen).toHaveTextContent('Внутри кабинета: operator');
    expect(screen.queryByTestId('login-probe')).not.toBeInTheDocument();
  });

  it('пока идёт проверка, показывает только строку статуса', async () => {
    let release: (response: { status: number; body: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    renderProtected([() => pending]);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Проверяем сессию…');
    // Ни формы, ни пустого блока до ответа сервера быть не должно.
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-probe')).not.toBeInTheDocument();

    release({ status: 200, body: { username: 'operator' } });
    expect(await screen.findByTestId('protected')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('сетевой отказ тоже ведёт на форму входа, а не в пустой экран', async () => {
    renderProtected([{ reject: true }]);

    expect(await screen.findByTestId('login-probe')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });
});
