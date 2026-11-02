import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ArrivalWorkflowPreview } from './ArrivalWorkflowPreview';

it('переносит человека с сохранением текущего дня и показывает его при ручном выборе новой даты', async () => {
  const user = userEvent.setup();
  render(<ArrivalWorkflowPreview />);
  const anna = screen.getByTestId('workflow-person-anna');
  await user.click(within(anna).getByRole('button', { name: 'Перенести' }));
  const modal = screen.getByRole('dialog');
  fireEvent.change(within(modal).getByLabelText('Новая дата заезда'), {
    target: { value: '2026-10-29' },
  });
  await user.click(within(modal).getByRole('button', { name: 'Перенести заезд' }));
  expect(screen.queryByTestId('workflow-person-anna')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Начало периода')).toHaveValue('2026-10-27');
  expect(screen.getByTestId('workflow-person-alex')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Полная информация: Павел Ильин' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /29 окт/ }));
  const people = screen.getByRole('list', { name: 'Люди: Северное' });
  expect(
    within(people).getByRole('button', { name: 'Полная информация: Анна Морозова' }),
  ).toBeInTheDocument();
  expect(
    within(people).getByRole('button', { name: 'Полная информация: Павел Ильин' }),
  ).toBeInTheDocument();
  expect(within(people).getAllByText('Ожидается')).toHaveLength(2);
  expect(within(people).getByText('15')).toBeInTheDocument();
  const note = within(people).getByText(/Перенесён с 27 окт/);
  expect(note.tagName).toBe('SMALL');
  expect(note.closest('button,a')).toBeNull();
});

it('после прибытия и неявки позволяет изменить решение и снова показывает три действия', async () => {
  const user = userEvent.setup();
  render(<ArrivalWorkflowPreview />);
  const alex = screen.getByTestId('workflow-person-alex');
  for (const [label, status] of [
    ['Прибыл', 'arrived'],
    ['Не приехал', 'no_show'],
  ]) {
    await user.click(within(alex).getByRole('button', { name: label }));
    expect(alex).toHaveAttribute('data-status', status);
    expect(within(alex).queryByRole('button', { name: 'Перенести' })).not.toBeInTheDocument();
    await user.click(within(alex).getByRole('button', { name: 'Изменить статус' }));
    expect(alex).toHaveAttribute('data-status', 'expected');
    for (const choice of ['Прибыл', 'Не приехал', 'Перенести']) {
      expect(within(alex).getByRole('button', { name: choice })).toBeEnabled();
    }
  }
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Заселить|проживание/i })).not.toBeInTheDocument();
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
