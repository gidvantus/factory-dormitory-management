import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import type { ColumnKind, CustomTab } from '../../api/client';
import { CreateTableDialog } from './CreateTableDialog';

const tab: CustomTab = {
  id: 9,
  dormitory_id: 7,
  name: 'Документы',
  table_key: 'custom_9',
  table_created: false,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
};
afterEach(() => vi.restoreAllMocks());
function show(): { created: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const created = vi.fn(),
    close = vi.fn();
  render(<CreateTableDialog dormitoryId="7" tab={tab} onCreated={created} onClose={close} />);
  return { created, close };
}

it('создаёт несколько столбцов разных типов одним запросом, сохраняя порядок и собственные варианты списков', async () => {
  const saved = { ...tab, table_created: true };
  const request = vi.spyOn(api, 'createCustomTabTable').mockResolvedValue(saved);
  const { created, close } = show();
  const user = userEvent.setup();
  const fields: [string, ColumnKind][] = [
    ['ФИО', 'text'],
    ['Количество', 'number'],
    ['Дата', 'date'],
    ['Отметка', 'checkbox'],
    ['Причина', 'select'],
    ['Статус', 'select'],
  ];
  for (const [index, [name, kind]] of fields.entries()) {
    if (index) await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
    const group = within(screen.getByRole('group', { name: `Столбец ${index + 1}` }));
    await user.type(group.getByLabelText('Название столбца'), name);
    await user.selectOptions(group.getByLabelText('Тип столбца'), kind);
    if (kind === 'select') {
      await user.type(group.getByLabelText('Вариант 1'), name === 'Причина' ? 'Сбежал' : 'Готов');
      await user.click(group.getByRole('button', { name: '+ Вариант' }));
      await user.type(
        group.getByLabelText('Вариант 2'),
        name === 'Причина' ? 'Уволился' : 'Ожидает',
      );
    }
  }
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith(saved));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    '7',
    9,
    fields.map(([name, kind]) => ({
      name,
      kind,
      options:
        kind === 'select'
          ? (name === 'Причина' ? ['Сбежал', 'Уволился'] : ['Готов', 'Ожидает']).map((label) => ({
              id: null,
              label,
              archived: false,
            }))
          : [],
    })),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

it('при удалении промежуточного столбца сохраняет значения и формат остальных', async () => {
  const request = vi
    .spyOn(api, 'createCustomTabTable')
    .mockResolvedValue({ ...tab, table_created: true });
  show();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название столбца'), 'ФИО');
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  await user.type(
    within(screen.getByRole('group', { name: 'Столбец 2' })).getByLabelText('Название столбца'),
    'Лишний',
  );
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  const third = within(screen.getByRole('group', { name: 'Столбец 3' }));
  await user.type(third.getByLabelText('Название столбца'), 'Дата');
  await user.selectOptions(third.getByLabelText('Тип столбца'), 'date');
  await user.click(screen.getByRole('button', { name: 'Удалить столбец 2' }));
  const second = within(screen.getByRole('group', { name: 'Столбец 2' }));
  expect(second.getByLabelText('Название столбца')).toHaveValue('Дата');
  expect(second.getByLabelText('Тип столбца')).toHaveValue('date');
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  expect(request).toHaveBeenCalledWith('7', 9, [
    { name: 'ФИО', kind: 'text', options: [] },
    { name: 'Дата', kind: 'date', options: [] },
  ]);
});

it('проверяет повторяющиеся названия и варианты до отправки', async () => {
  const request = vi
    .spyOn(api, 'createCustomTabTable')
    .mockResolvedValue({ ...tab, table_created: true });
  show();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название столбца'), 'Мой статус');
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  const second = within(screen.getByRole('group', { name: 'Столбец 2' }));
  await user.type(second.getByLabelText('Название столбца'), 'мой  статус');
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Столбец 2: это название уже используется');
  expect(request).not.toHaveBeenCalled();
  await user.clear(second.getByLabelText('Название столбца'));
  await user.type(second.getByLabelText('Название столбца'), 'Причина');
  await user.selectOptions(second.getByLabelText('Тип столбца'), 'select');
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  expect(screen.getByRole('alert')).toHaveTextContent('Столбец 2: заполните хотя бы один вариант');
  await user.type(second.getByLabelText('Вариант 1'), 'Сбежал');
  await user.click(second.getByRole('button', { name: '+ Вариант' }));
  await user.type(second.getByLabelText('Вариант 2'), 'сбежал');
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  expect(screen.getByRole('alert')).toHaveTextContent('варианты списка не должны повторяться');
  expect(request).not.toHaveBeenCalled();
});

it('сохраняет все введённые столбцы после ошибки и блокирует изменение во время сохранения', async () => {
  let resolve!: (tab: CustomTab) => void;
  const request = vi
    .spyOn(api, 'createCustomTabTable')
    .mockRejectedValueOnce(new ApiError(503, 'Нет соединения'))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  const { created } = show();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Название столбца'), 'ФИО');
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  const second = within(screen.getByRole('group', { name: 'Столбец 2' }));
  await user.type(second.getByLabelText('Название столбца'), 'Количество');
  await user.selectOptions(second.getByLabelText('Тип столбца'), 'number');
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Нет соединения');
  expect(second.getByLabelText('Название столбца')).toHaveValue('Количество');
  await user.click(screen.getByRole('button', { name: 'Создать таблицу' }));
  expect(screen.getByRole('button', { name: '+ Добавить столбец' })).toBeDisabled();
  expect(second.getByLabelText('Тип столбца')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Удалить столбец 1' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Закрыть окно' })).toBeDisabled();
  resolve({ ...tab, table_created: true });
  await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
});

it('не создаёт таблицу без столбцов и позволяет добавить столбец заново', async () => {
  show();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Удалить столбец 1' }));
  expect(screen.getByRole('button', { name: 'Создать таблицу' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '+ Добавить столбец' }));
  expect(screen.getByLabelText('Название столбца')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Создать таблицу' })).toBeEnabled();
});
