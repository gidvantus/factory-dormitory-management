import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInput, TableColumn } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import {
  ColumnsControls,
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';

afterEach(() => vi.unstubAllGlobals());
const existing: TableColumn = {
  id: 1,
  table_key: 'outflow',
  builtin_key: 'full_name',
  name: 'ФИО',
  kind: 'text',
  position: 0,
  options: [],
  archived: false,
};

function Harness({
  row,
}: {
  row: { id: number; custom_values: Record<string, CellValue> };
}): JSX.Element {
  return (
    <TableColumnsProvider dormitoryId="7" table="outflow">
      <ColumnsControls />
      <ConfiguredTable className="">
        <thead>
          <tr>
            <ConfiguredHeaders />
          </tr>
        </thead>
        <tbody>
          <tr>
            <ConfiguredCells fields={['full_name']} row={row}>
              <td>Иванов Иван</td>
            </ConfiguredCells>
          </tr>
        </tbody>
      </ConfiguredTable>
    </TableColumnsProvider>
  );
}

it('создаёт список, сохраняет выбор, переименовывает вариант и восстанавливает удалённый столбец с данными', async () => {
  let columns: TableColumn[] = [{ ...existing }];
  const row = { id: 8, custom_values: {} as Record<string, CellValue> };
  mockFetch((url, init) => {
    if (url.endsWith('/columns') && !init?.method) return { status: 200, body: columns };
    if (url.endsWith('/columns') && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as ColumnInput;
      const column: TableColumn = {
        ...input,
        id: 2,
        table_key: 'outflow',
        builtin_key: null,
        archived: false,
        position: 1,
        options: input.options.map((option, index) => ({ ...option, id: `option-${index}` })),
      };
      columns = [...columns, column];
      return { status: 201, body: column };
    }
    if (url.endsWith('/cells/2')) {
      const data = JSON.parse(String(init?.body)) as { value: CellValue };
      row.custom_values['2'] = data.value;
      return { status: 200, body: data };
    }
    if (url.endsWith('/columns/2') && init?.method === 'PATCH') {
      columns[1] = { ...columns[1], ...(JSON.parse(String(init.body)) as ColumnInput) };
      return { status: 200, body: columns[1] };
    }
    if (url.endsWith('/columns/2') && init?.method === 'DELETE') {
      columns = columns.map((col) => (col.id === 2 ? { ...col, archived: true } : col));
      return { status: 204 };
    }
    if (url.endsWith('/columns/2/restore')) {
      columns = columns.map((col) => (col.id === 2 ? { ...col, archived: false } : col));
      return { status: 200, body: columns[1] };
    }
    return { status: 404 };
  });
  const user = userEvent.setup();
  const view = render(<Harness row={row} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '+ Добавить столбец' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  await user.type(screen.getByLabelText('Название столбца'), 'Причина');
  await user.selectOptions(screen.getByLabelText('Тип столбца'), 'select');
  await user.type(screen.getByLabelText('Вариант 1'), 'Сбежал');
  await user.click(screen.getByRole('button', { name: '+ Вариант' }));
  await user.type(screen.getByLabelText('Вариант 2'), 'Уволился');
  await user.click(screen.getByRole('button', { name: 'Сохранить столбец' }));
  await user.selectOptions(await screen.findByLabelText('Причина, строка 8'), 'option-0');
  await waitFor(() => expect(row.custom_values['2']).toBe('option-0'));
  await user.click(screen.getByRole('button', { name: 'Настроить столбцы' }));
  await user.click(screen.getByRole('button', { name: 'Настроить столбец Причина' }));
  await user.clear(screen.getByLabelText('Вариант 1'));
  await user.type(screen.getByLabelText('Вариант 1'), 'Самовольно ушёл');
  await user.click(screen.getByRole('button', { name: 'Сохранить столбец' }));
  expect(await screen.findByRole('option', { name: 'Самовольно ушёл' })).toHaveValue('option-0');
  await user.click(screen.getByRole('button', { name: 'Настроить столбцы' }));
  await user.click(screen.getByRole('button', { name: 'Удалить столбец Причина' }));
  await user.click(screen.getByRole('button', { name: 'Подтвердить удаление столбец Причина' }));
  await waitFor(() => expect(screen.queryByLabelText('Причина, строка 8')).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: 'Восстановить столбец Причина' }));
  await waitFor(() => expect(screen.getByLabelText('Причина, строка 8')).toHaveValue('option-0'));
  view.unmount();
  render(<Harness row={row} />);
  expect(await screen.findByLabelText('Причина, строка 8')).toHaveValue('option-0');
});

it('показывает зависимость от отчета и оставляет используемый столбец', async () => {
  mockFetch((_url, init) =>
    init?.method === 'DELETE'
      ? {
          status: 409,
          body: {
            detail: 'Столбец используется в строках отчёта: Сбежал. Сначала измените их связь.',
          },
        }
      : { status: 200, body: [existing] },
  );
  const user = userEvent.setup();
  render(<Harness row={{ id: 8, custom_values: {} }} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Настроить столбцы' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'Настроить столбцы' }));
  await user.click(screen.getByRole('button', { name: 'Удалить столбец ФИО' }));
  await user.click(screen.getByRole('button', { name: 'Подтвердить удаление столбец ФИО' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Сначала измените их связь');
  expect(
    within(screen.getByRole('table')).getByRole('columnheader', { name: 'ФИО' }),
  ).toBeInTheDocument();
});
