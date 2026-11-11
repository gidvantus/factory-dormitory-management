import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkingTable } from './WorkingTable';
import { emptyTableView } from './workingTableModel';

afterEach(() => vi.unstubAllGlobals());

it('Ctrl с колёсиком масштабирует выбранную таблицу и восстанавливает её масштаб', async () => {
  const saved = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/zoom')) return Response.json(emptyTableView());
      if (init?.method === 'PUT') saved.set(url, JSON.parse(String(init.body)).percent);
      return Response.json({ percent: saved.get(url) ?? 100 });
    }),
  );
  function Tables(): JSX.Element {
    return (
      <>
        <WorkingTable viewKey="dormitories/7/table-views/report" aria-label="Отчёт">
          <tbody>
            <tr>
              <td>Данные отчёта</td>
            </tr>
          </tbody>
        </WorkingTable>
        <WorkingTable viewKey="dormitories/7/table-views/residents" aria-label="Жильцы">
          <tbody>
            <tr>
              <td>Данные жильцов</td>
            </tr>
          </tbody>
        </WorkingTable>
      </>
    );
  }
  const { unmount } = render(<Tables />);
  const target = screen.getByText('Данные отчёта');
  const scroll = createEvent.wheel(target, { deltaY: -100, cancelable: true });
  fireEvent(target, scroll);
  expect(scroll.defaultPrevented).toBe(false);
  const zoom = createEvent.wheel(target, { ctrlKey: true, deltaY: -100, cancelable: true });
  fireEvent(target, zoom);
  expect(zoom.defaultPrevented).toBe(true);
  expect(screen.getByRole('table', { name: 'Отчёт' }).style.zoom).toBe('1.1');
  expect(screen.getByRole('table', { name: 'Жильцы' }).style.zoom).not.toBe('1.1');
  unmount();
  render(<Tables />);
  await waitFor(() =>
    expect(screen.getByRole('table', { name: 'Отчёт' }).style.zoom).toBe('1.1'),
  );
  expect([...saved.values()]).toEqual([110]);
});

it('распознаёт даты и списки Excel, сохраняет многострочный текст и пустые ячейки', async () => {
  const user = userEvent.setup();
  function Table(): JSX.Element {
    const [date, setDate] = useState('');
    const [status, setStatus] = useState('');
    const [notes, setNotes] = useState('');
    const [count, setCount] = useState('3');
    return (
      <WorkingTable pasteCells>
        <thead>
          <tr>
            <th>Дата</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          <tr key="top">
            <td>
              <input
                type="date"
                aria-label="Дата"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </td>
            <td>
              <select
                aria-label="Статус"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">—</option>
                <option value="ready">Готово</option>
              </select>
            </td>
          </tr>
          <tr key="bottom">
            <td>
              <textarea
                aria-label="Заметка"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </td>
            <td>
              <input
                type="number"
                aria-label="Число"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </td>
          </tr>
        </tbody>
      </WorkingTable>
    );
  }
  render(<Table />);
  await user.click(screen.getByLabelText('Дата'));
  await user.paste('11.11.2026\tГотово\r\n"Первая строка\r\nВторая ""строка"""\t\r\n');
  expect(screen.getByLabelText('Дата')).toHaveValue('2026-11-11');
  expect(screen.getByLabelText('Статус')).toHaveValue('ready');
  expect(screen.getByLabelText('Заметка')).toHaveValue('Первая строка\nВторая "строка"');
  expect(screen.getByLabelText('Число')).toHaveValue(null);
});

it('сортирует текст по заголовку в обе стороны, не сбрасывая черновики и не вызывая настройку цвета', async () => {
  const user = userEvent.setup();
  render(<Example />);
  const input = screen.getByLabelText('Имя 1');
  await user.type(input, ' Петров');
  const heading = screen.getByRole('columnheader', { name: 'Имя' });
  await user.click(heading);
  const names = (): (string | null)[] =>
    within(screen.getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('input')?.getAttribute('aria-label') ?? null);
  expect(names()).toEqual(['Имя 2', 'Имя 1']);
  expect(heading).toHaveAttribute('aria-sort', 'ascending');
  expect(input).toBe(screen.getByLabelText('Имя 1'));
  expect(input).toHaveValue('Иван Петров');
  heading.focus();
  await user.keyboard('{Enter}');
  expect(names()).toEqual(['Имя 1', 'Имя 2']);
  expect(heading).toHaveAttribute('aria-sort', 'descending');
  await user.click(screen.getByRole('button', { name: 'Столбец: Имя. Цвет и порядок' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(names()).toEqual(['Имя 1', 'Имя 2']);
});

it('сравнивает числа со знаком и десятичной запятой, оставляет пустые ячейки и итог на месте', async () => {
  const user = userEvent.setup();
  render(
    <WorkingTable columns={[{ id: 'number', label: 'Число', kind: 'number' }]}>
      <thead>
        <tr>
          <th>Число</th>
        </tr>
      </thead>
      <tbody>
        {['10', '', '-2', '1,5', '1,15'].map((value, index) => (
          <tr key={index}>
            <td>{value}</td>
          </tr>
        ))}
        <tr data-fixed-row>
          <td>Итого</td>
        </tr>
      </tbody>
    </WorkingTable>,
  );
  const values = (): string[] =>
    within(screen.getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');
  await user.click(screen.getByRole('columnheader', { name: 'Число' }));
  expect(values()).toEqual(['-2', '1,15', '1,5', '10', '', 'Итого']);
  await user.click(screen.getByRole('columnheader', { name: 'Число' }));
  expect(values()).toEqual(['10', '1,5', '1,15', '-2', '', 'Итого']);
});

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
