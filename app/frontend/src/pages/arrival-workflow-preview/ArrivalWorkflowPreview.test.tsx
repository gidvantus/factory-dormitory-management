import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ArrivalWorkflowPreview } from './ArrivalWorkflowPreview';

it('переносит отдельного человека на выбранную дату и открывает связанный заезд с сохранёнными сменами', async () => {
  const user = userEvent.setup();
  render(<ArrivalWorkflowPreview />);
  const anna = screen.getByTestId('workflow-person-anna');
  await user.click(within(anna).getByRole('button', { name: 'Перенести' }));
  const modal = screen.getByRole('dialog');
  fireEvent.change(within(modal).getByLabelText('Новая дата заезда'), {
    target: { value: '2026-10-29' },
  });
  expect(within(modal).getByText(/уже запланировано 1 чел/)).toBeInTheDocument();
  await user.click(within(modal).getByRole('button', { name: 'Перенести заезд' }));
  expect(anna).toHaveAttribute('data-status', 'moved');
  await user.click(within(anna).getByRole('button', { name: /Открыть 29 окт/ }));
  const people = screen.getByRole('list', { name: 'Люди: Северное' });
  expect(
    within(people).getByRole('button', { name: 'Полная информация: Анна Морозова' }),
  ).toBeInTheDocument();
  expect(
    within(people).getByRole('button', { name: 'Полная информация: Павел Ильин' }),
  ).toBeInTheDocument();
  expect(within(people).getAllByText('Ожидается')).toHaveLength(2);
  expect(within(people).getByText('15')).toBeInTheDocument();
  expect(within(people).getByText('Перенесён с 27 окт.')).toBeInTheDocument();
});

it('отдельно отмечает прибытие, заполняет проживание и сохраняет исходный заезд', async () => {
  const user = userEvent.setup();
  render(<ArrivalWorkflowPreview />);
  let alex = screen.getByTestId('workflow-person-alex');
  await user.click(within(alex).getByRole('button', { name: 'Прибыл' }));
  expect(alex).toHaveAttribute('data-status', 'arrived');
  await user.click(within(alex).getByRole('button', { name: 'В проживающие' }));
  const modal = screen.getByRole('dialog');
  expect(within(modal).getByLabelText('Табельный номер')).toHaveValue('0041');
  expect(within(modal).getByLabelText('Количество смен')).toHaveValue(15);
  await user.selectOptions(within(modal).getByLabelText('Место проживания'), 'Корпус А');
  await user.click(within(modal).getByRole('button', { name: 'Оформить в проживающие' }));
  expect(alex).toHaveAttribute('data-status', 'settled');
  await user.click(screen.getByRole('button', { name: 'Проживающие 2' }));
  const resident = screen.getByTestId('resident-alex');
  expect(within(resident).getByText('Корпус А')).toBeInTheDocument();
  expect(within(resident).getByText('15 смен')).toBeInTheDocument();
  await user.click(within(resident).getByRole('button', { name: /Из плана/ }));
  alex = screen.getByTestId('workflow-person-alex');
  expect(alex).toHaveAttribute('data-status', 'settled');
  await user.click(within(alex).getByRole('button', { name: 'Открыть проживание' }));
  expect(within(screen.getByRole('dialog')).getByText(/Встреча у проходной/)).toBeInTheDocument();
});

it('сохраняет скрытые поля в полной информации, а отметка не открывает карточку поверх действия', async () => {
  const user = userEvent.setup();
  render(<ArrivalWorkflowPreview />);
  expect(screen.queryByText(/Встреча у проходной/)).not.toBeInTheDocument();
  await user.click(
    within(screen.getByTestId('workflow-person-mikhail')).getByRole('button', {
      name: 'Не приехал',
    }),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Полная информация ↗' }));
  const modal = screen.getByRole('dialog');
  expect(within(modal).getByText(/Встреча у проходной/)).toBeInTheDocument();
  expect(within(modal).getByTestId('workflow-person-mikhail')).toHaveAttribute(
    'data-status',
    'no_show',
  );
});
