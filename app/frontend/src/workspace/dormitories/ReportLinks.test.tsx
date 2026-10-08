import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReportLink, ReportRow, TableColumn } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { ReportTable } from './ReportTable';

afterEach(() => vi.unstubAllGlobals());

const columns: TableColumn[] = [
  {
    id: 12,
    table_key: 'outflow',
    builtin_key: null,
    name: 'Причина',
    kind: 'select',
    position: 0,
    archived: false,
    options: [
      { id: 'escaped', label: 'Сбежал', archived: false },
      { id: 'quit', label: 'Уволился', archived: false },
    ],
  },
  {
    id: 13,
    table_key: 'outflow',
    builtin_key: 'departure_date',
    name: 'Дата выезда',
    kind: 'date',
    position: 1,
    archived: false,
    options: [],
  },
];

it('создаёт связь через раздел и подвкладку, показывает подсчёт и запрещает ручной ввод', async () => {
  let rows: ReportRow[] = [];
  let submitted: ReportLink | null = null;
  mockFetch((url, init) => {
    if (url.includes('/report?')) return { status: 200, body: { rows } };
    if (url.endsWith('/tables/outflow/columns')) return { status: 200, body: columns };
    if (url.endsWith('/report/rows') && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as {
        name: string;
        formula: null;
        link: ReportLink;
      };
      submitted = input.link;
      const row = {
        ...input,
        id: 5,
        position: 4,
        values: { '2026-10-08': '3', '2026-10-09': '0' },
        errors: {},
      };
      rows = [row];
      return { status: 201, body: row };
    }
    return { status: 404 };
  });
  const user = userEvent.setup();
  render(<ReportTable dormitoryId="7" range={{ from: '2026-10-08', to: '2026-10-09' }} />);
  await user.click(screen.getByRole('button', { name: '+ Добавить строку' }));
  await user.type(screen.getByLabelText('Название строки'), 'Сбежал');
  await user.click(screen.getByRole('radio', { name: 'Связь с таблицей' }));
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Выберите таблицу');
  await user.selectOptions(screen.getByLabelText('Раздел'), 'movement');
  await user.selectOptions(screen.getByLabelText('Подвкладка'), 'outflow');
  await user.selectOptions(await screen.findByLabelText('Столбец'), '12');
  await user.selectOptions(screen.getByLabelText('Значение для подсчёта'), 'escaped');
  expect(screen.getByLabelText('Распределять по дате')).toHaveValue('');
  await user.selectOptions(screen.getByLabelText('Распределять по дате'), '13');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(submitted).toEqual({
      table_key: 'outflow',
      column_id: 12,
      operator: 'equals',
      value: 'escaped',
      date_column_id: 13,
    }),
  );
  expect(await screen.findByText('3', { selector: 'output' })).toBeInTheDocument();
  expect(screen.getByText('0', { selector: 'output' })).toBeInTheDocument();
  expect(screen.queryByTestId('report-cell-5-2026-10-08')).not.toBeInTheDocument();
});

