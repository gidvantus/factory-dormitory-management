import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Employee, PersonnelData } from '../../api/personnel';
import { PersonnelEmployeeFocus } from './PersonnelEmployeeFocus';

const people: Employee[] = ['Анна Иванова', 'Пётр Соколов'].map((name, index) => ({
  id: String(index),
  member_ids: [String(index)],
  full_name: name,
  personnel_number: String(100 + index),
  phone: null,
  identity_status: 'confirmed',
  current: index
    ? []
    : [
        {
          table_key: 'residents',
          row_id: 1,
          dormitory_id: 1,
          source_name: 'Проживающие',
          values: { shift_start: '2026-10-01', shift_end: '2026-10-21' },
        },
      ],
  sources: [],
  history_dormitory_ids: [],
  variants: {},
}));
const data: PersonnelData = {
  today: '2026-10-11',
  employees: people,
  dormitories: [{ id: 1, name: 'Северное', client_name: '', is_archived: false }],
  plans: [],
  arrival_plans: [],
  preferences: { revision: 0, lists: [], blocks: [] },
};
const criteria = { filter: 'all' as const, dormitory: null, scope: [], days: 5, query: '' };

it('показывает выбранного человека независимо от флажков и обновляет карточку при смене списка', async () => {
  const user = userEvent.setup();
  const onPerson = vi.fn();
  const onSelection = vi.fn();
  const props = {
    people,
    rows: people,
    selected: [],
    onSelection,
    onPerson,
    data,
    criteria,
    fields: [],
  };
  const { rerender } = render(<PersonnelEmployeeFocus {...props} />);
  const detail = screen.getByRole('complementary', { name: 'Выбранный сотрудник' });
  expect(within(detail).getByRole('heading')).toHaveTextContent('Анна Иванова');
  expect(within(detail).getByRole('progressbar')).toHaveAttribute('value', '50');
  await user.click(screen.getByRole('button', { name: /^Пётр Соколов/ }));
  expect(within(detail).getByRole('heading')).toHaveTextContent('Пётр Соколов');
  expect(detail).toHaveTextContent('Вне общежитий');
  expect(onPerson).not.toHaveBeenCalled();
  await user.click(screen.getByRole('checkbox', { name: 'Выбрать сотрудника Анна Иванова' }));
  expect(onSelection).toHaveBeenCalledWith(['0']);
  expect(within(detail).getByRole('heading')).toHaveTextContent('Пётр Соколов');
  await user.click(screen.getByRole('button', { name: 'Открыть полную карточку' }));
  expect(onPerson).toHaveBeenCalledWith('1');
  rerender(<PersonnelEmployeeFocus {...props} people={[people[0]]} rows={[people[0]]} />);
  expect(within(detail).getByRole('heading')).toHaveTextContent('Анна Иванова');
  rerender(<PersonnelEmployeeFocus {...props} people={[]} rows={[]} />);
  expect(detail).toHaveTextContent('Здесь появится карточка сотрудника');
  expect(within(detail).queryByRole('button')).not.toBeInTheDocument();
});
