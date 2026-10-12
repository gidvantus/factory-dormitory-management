import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CustomTab, ReportLink, TableColumn } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { ReportLinkEditor } from './ReportLinkEditor';
import { ReportTable } from './ReportTable';

afterEach(() => vi.unstubAllGlobals());
const tabs: CustomTab[] = [
  {
    id: 8,
    dormitory_id: 7,
    name: 'Документы',
    table_key: 'custom_8',
    table_created: true,
    is_active: true,
    has_data: false,
    delete_block_reason: null,
  },
  {
    id: 9,
    dormitory_id: 7,
    name: 'Будущая вкладка',
    table_key: 'custom_9',
    table_created: false,
    is_active: true,
    has_data: false,
    delete_block_reason: null,
  },
];
const columns: TableColumn[] = [
  {
    id: 31,
    table_key: 'custom_8',
    name: 'Статус',
    kind: 'select',
    builtin_key: null,
    position: 0,
    archived: false,
    options: [{ id: 'ready', label: 'Готов', archived: false }],
  },
  {
    id: 32,
    table_key: 'custom_8',
    name: 'Дата события',
    kind: 'date',
    builtin_key: null,
    position: 1,
    archived: false,
    options: [],
  },
];
function Editor({ initial = null }: { initial?: ReportLink | null }): JSX.Element {
  const [link, setLink] = useState<ReportLink | null>(initial);
  return (
    <>
      <ReportLinkEditor dormitoryId="7" initial={initial} onChange={setLink} disabled={false} />
      <output data-testid="draft">{JSON.stringify(link)}</output>
    </>
  );
}
function draft(): unknown {
  return JSON.parse(screen.getByTestId('draft').textContent ?? 'null');
}

it('создаёт строку отчёта со связью на свою вкладку и отдельную дату', async () => {
  let submitted: unknown;
  mockFetch((url, init) => {
    if (url.endsWith('/tabs')) return { status: 200, body: tabs };
    if (url.includes('/report?')) return { status: 200, body: { rows: [] } };
    if (url.endsWith('/tables/custom_8/columns')) return { status: 200, body: columns };
    if (url.endsWith('/report/rows')) {
      submitted = JSON.parse(String(init?.body));
      return { status: 201, body: { id: 11 } };
    }
    return { status: 404 };
  });
  const user = userEvent.setup();
  render(<ReportTable dormitoryId="7" range={{ from: '2026-10-08', to: '2026-10-09' }} />);
  await user.click(screen.getByRole('button', { name: '+ Добавить строку' }));
  await user.type(screen.getByLabelText('Название строки'), 'Готовые документы');
  await user.click(screen.getByRole('radio', { name: 'Связь с таблицей' }));
  expect(await screen.findByRole('option', { name: 'Документы' })).toBeInTheDocument();
  for (const name of ['Проживающие', 'Движение персонала', 'Выплаты', 'Архив', 'Места']) {
    expect(within(screen.getByLabelText('Раздел')).getByRole('option', { name })).toBeEnabled();
  }
  expect(
    screen.getByRole('option', { name: 'Большой отчёт — связь через формулу' }),
  ).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Раздел'), 'custom_9');
  expect(
    screen.getByText('Сначала создайте таблицу во вкладке «Будущая вкладка».'),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText('Столбец')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Раздел'), 'custom_8');
  await user.selectOptions(await screen.findByLabelText('Столбец'), '31');
  await user.selectOptions(screen.getByLabelText('Значение для подсчёта'), 'ready');
  await user.selectOptions(screen.getByLabelText('Распределять по дате'), '32');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(submitted).toEqual({
      name: 'Готовые документы',
      formula: null,
      link: {
        table_key: 'custom_8',
        column_id: 31,
        operator: 'equals',
        value: 'ready',
        date_column_id: 32,
      },
    }),
  );
});

