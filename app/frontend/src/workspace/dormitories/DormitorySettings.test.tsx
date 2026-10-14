import { createRef } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import type { DormitorySettings, StructureTemplateDetail, TableColumn } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { defaultTabCatalog } from '../../test/tableColumns';
import { DormitorySettingsDialog } from './DormitorySettingsDialog';
import { CreateDormitoryDialog } from './CreateDormitoryDialog';
import {
  ConfiguredCells,
  ConfiguredHeaders,
  ConfiguredTable,
  TableColumnsProvider,
} from './ConfigurableColumns';
import { SettingsContext } from './settingsContext';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function snapshot(): DormitorySettings {
  return {
    revision: 'a'.repeat(64),
    sections: [
      {
        key: 'residents',
        name: 'Проживающие',
        parent_key: null,
        status: 'active',
        has_data: true,
        delete_block_reason: 'Во вкладке есть данные за всё время.',
      },
    ],
    tabs: [],
    rules: [],
    tables: {
      residents: [
        {
          id: 10,
          table_key: 'residents',
          builtin_key: 'full_name',
          name: 'ФИО',
          kind: 'text',
          position: 0,
          options: [],
          archived: false,
          used_by: ['Проживает'],
        },
      ],
    },
  };
}

it('собирает несколько столбцов и порядок в один запрос, показывает зависимости до удаления', async () => {
  const data = snapshot();
  vi.spyOn(api, 'dormitorySettings').mockResolvedValue(data);
  const save = vi
    .spyOn(api, 'saveDormitorySettings')
    .mockResolvedValue({ ...data, revision: 'b'.repeat(64) });
  const changed = vi.fn();
  render(
    <DormitorySettingsDialog
      dormitoryId="7"
      onClose={vi.fn()}
      onChanged={changed}
      onOpen={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await screen.findByLabelText('Название столбца 1');
  expect(screen.getByRole('button', { name: 'Удалить пустую вкладку' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Убрать' })).toBeDisabled();
  expect(screen.getByText(/Используется в отчёте: Проживает/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  await user.type(screen.getByLabelText('Название столбца 2'), 'Причина');
  await user.selectOptions(screen.getByLabelText('Формат столбца 2'), 'select');
  await user.type(screen.getByLabelText('Вариант 1 столбца 2'), 'Сбежал');
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  await user.type(screen.getByLabelText('Название столбца 3'), 'Дата');
  await user.selectOptions(screen.getByLabelText('Формат столбца 3'), 'date');
  await user.click(screen.getByRole('button', { name: 'Выше: Дата' }));
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(save).toHaveBeenCalledTimes(1);
  expect(
    save.mock.calls[0][1].tables[0].columns.map((column) => [column.name, column.kind]),
  ).toEqual([
    ['ФИО', 'text'],
    ['Дата', 'date'],
    ['Причина', 'select'],
  ]);
  expect(save.mock.calls[0][1].tables[0].columns[2].options[0].label).toBe('Сбежал');
});

it('не теряет черновик при конфликте и требует явного отказа от несохранённых изменений', async () => {
  vi.spyOn(api, 'dormitorySettings').mockResolvedValue(snapshot());
  vi.spyOn(api, 'saveDormitorySettings').mockRejectedValue(
    new ApiError(409, 'Структуру изменили в другом окне.'),
  );
  const close = vi.fn();
  render(
    <DormitorySettingsDialog
      dormitoryId="7"
      onClose={close}
      onChanged={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.clear(await screen.findByLabelText('Название столбца 1'));
  await user.type(screen.getByLabelText('Название столбца 1'), 'Сотрудник');
  await user.click(screen.getByRole('button', { name: 'Сохранить изменения' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('другом окне');
  expect(screen.getByLabelText('Название столбца 1')).toHaveValue('Сотрудник');
  await user.click(screen.getByRole('button', { name: 'Обновить настройки' }));
  expect(screen.getByText(/При обновлении несохранённые изменения/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Продолжить настройку' }));
  await user.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Закрыть без сохранения' }));
  expect(close).toHaveBeenCalledTimes(1);
});

it('объясняет подсчёт по датам и сохраняет отдельный шаблон всей структуры', async () => {
  const data = snapshot();
  data.rules = [
    {
      id: 1,
      name: 'Заселились',
      formula: null,
      link: {
        table_key: 'residents',
        column_id: 10,
        value: null,
        operator: 'not_empty',
        date_column_id: null,
      },
    },
  ];
  vi.spyOn(api, 'dormitorySettings').mockResolvedValue(data);
  vi.spyOn(api, 'structureTemplates').mockResolvedValue([]);
  const save = vi.spyOn(api, 'saveStructureTemplate').mockResolvedValue({
    id: 20,
    name: 'Основная структура',
    created_at: '2026-10-09T12:00:00Z',
    tab_count: 1,
  });
  const open = vi.fn();
  render(
    <DormitorySettingsDialog
      dormitoryId="7"
      initialPage="links"
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onOpen={open}
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByText(/Группировать по дате создания записи/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'К источнику ↗' }));
  expect(open).toHaveBeenCalledWith('residents');
  await user.click(screen.getByRole('tab', { name: 'Шаблоны' }));
  await user.type(screen.getByLabelText('Название нового шаблона'), 'Основная структура');
  await user.click(screen.getByRole('button', { name: 'Сохранить структуру' }));
  expect(await screen.findByText('Независимый шаблон сохранён')).toBeInTheDocument();
  expect(save).toHaveBeenCalledWith('7', 'Основная структура');
});

it('собирает действия строки в одну ячейку и оставляет сообщение видимым после сворачивания', async () => {
  const cols: TableColumn[] = [
    {
      id: 4,
      table_key: 'residents',
      builtin_key: 'row_number',
      name: '№',
      kind: 'action',
      position: 0,
      options: [],
      archived: false,
    },
    {
      id: 1,
      table_key: 'residents',
      builtin_key: 'full_name',
      name: 'ФИО',
      kind: 'text',
      position: 0,
      options: [],
      archived: false,
    },
    {
      id: 2,
      table_key: 'residents',
      builtin_key: 'action_advance',
      name: 'Записать на аванс',
      kind: 'action',
      position: 1,
      options: [],
      archived: false,
    },
    {
      id: 3,
      table_key: 'residents',
      builtin_key: 'action_settlement',
      name: 'Записать на расчёт',
      kind: 'action',
      position: 2,
      options: [],
      archived: false,
    },
  ];
  vi.spyOn(api, 'tableColumns').mockResolvedValue(cols);
  const action = vi.fn();
  render(
    <SettingsContext.Provider value={{ open: vi.fn(), revision: 0, readOnly: false }}>
      <TableColumnsProvider dormitoryId="7" table="residents">
        <ConfiguredTable className="table">
          <thead>
            <tr>
              <ConfiguredHeaders />
            </tr>
          </thead>
          <tbody>
            <tr>
              <ConfiguredCells
                fields={['row_number', 'full_name', 'action_advance', 'action_settlement']}
                row={{ id: 20 }}
              >
                <th scope="row">1</th>
                <td>Иванов Иван</td>
                <td>
                  <>
                    <button type="button" onClick={action}>
                      Записать
                    </button>
                    <span role="status">Уже записан</span>
                  </>
                </td>
                <td>
                  <button type="button">Записать</button>
                </td>
              </ConfiguredCells>
            </tr>
          </tbody>
        </ConfiguredTable>
      </TableColumnsProvider>
    </SettingsContext.Provider>,
  );
  await screen.findByRole('columnheader', { name: 'Действия' });
  expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  expect(screen.getByRole('rowheader', { name: '1' })).toBeInTheDocument();
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'Действия, строка 20' });
  await user.click(trigger);
  const menu = screen.getByRole('group', { name: 'Действия, строка 20' });
  expect(screen.getByRole('rowheader', { name: '1' }).closest('tr')).not.toContainElement(menu);
  expect(screen.getByRole('button', { name: 'Записать на аванс' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Записать на аванс' }));
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('group', { name: 'Действия, строка 20' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole('columnheader', { name: 'ФИО' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('status')).toBeVisible();
});

it('создаёт по сохранённому шаблону с выбором отдельной подвкладки', async () => {
  const template: StructureTemplateDetail = {
    id: 10,
    name: 'Проверки',
    tab_count: 2,
    created_at: '2026-10-09T00:00:00Z',
    snapshot: {
      sections: { residents: 'active' },
      parents: {},
      tabs: [{ key: 'custom_9', name: 'Документы', parent: 'residents', is_active: true }],
      columns: {},
      rows: [],
    },
  };
  const create = vi.spyOn(api, 'createDormitory').mockResolvedValue({
    id: 30,
    name: 'Новое',
    client_name: 'Клиент',
    is_archived: false,
    created_at: '',
  });
  mockFetch((url) => {
    if (url.endsWith('/dormitory-tab-catalog')) return { status: 200, body: defaultTabCatalog };
    if (url.endsWith('/report-templates')) return { status: 200, body: [] };
    if (url.endsWith('/dormitory-templates/10')) return { status: 200, body: template };
    if (url.endsWith('/dormitory-templates')) return { status: 200, body: [template] };
    return { status: 404 };
  });
  render(
    <CreateDormitoryDialog
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название общежития'), 'Новое');
  await user.type(screen.getByLabelText('Название клиента'), 'Клиент');
  await user.click(screen.getByRole('button', { name: 'По образцу' }));
  await screen.findByRole('option', { name: 'Проверки · 2 вкладок' });
  await user.selectOptions(screen.getByLabelText('Образец структуры'), 'template:10');
  await user.click(await screen.findByRole('checkbox', { name: 'Проживающие' }));
  const preview = within(screen.getByRole('complementary', { name: 'Предпросмотр структуры' }));
  expect(preview.getByText('Документы')).toBeInTheDocument();
  expect(preview.queryByText('Проживающие')).not.toBeInTheDocument();
  await user.click(screen.getByTestId('create-dormitory-submit'));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      name: 'Новое',
      client_name: 'Клиент',
      structure_template_id: 10,
      structure_template_keys: ['custom_9'],
    }),
  );
});
