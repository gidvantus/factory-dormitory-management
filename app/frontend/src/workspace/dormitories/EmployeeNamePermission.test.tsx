import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ExchangePermissionsContext } from '../../auth/exchangePermissions';
import { EmployeeNameCell } from './EmployeeNameCell';

it('закрывает карточку персонала, сохраняя редактирование ФИО в разрешённой таблице общежития', async () => {
  render(
    <ExchangePermissionsContext.Provider
      value={{ import_enabled: true, export_enabled: true, personnel_enabled: false }}
    >
      <EmployeeNameCell
        dormitoryId="37"
        tableKey="residents"
        rowId={1}
        employeeId="person-1"
        fields={{ full_name: 'Иван Петров' }}
        onChange={vi.fn()}
        onSave={vi.fn(async () => true)}
      />
    </ExchangePermissionsContext.Provider>,
  );
  expect(screen.getByText('Иван Петров')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Редактировать ФИО, строка 1' }));
  expect(screen.getByRole('textbox')).toHaveValue('Иван Петров');
});