it('восстанавливает источник при редактировании и сбрасывает связь при смене раздела', async () => {
  mockFetch((url) => {
    if (url.endsWith('/tabs')) return { status: 200, body: tabs };
    if (url.endsWith('/columns')) return { status: 200, body: columns };
    return { status: 404 };
  });
  const initial: ReportLink = {
    table_key: 'custom_8',
    column_id: 32,
    operator: 'not_empty',
    value: null,
    date_column_id: 32,
  };
  render(<Editor initial={initial} />);
  const user = userEvent.setup();
  expect(await screen.findByRole('option', { name: 'Документы' })).toBeInTheDocument();
  expect(screen.getByLabelText('Раздел')).toHaveValue('custom_8');
  expect(await screen.findByLabelText('Условие подсчёта')).toHaveValue('not_empty');
  expect(screen.getByLabelText('Распределять по дате')).toHaveValue('32');
  expect(draft()).toEqual(initial);
  await user.selectOptions(screen.getByLabelText('Раздел'), 'movement');
  expect(draft()).toBeNull();
  expect(screen.getByLabelText('Подвкладка')).toHaveValue('');
});

it('повторяет загрузку пользовательских вкладок и оставляет встроенные источники доступными', async () => {
  let attempts = 0;
  mockFetch((url) => {
    if (url.endsWith('/tabs'))
      return ++attempts === 1
        ? { status: 503, body: { detail: 'Ошибка вкладок' } }
        : { status: 200, body: tabs };
    if (url.endsWith('/columns')) return { status: 200, body: [] };
    return { status: 404 };
  });
  render(<Editor />);
  const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка вкладок');
  await user.selectOptions(screen.getByLabelText('Раздел'), 'residents');
  expect(await screen.findByLabelText('Столбец')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Повторить загрузку вкладок' }));
  expect(await screen.findByRole('option', { name: 'Документы' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('выбирает показатель мест по всем хостелам или одному, затем очищает его при смене источника', async () => {
  mockFetch((url) => {
    if (url.endsWith('/tabs')) return { status: 200, body: [] };
    if (url.endsWith('/hostels/sources'))
      return {
        status: 200,
        body: [
          { id: 15, name: 'Корпус 1' },
          { id: 16, name: 'Корпус 2' },
        ],
      };
    return { status: 404 };
  });
  render(<Editor />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Раздел'), 'places');
  expect(await screen.findByLabelText('Хостел')).toHaveValue('all');
  expect(draft()).toBeNull();
  expect(screen.queryByLabelText('Значение для подсчёта')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Распределять по дате')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Показатель'), 'free_total');
  expect(draft()).toEqual({ table_key: 'places', hostel_id: null, metric: 'free_total' });
  await user.selectOptions(screen.getByLabelText('Хостел'), '15');
  expect(draft()).toEqual({ table_key: 'places', hostel_id: 15, metric: 'free_total' });
  await user.selectOptions(screen.getByLabelText('Показатель'), 'residents_f');
  expect(draft()).toEqual({ table_key: 'places', hostel_id: 15, metric: 'residents_f' });
  await user.selectOptions(screen.getByLabelText('Раздел'), 'payments');
  expect(draft()).toBeNull();
  expect(screen.queryByLabelText('Показатель')).not.toBeInTheDocument();
});

it('редактирует связь с местами и повторяет загрузку хостелов после ошибки', async () => {
  let attempts = 0;
  mockFetch((url) => {
    if (url.endsWith('/tabs')) return { status: 200, body: [] };
    if (url.endsWith('/hostels/sources'))
      return ++attempts === 1
        ? { status: 503, body: { detail: 'Ошибка хостелов' } }
        : { status: 200, body: [{ id: 15, name: 'Корпус' }] };
    return { status: 404 };
  });
  render(<Editor initial={{ table_key: 'places', hostel_id: 15, metric: 'paid_m' }} />);
  const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка хостелов');
  expect(draft()).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Повторить загрузку хостелов' }));
  expect(await screen.findByLabelText('Хостел')).toHaveValue('15');
  expect(screen.getByLabelText('Показатель')).toHaveValue('paid_m');
  expect(draft()).toEqual({ table_key: 'places', hostel_id: 15, metric: 'paid_m' });
  await user.selectOptions(screen.getByLabelText('Показатель'), 'paid_total');
  expect(draft()).toEqual({ table_key: 'places', hostel_id: 15, metric: 'paid_total' });
});