it('по умолчанию считает любую заполненную дату и распределяет по выбранному столбцу', async () => {
  let submitted: ReportLink | null = null;
  let rows: ReportRow[] = [];
  const arrival: TableColumn = {
    ...columns[1],
    id: 21,
    table_key: 'inflow',
    name: 'Дата приезда',
    builtin_key: null,
  };
  mockFetch((url, init) => {
    if (url.includes('/report?')) return { status: 200, body: { rows } };
    if (url.endsWith('/tables/inflow/columns')) return { status: 200, body: [arrival] };
    if (url.endsWith('/report/rows') && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as {
        name: string;
        formula: null;
        link: ReportLink;
      };
      submitted = input.link;
      const row = {
        ...input,
        id: 6,
        position: 4,
        values: { '2026-10-08': '2', '2026-10-09': '1' },
        errors: {},
      };
      rows = [row];
      return { status: 201, body: row };
    }
    return { status: 404 };
  });
  const user = userEvent.setup();
  render(<ReportTable dormitoryId="7" range={{ from: '2026-10-08', to: '2026-10-09' }} />);
  await user.click(screen.getByRole('button', { name: '+ Добавить строку' }));
  await user.type(screen.getByLabelText('Название строки'), 'Приехал');
  await user.click(screen.getByRole('radio', { name: 'Связь с таблицей' }));
  await user.selectOptions(screen.getByLabelText('Раздел'), 'movement');
  await user.selectOptions(screen.getByLabelText('Подвкладка'), 'inflow');
  await user.selectOptions(await screen.findByLabelText('Столбец'), '21');
  expect(screen.getByLabelText('Условие подсчёта')).toHaveValue('not_empty');
  expect(screen.getByLabelText('Распределять по дате')).toHaveValue('21');
  expect(screen.queryByLabelText('Значение для подсчёта')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(submitted).toEqual({
      table_key: 'inflow',
      column_id: 21,
      operator: 'not_empty',
      value: null,
      date_column_id: 21,
    }),
  );
  expect(await screen.findByText('2', { selector: 'output' })).toBeInTheDocument();
  expect(screen.getByText('1', { selector: 'output' })).toBeInTheDocument();
});

it('позволяет изменить старый фильтр конкретной даты на подсчет всех приездов', async () => {
  const arrival: TableColumn = {
    ...columns[1],
    id: 21,
    table_key: 'inflow',
    name: 'Дата приезда',
    builtin_key: null,
  };
  let rows: ReportRow[] = [
    {
      id: 6,
      name: 'Приехал',
      formula: null,
      position: 4,
      link: { table_key: 'inflow', column_id: 21, value: '2026-10-08', date_column_id: null },
      values: {},
      errors: {},
    },
  ];
  let submitted: ReportLink | null = null;
  mockFetch((url, init) => {
    if (url.includes('/report?')) return { status: 200, body: { rows } };
    if (url.endsWith('/tables/inflow/columns')) return { status: 200, body: [arrival] };
    if (url.endsWith('/report/rows/6') && init?.method === 'PATCH') {
      const input = JSON.parse(String(init.body)) as { link: ReportLink };
      submitted = input.link;
      rows = [{ ...rows[0], link: input.link }];
      return { status: 200, body: rows[0] };
    }
    return { status: 404 };
  });
  const user = userEvent.setup();
  render(<ReportTable dormitoryId="7" range={{ from: '2026-10-08', to: '2026-10-09' }} />);
  await user.click(await screen.findByRole('button', { name: 'Настроить строку Приехал' }));
  expect(await screen.findByLabelText('Условие подсчёта')).toHaveValue('equals');
  expect(screen.getByLabelText('Значение для подсчёта')).toHaveValue('2026-10-08');
  await user.selectOptions(screen.getByLabelText('Условие подсчёта'), 'not_empty');
  expect(screen.getByLabelText('Распределять по дате')).toHaveValue('21');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(submitted).toEqual({
      table_key: 'inflow',
      column_id: 21,
      operator: 'not_empty',
      value: null,
      date_column_id: 21,
    }),
  );
});

it('отличает ошибку связи от нулевого количества', async () => {
  mockFetch(() => ({
    status: 200,
    body: {
      rows: [
        {
          id: 5,
          name: 'Сбежал',
          position: 4,
          formula: null,
          link: { table_key: 'outflow', column_id: 12, value: 'escaped', date_column_id: null },
          values: {},
          errors: { '2026-10-08': 'Проверьте связь: столбец удалён' },
        },
      ],
    },
  }));
  render(<ReportTable dormitoryId="7" range={{ from: '2026-10-08', to: '2026-10-08' }} />);
  expect(await screen.findByText('Проверьте связь', { selector: 'output' })).toHaveAttribute(
    'title',
    'Проверьте связь: столбец удалён',
  );
  expect(screen.queryByText('0', { selector: 'output' })).not.toBeInTheDocument();
});
