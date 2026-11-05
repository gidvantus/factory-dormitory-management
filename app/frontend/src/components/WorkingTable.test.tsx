import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkingTable } from './WorkingTable';
import { emptyTableView } from './workingTableModel';

afterEach(() => vi.unstubAllGlobals());

function Example({ viewKey }: { viewKey?: string }): JSX.Element {
  return (
    <WorkingTable
      aria-label="Проверка"
      viewKey={viewKey}
      columns={[
        { id: 'name', label: 'Имя' },
        { id: 'value', label: 'Значение' },
      ]}
    >
      <thead>
        <tr>
          <th>Имя</th>
          <th>Значение</th>
        </tr>
      </thead>
      <tbody>
        <tr key="first">
          <td>
            <input aria-label="Имя 1" defaultValue="Иван" />
          </td>
          <td>
            <input aria-label="Значение 1" defaultValue="12" />
          </td>
        </tr>
        <tr key="second">
          <td>
            <input aria-label="Имя 2" defaultValue="Анна" />
          </td>
          <td>
            <input aria-label="Значение 2" defaultValue="34" />
          </td>
        </tr>
      </tbody>
    </WorkingTable>
  );
}

it('стрелки переводят фокус и вызывают сохранение по blur, Tab и модификаторы сохраняют своё поведение', async () => {
  const user = userEvent.setup();
  const blur = vi.fn();
  render(
    <WorkingTable>
      <thead>
        <tr>
          <th>Один</th>
          <th>Два</th>
          <th>Три</th>
        </tr>
      </thead>
      <tbody>
        <tr key="one">
          <td>
            <input aria-label="Начало" onBlur={blur} />
          </td>
          <td>
            <input aria-label="Расчёт" readOnly />
          </td>
          <td>
            <input aria-label="Справа" />
          </td>
        </tr>
        <tr key="two">
          <td>
            <input aria-label="Снизу" />
          </td>
          <td />
          <td>
            <select aria-label="Список">
              <option>Да</option>
              <option>Нет</option>
            </select>
          </td>
        </tr>
      </tbody>
    </WorkingTable>,
  );
  await user.click(screen.getByLabelText('Начало'));
  await user.type(screen.getByLabelText('Начало'), 'Запись');
  await user.keyboard('{ArrowRight}');
  expect(screen.getByLabelText('Справа')).toHaveFocus();
  expect(blur).toHaveBeenCalledTimes(1);
  await user.keyboard('{ArrowDown}');
  expect(screen.getByLabelText('Список')).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByLabelText('Снизу')).toHaveFocus();
  await user.keyboard('{ArrowUp}');
  expect(screen.getByLabelText('Начало')).toHaveFocus();
  expect(screen.getByLabelText('Начало')).toHaveValue('Запись');
  await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
  expect(screen.getByLabelText('Начало')).toHaveFocus();
});

it('переставляет столбцы с данными и строки без сброса введённого значения', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const input = screen.getByLabelText('Имя 1');
  await user.type(input, ' Петров');
  await user.click(screen.getByRole('button', { name: 'Столбец: Имя. Цвет и порядок' }));
  await user.click(screen.getByRole('button', { name: 'Правее' }));
  await user.click(screen.getByRole('button', { name: 'Закрыть окно' }));
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
    'Значение',
    'Имя',
  ]);
  expect(input).toBe(screen.getByLabelText('Имя 1'));
  expect(input).toHaveValue('Иван Петров');
  const first = within(screen.getByRole('table')).getAllByRole('row')[1];
  expect(first.querySelector('input')).toHaveAttribute('aria-label', 'Значение 1');
  await user.click(screen.getByRole('button', { name: 'Строка: 1. Цвет и порядок' }));
  await user.click(screen.getByRole('button', { name: 'Ниже' }));
  await user.click(screen.getByRole('button', { name: 'Закрыть окно' }));
  expect(
    within(screen.getByRole('table')).getAllByRole('row')[1].querySelector('input'),
  ).toHaveAttribute('aria-label', 'Значение 2');
  expect(input).toBe(screen.getByLabelText('Имя 1'));
});

it('сохраняет цвет на сервере и восстанавливает его после открытия таблицы', async () => {
  const user = userEvent.setup();
  let document = emptyTableView();
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const input = JSON.parse(String(init.body));
      document = { revision: input.revision + 1, state: input.state };
    }
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const mounted = render(<Example viewKey="personnel/table-views/example" />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Столбец: Имя. Цвет и порядок' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'Столбец: Имя. Цвет и порядок' }));
  expect(
    within(screen.getByRole('group', { name: 'Цвет выделения' })).getAllByRole('button'),
  ).toHaveLength(10);
  await user.click(screen.getByRole('button', { name: 'Мятный' }));
  await waitFor(() => expect(document.state.column_colors.name).toBe('mint'));
  mounted.unmount();
  render(<Example viewKey="personnel/table-views/example" />);
  await waitFor(() =>
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('data-table-color', 'mint'),
  );
  await user.click(screen.getByRole('button', { name: 'Столбец: Имя. Цвет и порядок' }));
  await user.click(screen.getByRole('button', { name: 'Сбросить цвет' }));
  await waitFor(() => expect(document.state.column_colors).toEqual({}));
});

it('перетаскивание заголовка меняет порядок всей колонки', async () => {
  render(<Example />);
  const dataTransfer = { effectAllowed: '', setData: vi.fn() };
  fireEvent.dragStart(screen.getByRole('button', { name: 'Столбец: Имя. Цвет и порядок' }), {
    dataTransfer,
  });
  fireEvent.drop(screen.getAllByRole('columnheader')[1], { dataTransfer });
  await waitFor(() =>
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Значение',
      'Имя',
    ]),
  );
  expect(
    within(screen.getByRole('table')).getAllByRole('row')[1].querySelector('input'),
  ).toHaveValue('12');
});
