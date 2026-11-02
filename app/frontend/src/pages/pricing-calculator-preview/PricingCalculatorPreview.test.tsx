import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { PricingCalculatorPreview } from './PricingCalculatorPreview';

function renderPreview(): void {
  render(
    <MemoryRouter>
      <PricingCalculatorPreview />
    </MemoryRouter>,
  );
}

describe('Услуги в калькуляторе подписки', () => {
  it('подключаются по выбору и оплачиваются один раз на компанию при росте команды', async () => {
    const user = userEvent.setup();
    renderPreview();
    expect(
      screen.getByRole('checkbox', { name: 'Добавить Telegram-оповещения' }),
    ).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Добавить Журнал действий' })).not.toBeChecked();
    expect(screen.getByTestId('calculator-total')).toHaveTextContent('9 400 ₽');

    await user.click(screen.getByRole('checkbox', { name: 'Добавить Telegram-оповещения' }));
    await user.click(screen.getByRole('checkbox', { name: 'Добавить Журнал действий' }));
    expect(screen.getByTestId('calculator-total')).toHaveTextContent('10 890 ₽');

    const users = screen.getByRole('spinbutton', { name: 'Количество пользователей' });
    await user.clear(users);
    await user.type(users, '20');
    expect(screen.getByTestId('calculator-total')).toHaveTextContent('18 790 ₽');
    expect(screen.getByTestId('calculator-addon-telegram')).toHaveTextContent('500 ₽');
    expect(screen.getByTestId('calculator-addon-journal')).toHaveTextContent('990 ₽');

    await user.click(screen.getByRole('checkbox', { name: 'Добавить Журнал действий' }));
    expect(screen.getByTestId('calculator-total')).toHaveTextContent('17 800 ₽');
  });

  it('за год показывает полный платёж за услуги и сохраняет состав в пробном окне', async () => {
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole('checkbox', { name: 'Добавить Telegram-оповещения' }));
    await user.click(screen.getByRole('checkbox', { name: 'Добавить Журнал действий' }));
    await user.click(screen.getByRole('button', { name: /Год/ }));

    expect(screen.getByTestId('calculator-total')).toHaveTextContent('111 880 ₽');
    expect(screen.getByTestId('calculator-workplaces')).toHaveTextContent('94 000 ₽');
    expect(screen.getByTestId('calculator-addon-telegram')).toHaveTextContent('6 000 ₽');
    expect(screen.getByTestId('calculator-addon-journal')).toHaveTextContent('11 880 ₽');
    expect(screen.getByTestId('calculator-saving')).toHaveTextContent('24 800 ₽ за год');

    await user.click(screen.getByRole('button', { name: 'Попробовать «Домовой» бесплатно' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('111 880 ₽ в год');
    expect(screen.getByRole('dialog')).toHaveTextContent('Telegram-оповещения · за компанию');
    expect(screen.getByRole('dialog')).toHaveTextContent('Журнал действий · за компанию');
  });
});
