import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Home } from './Home';
import { OperatorContext } from '../auth/operatorContext';
import { mockFetch } from '../test/mockFetch';
import type { MockStep } from '../test/mockFetch';

function renderHome(steps: MockStep[]) {
  const network = mockFetch(steps);
  render(
    <OperatorContext.Provider value={{ username: 'operator' }}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<p data-testid="login-probe">Форма входа</p>} />
        </Routes>
      </MemoryRouter>
    </OperatorContext.Provider>,
  );
  return network;
}

describe('главная кабинета оператора', () => {
  it('показывает пустую страницу и логин оператора', () => {
    renderHome([]);

    expect(screen.getByTestId('operator-home')).toBeInTheDocument();
    expect(screen.getByText('Данных пока нет')).toBeInTheDocument();
    expect(screen.getByTitle('Логин, под которым открыт кабинет')).toHaveTextContent('operator');
  });

  it('«Выйти» гасит сессию и возвращает на форму входа', async () => {
    const network = renderHome([{ status: 204 }]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-logout'));

    expect(await screen.findByTestId('login-probe')).toBeInTheDocument();
    expect(network.calls[0].url).toBe('/api/auth/logout');
    expect(network.calls[0].init.method).toBe('POST');
    expect(network.calls[0].init.credentials).toBe('include');
  });

  it('сетевой отказ на выходе всё равно уводит на форму входа', async () => {
    renderHome([{ reject: true }]);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('operator-logout'));

    expect(await screen.findByTestId('login-probe')).toBeInTheDocument();
  });
});
