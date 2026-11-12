import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { WorkingTable } from '../../components/WorkingTable';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';
import { InlineBuilderCell } from './InlineBuilderCell';
import { newColumn, seedData } from './model';

function Example(): JSX.Element {
  const [values, setValues] = useState(['Исходное', '12']);
  return (
    <UnsavedChangesProvider>
      <WorkingTable pasteCells>
        <thead>
          <tr>
            <th>Текст</th>
            <th>Число</th>
          </tr>
        </thead>
        <tbody>
          <tr key="record">
            {values.map((value, index) => (
              <td key={index}>
                <InlineBuilderCell
                  column={{
                    ...newColumn(),
                    id: String(index),
                    name: index ? 'Число' : 'Текст',
                    kind: index ? 'number' : 'text',
                  }}
                  value={value}
                  label={index ? 'Число 1' : 'Текст 1'}
                  data={seedData()}
                  onCommit={(next) =>
                    setValues((current) =>
                      current.map((item, position) => (position === index ? String(next) : item)),
                    )
                  }
                >
                  {value}
                </InlineBuilderCell>
              </td>
            ))}
          </tr>
        </tbody>
      </WorkingTable>
      <output aria-label="Сохранённые значения">{values.join(';')}</output>
    </UnsavedChangesProvider>
  );
}

it('включает ввод в следующей ячейке по стрелке и сохраняет предыдущую без окна записи', async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole('button', { name: 'Редактировать Текст 1' }));
  await user.clear(screen.getByLabelText('Текст 1'));
  await user.type(screen.getByLabelText('Текст 1'), 'Новое');
  await user.keyboard('{ArrowRight}');
  await waitFor(() => expect(screen.getByLabelText('Число 1')).toHaveFocus());
  expect(screen.getByLabelText('Сохранённые значения')).toHaveTextContent('Новое;12');
  await user.clear(screen.getByLabelText('Число 1'));
  await user.type(screen.getByLabelText('Число 1'), '15,5');
  await user.keyboard('{ArrowLeft}');
  await waitFor(() => expect(screen.getByLabelText('Текст 1')).toHaveFocus());
  expect(screen.getByLabelText('Сохранённые значения')).toHaveTextContent('Новое;15.5');
});

it('Escape отменяет черновик, а некорректное число не попадает в данные', async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole('button', { name: 'Редактировать Число 1' }));
  await user.clear(screen.getByLabelText('Число 1'));
  await user.type(screen.getByLabelText('Число 1'), 'ошибка');
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByRole('alert')).toHaveTextContent('корректное число');
  expect(screen.getByLabelText('Сохранённые значения')).toHaveTextContent('Исходное;12');
  await user.type(screen.getByLabelText('Текст 1'), ' черновик');
  await user.keyboard('{Escape}');
  expect(screen.getByLabelText('Сохранённые значения')).toHaveTextContent('Исходное;12');
});

it('вставляет диапазон в ячейки конструктора и сохраняет обе правки', async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole('button', { name: 'Редактировать Текст 1' }));
  await user.paste('Скопировано\t12,5');
  expect(screen.getByLabelText('Сохранённые значения')).toHaveTextContent('Скопировано;12.5');
  expect(screen.getByText('Вставлено ячеек: 2.')).toBeInTheDocument();
});
