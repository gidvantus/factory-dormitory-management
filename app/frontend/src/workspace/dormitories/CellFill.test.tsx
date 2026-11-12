import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import type {
  CellFillConfig,
  CellFillSource,
  CustomTab,
  CustomTabRow,
  TableColumn,
} from '../../api/client';
import { personnelApi } from '../../api/personnel';
import { CreateTableDialog } from './CreateTableDialog';
import { ConfiguredCells, ConfiguredHeaders, TableColumnsProvider } from './ConfigurableColumns';

const tab: CustomTab = {
  id: 9,
  dormitory_id: 7,
  name: 'Отпуск',
  table_key: 'custom_9',
  table_created: false,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
};
const source: CellFillSource = {
  key: 'residents',
  name: 'Проживающие',
  fields: [
    { id: '10', name: 'ФИО', kind: 'text' },
    { id: '11', name: 'Дата заселения', kind: 'date' },
  ],
};
const pick: CellFillConfig = {
  mode: 'pick',
  source: 'residents',
  field: '10',
  match_column_id: null,
  update: 'live',
};
const columns: TableColumn[] = [
  {
    id: 101,
    table_key: 'custom_9',
    builtin_key: null,
    name: 'ФИО',
    kind: 'text',
    options: [],
    archived: false,
    position: 0,
    fill: pick,
  },
  {
    id: 102,
    table_key: 'custom_9',
    builtin_key: null,
    name: 'Дата заселения',
    kind: 'date',
    options: [],
    archived: false,
    position: 1,
    fill: { ...pick, mode: 'lookup', field: '11', match_column_id: 101 },
  },
  {
    id: 103,
    table_key: 'custom_9',
    builtin_key: null,
    name: 'Комментарий',
    kind: 'text',
    options: [],
    archived: false,
    position: 2,
  },
];
const row: CustomTabRow = {
  id: 20,
  custom_values: { '103': 'Прежний текст' },
  fill_values: { '101': 'Иванов', '102': '2026-10-01' },
  fill_selections: { '101': { source: 'residents', record_id: '1' } },
};
beforeEach(() => {
  vi.spyOn(api, 'cellFillSources').mockResolvedValue([source]);
  vi.spyOn(api, 'tableColumns').mockResolvedValue(columns);
  vi.spyOn(personnelApi, 'binding').mockResolvedValue({ fields: {}, columns: [] });
});
afterEach(() => vi.restoreAllMocks());

function Table(): JSX.Element {
  return (
    <TableColumnsProvider dormitoryId="7" table="custom_9">
      <table>
        <thead>
          <tr>
            <ConfiguredHeaders />
          </tr>
        </thead>
        <tbody>
          <tr>
            <ConfiguredCells fields={[]} row={row}>
              {null}
            </ConfiguredCells>
          </tr>
        </tbody>
      </table>
    </TableColumnsProvider>
  );
}

