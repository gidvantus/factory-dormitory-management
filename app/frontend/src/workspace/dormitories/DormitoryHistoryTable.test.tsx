import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { CustomTab, DormitoryHistoryPage } from '../../api/client';
import { CreateCustomTabDialog } from './CreateCustomTabDialog';
import { CustomTabTable } from './CustomTabTable';
import { DormitoryHistoryTable } from './DormitoryHistoryTable';

const range = { from: '2026-11-01', to: '2026-11-30' };
const tab: CustomTab = {
  id: 9,
  dormitory_id: 7,
  name: 'Архивные данные',
  kind: 'archive',
  table_key: 'custom_9',
  table_created: true,
  is_active: true,
  has_data: false,
  delete_block_reason: null,
};
const first: DormitoryHistoryPage['items'][number] = {
  id: 2,
  date: '2026-11-02T10:15:00Z',
  author: 'Анна Иванова',
  action: 'Проживающие → запись №24 «Петров»: изменены данные.\nФИО: «Петров» → «Метров»',
};
afterEach(() => vi.restoreAllMocks());

describe('Подвкладка типа Архив', () => {
  it('создаётся с выбранным типом без настроек ручной таблицы', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, 'createCustomTab').mockResolvedValue(tab);
    const created = vi.fn();
    render(
      <CreateCustomTabDialog dormitoryId="7" parentId={3} onClose={vi.fn()} onCreated={created} />,
    );
    await user.selectOptions(screen.getByLabelText('Тип подвкладки'), 'archive');
    await user.type(screen.getByLabelText('Название подвкладки'), tab.name);
    expect(screen.getByText(/Три постоянных столбца: Дата, Действие, Автор/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Формат таблицы')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Создать вкладку с подвкладками' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Создать вкладку' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(tab));
    expect(create).toHaveBeenCalledWith('7', tab.name, null, [], 3, null, undefined, 'archive');
  });

  it('показывает три постоянных столбца, контекст изменения, время и автора', async () => {
    vi.spyOn(api, 'dormitoryHistory').mockResolvedValue({ items: [first], next_cursor: null });
    const columns = vi.spyOn(api, 'tableColumns');
    render(<CustomTabTable dormitoryId="7" tab={tab} range={range} onChanged={vi.fn()} />);
    expect(await screen.findByText(/ФИО: «Петров» → «Метров»/)).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Дата',
      'Действие',
      'Автор',
    ]);
    expect(screen.getByText(first.author)).toBeInTheDocument();
    expect(screen.getByText(/02\.11\.(?:20)?26.*13:15:00/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Добавить|Удалить|Очистить|столбц/ }),
    ).not.toBeInTheDocument();
    expect(columns).not.toHaveBeenCalled();
  });

  it('загружает следующую страницу и обновляет историю с начала', async () => {
    const user = userEvent.setup();
    const load = vi
      .spyOn(api, 'dormitoryHistory')
      .mockResolvedValueOnce({ items: [first], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({
        items: [{ ...first, id: 1, action: 'Отток → удалена запись «Иванов»' }],
        next_cursor: null,
      })
      .mockResolvedValueOnce({ items: [], next_cursor: null });
    render(<DormitoryHistoryTable dormitoryId="7" tab={tab} range={range} />);
    await user.click(await screen.findByRole('button', { name: 'Показать ещё' }));
    expect(await screen.findByText('Отток → удалена запись «Иванов»')).toBeInTheDocument();
    expect(screen.getByText(/ФИО: «Петров» → «Метров»/)).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith(
      '7',
      9,
      range.from,
      range.to,
      expect.any(AbortSignal),
      'cursor-2',
    );
    await user.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(
      await screen.findByText('За выбранный период изменений данных нет.'),
    ).toBeInTheDocument();
  });

  it('отменяет устаревшую загрузку при смене периода', async () => {
    let resolveOld!: (page: DormitoryHistoryPage) => void;
    const load = vi
      .spyOn(api, 'dormitoryHistory')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [], next_cursor: null });
    const view = render(<DormitoryHistoryTable dormitoryId="7" tab={tab} range={range} />);
    view.rerender(
      <DormitoryHistoryTable
        dormitoryId="7"
        tab={tab}
        range={{ from: '2026-10-01', to: '2026-10-31' }}
      />,
    );
    await screen.findByText('За выбранный период изменений данных нет.');
    expect(load.mock.calls[0][4]?.aborted).toBe(true);
    await act(async () => resolveOld({ items: [first], next_cursor: null }));
    expect(screen.queryByText(/ФИО: «Петров» → «Метров»/)).not.toBeInTheDocument();
  });
});
