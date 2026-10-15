import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../../api/client';
import type { OutflowRow } from '../../api/client';
import { mockTableFetch as mockFetch } from '../../test/tableColumns';
import { OutflowTable } from './OutflowTable';
import { SettingsContext } from './settingsContext';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blank: OutflowRow = {
  id: 8,
  departure_date: null,
  personnel_number: null,
  full_name: null,
  shift_start: null,
  reason: null,
  notes: null,
  additional_info: null,
};

describe('Отток', () => {
  it('создаёт строку, сохраняет поля и удаляет после подтверждения', async () => {
    let row: OutflowRow | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/outflow?') && !init?.method)
        return { status: 200, body: row ? [row] : [] };
      if (url.endsWith('/api/personnel/check'))
        return { status: 200, body: { candidates: [], check_token: 'a'.repeat(64) } };
      if (url.endsWith('/api/personnel/records') && init?.method === 'POST') {
        row = { ...blank };
        return {
          status: 201,
          body: { row_id: 8, employee_id: '00000000-0000-4000-8000-000000000001' },
        };
      }
      if (url.endsWith('/api/dormitories/7/outflow/8') && init?.method === 'PATCH') {
        row = { ...row!, ...(JSON.parse(String(init.body)) as Partial<OutflowRow>) };
        return { status: 200, body: row };
      }
      if (url.endsWith('/api/dormitories/7/outflow/8') && init?.method === 'DELETE') {
        row = null;
        return { status: 204, body: undefined };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(<OutflowTable dormitoryId="7" range={{ from: '2026-10-01', to: '2026-10-31' }} />);
    await user.click(await screen.findByRole('button', { name: /Добавить строку/ }));
    const identity = await screen.findByRole('dialog');
    await user.type(within(identity).getByLabelText('Табельный номер'), '123');
    const saveIdentity = within(identity).getByRole('button', {
      name: 'Создать новую карточку',
    });
    await waitFor(() => expect(saveIdentity).toBeEnabled());
    await user.click(saveIdentity);
    const tableRow = await screen.findByTestId('outflow-row-8');
    expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(9);
    fireEvent.change(within(tableRow).getByLabelText('Дата выезда, строка 8'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.change(within(tableRow).getByLabelText('Начало вахты, строка 8'), {
      target: { value: '2026-09-01' },
    });
    await user.type(within(tableRow).getByLabelText('ФИО, строка 8'), 'Иванов Иван');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Причина, строка 8'), 'Завершил вахту');
    await user.tab();
    await user.type(within(tableRow).getByLabelText('Доп. информация, строка 8'), 'Возврат домой');
    await user.tab();
    await waitFor(() => expect((row as OutflowRow | null)?.additional_info).toBe('Возврат домой'));
    expect(within(tableRow).getByRole('button', { name: 'Выселение' })).toBeEnabled();
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить строку оттока?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByTestId('outflow-row-8')).toBeInTheDocument();
    await user.click(within(tableRow).getByRole('button', { name: 'Удалить' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить строку' }),
    );
    await waitFor(() => expect(screen.queryByTestId('outflow-row-8')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('from=2026-10-01&to=2026-10-31')),
    ).toBe(true);
  });

  it('после подтверждения выселения заменяет меню результатом и сохраняет его при загрузке', async () => {
    let row: OutflowRow = { ...blank, full_name: 'Иванов Иван', employee_id: 'person' };
    mockFetch((url) =>
      url.includes('/outflow?') ? { status: 200, body: [row] } : { status: 404 },
    );
    const preview = vi
      .spyOn(api, 'previewOutflowEviction')
      .mockResolvedValue({ preview_token: 'a'.repeat(64) });
    const evict = vi
      .spyOn(api, 'evictOutflowEmployee')
      .mockRejectedValueOnce(new ApiError(503, 'Не удалось сохранить'))
      .mockImplementation(async () => {
        row = { ...row, evicted_at: '2026-10-14T10:00:00Z' };
        return row;
      });
    const renderTable = () =>
      render(
        <SettingsContext.Provider value={{ open: vi.fn(), revision: 0, readOnly: false }}>
          <OutflowTable dormitoryId="7" range={{ from: '2026-10-01', to: '2026-10-31' }} />
        </SettingsContext.Provider>,
      );
    const view = renderTable();
    const user = userEvent.setup();
    const source = await screen.findByTestId('outflow-row-8');
    await user.click(within(source).getByRole('button', { name: 'Действия, строка 8' }));
    await user.click(screen.getByRole('button', { name: 'Выселение' }));
    let dialog = await screen.findByRole('dialog', { name: 'Выселение сотрудника' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Подтвердить' })).toBeEnabled(),
    );
    expect(dialog).toHaveTextContent('Выселить сотрудника «Иванов Иван»?');
    expect(evict).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(evict).not.toHaveBeenCalled();
    await user.click(within(source).getByRole('button', { name: 'Действия, строка 8' }));
    await user.click(screen.getByRole('button', { name: 'Выселение' }));
    dialog = await screen.findByRole('dialog', { name: 'Выселение сотрудника' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Подтвердить' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Не удалось сохранить');
    expect(source).not.toHaveTextContent('Выселен');
    await user.click(within(dialog).getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(source).toHaveTextContent('Выселен');
    expect(
      within(source).queryByRole('button', { name: /Действия|Выселение|Удалить/ }),
    ).not.toBeInTheDocument();
    expect(evict).toHaveBeenLastCalledWith('7', 8, 'a'.repeat(64));
    expect(preview).toHaveBeenCalledTimes(2);
    view.unmount();
    renderTable();
    const loaded = await screen.findByTestId('outflow-row-8');
    expect(loaded).toHaveTextContent('Выселен');
    expect(
      within(loaded).queryByRole('button', { name: /Действия|Выселение|Удалить/ }),
    ).not.toBeInTheDocument();
  });
});