describe('Заполнение ячеек в рабочих компонентах', () => {
  it('создаёт выбор записи и связанный столбец одним запросом с временным ID', async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, 'createCustomTabTable')
      .mockResolvedValue({ ...tab, table_created: true });
    render(<CreateTableDialog dormitoryId="7" tab={tab} onClose={vi.fn()} onCreated={vi.fn()} />);
    const first = within(screen.getByRole('group', { name: 'Столбец 1' }));
    await user.type(first.getByLabelText('Название столбца'), 'ФИО');
    await waitFor(() => expect(first.getByRole('button', { name: 'Выбор записи' })).toBeEnabled());
    await user.click(first.getByRole('button', { name: 'Выбор записи' }));
    await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
    const second = within(screen.getByRole('group', { name: 'Столбец 2' }));
    await user.type(second.getByLabelText('Название столбца'), 'Дата заселения');
    await user.selectOptions(second.getByLabelText('Тип столбца'), 'date');
    await user.click(second.getByRole('button', { name: 'Из другой таблицы' }));
    expect(second.getByLabelText('Запись выбрать в столбце')).toHaveValue('-1');
    await user.selectOptions(second.getByLabelText('Если данные в источнике изменятся'), 'copy');
    await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const payload = create.mock.calls[0][2];
    expect(payload[0]).toMatchObject({ client_id: -1, fill: { mode: 'pick', field: '10' } });
    expect(payload[1]).toMatchObject({
      fill: { mode: 'lookup', field: '11', match_column_id: -1, update: 'copy' },
    });
  });

  it('не применяет связь после удаления её столбца выбора из черновика', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, 'createCustomTabTable');
    render(<CreateTableDialog dormitoryId="7" tab={tab} onClose={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText('Название столбца'), 'ФИО');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Выбор записи' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Выбор записи' }));
    await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
    const second = within(screen.getByRole('group', { name: 'Столбец 2' }));
    await user.type(second.getByLabelText('Название столбца'), 'Заселение');
    await user.selectOptions(second.getByLabelText('Тип столбца'), 'date');
    await user.click(second.getByRole('button', { name: 'Из другой таблицы' }));
    await user.click(screen.getByRole('button', { name: 'Удалить столбец 1' }));
    expect(second.getByLabelText('Запись выбрать в столбце')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
    expect(create).not.toHaveBeenCalled();
  });

  it('повторяет неудачный выбор и обновляет связанные ячейки, сохраняя ручной черновик', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'cellFillRecords').mockResolvedValue({
      records: [{ id: '2', label: 'Другой Иванов', detail: 'Запись №2' }],
      has_more: false,
    });
    const select = vi
      .spyOn(api, 'selectCellRecord')
      .mockRejectedValueOnce(new ApiError(409, 'Повторите выбор'))
      .mockResolvedValue({
        ...row,
        fill_selections: { '101': { source: 'residents', record_id: '2' } },
        fill_values: { '101': 'Другой Иванов', '102': '2026-10-02' },
      });
    render(<Table />);
    const manual = await screen.findByLabelText('Комментарий, строка 20');
    await user.type(manual, ' черновик');
    // Сохранение ручной ячейки и выбор записи проходят независимо.
    vi.spyOn(api, 'saveCustomCell').mockResolvedValue({ value: 'Прежний текст черновик' });
    await user.click(screen.getByRole('button', { name: 'Выбрать запись: ФИО, строка 20' }));
    await user.click(await screen.findByRole('button', { name: 'Другой Иванов Запись №2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Повторите выбор');
    await user.click(screen.getByRole('button', { name: 'Другой Иванов Запись №2' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(select).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Дата заселения, строка 20')).toHaveTextContent('02.10.2026');
    expect(manual).toHaveValue('Прежний текст черновик');
  });

  it('открывает выбор вне таблицы и возвращает фокус без изменения записи при отмене', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'cellFillRecords').mockResolvedValue({ records: [], has_more: false });
    const select = vi.spyOn(api, 'selectCellRecord');
    render(<Table />);
    const trigger = await screen.findByRole('button', {
      name: 'Выбрать запись: ФИО, строка 20',
    });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Выбрать запись: ФИО' });
    expect(dialog.closest('table')).toBeNull();
    expect(within(dialog).getByRole('searchbox')).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent('Иванов');
  });

  it('обновляет только связанные значения при возвращении в окно', async () => {
    const user = userEvent.setup();
    const refresh = vi
      .spyOn(api, 'cellFillValues')
      .mockResolvedValue([{ ...row, fill_values: { '101': 'Иванов', '102': '2026-10-07' } }]);
    render(<Table />);
    const manual = await screen.findByLabelText('Комментарий, строка 20');
    await user.type(manual, ' черновик');
    fireEvent(window, new Event('focus'));
    await waitFor(() =>
      expect(screen.getByLabelText('Дата заселения, строка 20')).toHaveTextContent('07.10.2026'),
    );
    expect(manual).toHaveValue('Прежний текст черновик');
    expect(refresh).toHaveBeenCalledWith('7', 'custom_9', expect.any(AbortSignal), undefined);
  });
});
