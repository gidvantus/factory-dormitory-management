import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { PricingCalculatorPreview } from './PricingCalculatorPreview';

function renderPreview(path = '/preview/pricing-calculator'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <PricingCalculatorPreview />
    </MemoryRouter>,
  );
}

/** Вводит количество дополнительных мест в счётчик макета. */
async function chooseSeats(user: ReturnType<typeof userEvent.setup>, seats: number): Promise<void> {
  const field = screen.getByRole('spinbutton', { name: 'Дополнительные места' });
  await user.clear(field);
  await user.type(field, String(seats));
}

describe('Оформление лицензии на тестовой странице', () => {
  it('даёт купить лицензию без доп. мест и пересчитывает итог после добавления мест', async () => {
    const user = userEvent.setup();
    renderPreview();
    expect(screen.getByTestId('license-total')).toHaveTextContent('60 000 ₽');
    expect(screen.getByText(/Сотрудников в лицензии/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Увеличить количество мест' }));
    // Место в макете стоит 1 500 ₽ — те же числа, что отдаёт сервер.
    expect(screen.getByTestId('license-total')).toHaveTextContent('61 500 ₽');

    expect(screen.getByRole('checkbox', { name: /Telegram-оповещения/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Журнал действий/ })).toBeDisabled();
    expect(screen.getAllByText('Скоро будет доступно')).toHaveLength(2);
    expect(screen.queryByText(/в месяц/)).not.toBeInTheDocument();

    await chooseSeats(user, 20);
    expect(screen.getByTestId('license-seat-unit')).toHaveTextContent('1 200 ₽');
    expect(screen.getByTestId('license-total')).toHaveTextContent('84 000 ₽');
  });

  it('показывает годовую лицензию и максимальную скидку в заказе', async () => {
    const user = userEvent.setup();
    renderPreview();
    await chooseSeats(user, 50);
    await user.click(screen.getByTestId('license-term-year'));

    expect(screen.getByText(/Сотрудников в лицензии/)).toBeVisible();
    expect(screen.getByTestId('license-seat-unit')).toHaveTextContent('750 ₽');
    expect(screen.getByTestId('license-seat-total')).toHaveTextContent('37 500 ₽');
    expect(screen.getByTestId('license-total')).toHaveTextContent('137 500 ₽');

    await user.click(screen.getByRole('button', { name: 'Посмотреть заказ' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('137 500 ₽');
    expect(dialog).toHaveTextContent('50 мест');
    expect(dialog).not.toHaveTextContent('Telegram');
  });
});

describe('Докупка пользователей в макете магазина', () => {
  it('открывается со второй вкладки и учитывает количество, скидку и остаток срока', async () => {
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole('link', { name: 'Магазин улучшений' }));
    expect(screen.getByTestId('store-total')).toHaveTextContent('9 000 ₽');
    expect(screen.getByTestId('store-total-users')).toHaveTextContent('20');
    expect(screen.getByRole('checkbox', { name: /Telegram-оповещения/ })).toBeDisabled();

    const users = screen.getByRole('spinbutton', { name: 'Сколько мест добавить' });
    await user.clear(users);
    await user.type(users, '50');
    expect(screen.getByTestId('store-total')).toHaveTextContent('25 000 ₽');

    await user.click(screen.getByText('Изменить данные примера'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Лицензия компании' }), 'year');
    expect(screen.getByTestId('store-total')).toHaveTextContent('18 750 ₽');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Осталось месяцев' }), '3');
    expect(screen.getByTestId('store-total')).toHaveTextContent('9 375 ₽');

    await user.click(screen.getByRole('button', { name: 'Докупить пользователей' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('9 375 ₽');
    expect(screen.getByRole('dialog')).toHaveTextContent('3 из 12 мес.');
  });

  it('не даёт оформить пустую покупку и покупку при истёкшей лицензии', async () => {
    const user = userEvent.setup();
    renderPreview('/preview/pricing-calculator?view=store');
    await user.clear(screen.getByRole('spinbutton', { name: 'Сколько мест добавить' }));
    expect(screen.getByRole('button', { name: 'Докупить пользователей' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Введите целое число');
    await user.type(screen.getByRole('spinbutton', { name: 'Сколько мест добавить' }), '1');
    await user.click(screen.getByText('Изменить данные примера'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Осталось месяцев' }), '0');
    expect(screen.getByRole('button', { name: 'Докупить пользователей' })).toBeDisabled();
    expect(screen.getByText('Срок истёк')).toBeVisible();
  });
});
