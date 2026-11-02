import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { personnelApi } from '../../api/personnel';
import type { Employee, PersonnelData } from '../../api/personnel';
import * as download from '../../api/download';
import { SelectedEmployeesDialog } from './SelectedEmployeesDialog';

afterEach(() => vi.restoreAllMocks());
it('выгружает выбранных людей и дополнительные столбцы, даёт повторить после ошибки', async () => {
  const user = userEvent.setup();
  const person: Employee = {
    id: 'chosen',
    member_ids: ['chosen'],
    full_name: 'Иванов Иван',
    personnel_number: '0001',
    phone: null,
    identity_status: 'confirmed',
    current: [],
    sources: [],
    history_dormitory_ids: [],
    variants: {},
  };
  const data: PersonnelData = {
    today: '2026-10-27',
    employees: [person],
    dormitories: [],
    plans: [],
    arrival_plans: [],
    preferences: { revision: 0, blocks: [], lists: [] },
  };
  const blob = new Blob(['xlsx']);
  const exported = vi
    .spyOn(personnelApi, 'exportSelected')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(blob);
  const saved = vi.spyOn(download, 'downloadBlob').mockImplementation(() => undefined);
  render(
    <SelectedEmployeesDialog
      people={[person]}
      data={data}
      criteria={{ filter: 'all', dormitory: null, scope: [], days: 5, query: '' }}
      fields={[
        {
          id: 'source:shifts',
          label: 'Смены',
          kind: 'number',
          columns: [
            {
              id: 12,
              dormitory_id: 1,
              table_key: 'residents',
              source_name: 'Проживающие',
              name: 'Смены',
              kind: 'number',
              builtin_key: null,
              options: [],
            },
          ],
        },
      ]}
      onClose={() => undefined}
      onPerson={() => undefined}
    />,
  );
  await user.clear(screen.getByLabelText('Название списка'));
  await user.type(screen.getByLabelText('Название списка'), 'Список на заселение');
  await user.click(screen.getByRole('button', { name: 'Выгрузить' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Выгрузить' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(blob, 'Сотрудники-2026-10-27.xlsx'));
  expect(exported).toHaveBeenLastCalledWith('Список на заселение', ['chosen'], [[12]]);
});
