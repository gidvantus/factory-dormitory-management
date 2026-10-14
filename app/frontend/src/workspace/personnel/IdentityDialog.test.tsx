import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { personnelApi } from '../../api/personnel';
import { IdentityDialog } from './IdentityDialog';

afterEach(() => vi.restoreAllMocks());

it.each(['none', 'selected', 'cleared'])(
  'использует выбранное совпадение, иначе создаёт нового человека: %s',
  async (choice) => {
    vi.spyOn(personnelApi, 'check').mockResolvedValue({
      check_token: 'a'.repeat(64),
      candidates: [
        {
          id: 'existing-person',
          full_name: 'Иванов Иван',
          personnel_number: null,
          phone: '+79001234567',
          identity_status: 'confirmed',
          dormitories: ['Северное'],
          score: 50,
          evidence: ['Совпадает ФИО'],
          differences: [],
        },
      ],
    });
    const create = vi
      .spyOn(personnelApi, 'createRecord')
      .mockResolvedValue({ row_id: 1, employee_id: 'person' });
    const saved = vi.fn();
    render(
      <IdentityDialog
        dormitoryId="7"
        tableKey="inflow"
        initial={{ full_name: 'Иванов Иван' }}
        onClose={vi.fn()}
        onSaved={saved}
      />,
    );
    const user = userEvent.setup();
    const match = await screen.findByRole('radio', { name: /Иванов Иван/ });
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.queryByText(/Пока не могу определить/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Это новый человек/)).not.toBeInTheDocument();
    if (choice !== 'none') await user.click(match);
    if (choice === 'cleared') await user.click(screen.getByRole('button', { name: 'Снять выбор' }));
    await user.click(
      screen.getByRole('button', {
        name: choice === 'selected' ? 'Использовать карточку' : 'Создать новую карточку',
      }),
    );
    await waitFor(() => expect(saved).toHaveBeenCalledWith('person'));
    expect(create).toHaveBeenCalledWith(
      7,
      'inflow',
      expect.objectContaining({
        mode: choice === 'selected' ? 'existing' : 'new',
        employee_id: choice === 'selected' ? 'existing-person' : null,
      }),
      {},
    );
  },
);
