import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import HostelBuilderPreview from './HostelBuilderPreview';

afterEach(() => window.localStorage.clear());

it('сохраняет ссылки при переименовании и пересчитывает формулы после ручного ввода', async () => {
  const user = userEvent.setup();
  render(<HostelBuilderPreview />);
  await user.click(screen.getByRole('button', { name: 'Настроить хостел' }));
  const builder = within(screen.getByRole('dialog', { name: 'Настроить хостел' }));
  fireEvent.change(builder.getByLabelText('Название строки'), {
    target: { value: 'Мужчин проживает' },
  });
  await user.click(builder.getByRole('button', { name: 'Проживает Итого (М+Ж)' }));
  expect(builder.getByLabelText('Формула', { selector: 'textarea' })).toHaveValue(
    '=[Мужчин проживает]+[Проживает Ж]',
  );
  await user.click(builder.getByRole('button', { name: 'Сохранить изменения' }));

  fireEvent.change(screen.getByLabelText('Оплачено мест М, 14 ноября'), {
    target: { value: '65' },
  });
  const total = screen.getByRole('rowheader', { name: 'Свободно мест Итого' }).closest('tr')!;
  expect(within(total).getAllByRole('cell').at(-1)).toHaveTextContent('11');
});

it('переносит шаблон в другое общежитие с формулами и пустыми ручными значениями', async () => {
  const user = userEvent.setup();
  render(<HostelBuilderPreview />);
  await user.click(screen.getByRole('button', { name: 'Настроить хостел' }));
  const builder = within(screen.getByRole('dialog', { name: 'Настроить хостел' }));
  await user.click(builder.getByRole('button', { name: '+ Строка' }));
  fireEvent.change(builder.getByLabelText('Название строки'), {
    target: { value: 'Прибыло за день' },
  });
  await user.click(builder.getByRole('radio', { name: 'Связь с таблицей' }));
  await user.selectOptions(builder.getByLabelText('Таблица-источник'), 'inflow');
  await user.click(builder.getByRole('button', { name: 'Сохранить как шаблон' }));
  fireEvent.change(builder.getByLabelText('Название шаблона'), {
    target: { value: 'Шаблон с притоком' },
  });
  await user.click(builder.getByRole('button', { name: 'Сохранить шаблон' }));
  await user.click(builder.getByRole('button', { name: 'Сохранить изменения' }));

  await user.selectOptions(screen.getByLabelText('Общежитие'), 'river');
  await user.click(screen.getByRole('button', { name: 'Шаблоны хостелов' }));
  await user.click(screen.getByRole('button', { name: 'Использовать шаблон «Шаблон с притоком»' }));
  const create = within(screen.getByRole('dialog', { name: 'Добавить хостел' }));
  fireEvent.change(create.getByLabelText('Название хостела'), {
    target: { value: 'Новый корпус' },
  });
  await user.click(create.getByRole('button', { name: 'Создать хостел' }));

  const newTable = within(screen.getByRole('table', { name: 'Размещение · Новый корпус' }));
  expect(newTable.getByLabelText('Оплачено мест М, 14 ноября')).toHaveValue('');
  const inflow = newTable.getByRole('rowheader', { name: 'Прибыло за день' }).closest('tr')!;
  expect(within(inflow).getAllByRole('cell').at(-1)).toHaveTextContent('0');
  const total = newTable.getByRole('rowheader', { name: 'Проживает Итого (М+Ж)' }).closest('tr')!;
  expect(within(total).getAllByRole('cell').at(-1)).toHaveTextContent('0');
});

it('показывает зависимую строку при удалении источника формулы', async () => {
  const user = userEvent.setup();
  render(<HostelBuilderPreview />);
  await user.click(screen.getByRole('button', { name: 'Настроить хостел' }));
  const builder = within(screen.getByRole('dialog', { name: 'Настроить хостел' }));
  await user.click(builder.getByRole('button', { name: 'Убрать строку' }));
  await user.click(builder.getByRole('button', { name: 'Сохранить изменения' }));
  expect(builder.getByRole('button', { name: /Проживает Итого/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(builder.getByText('Проверьте ссылки на строки в формуле.')).toBeInTheDocument();
});
