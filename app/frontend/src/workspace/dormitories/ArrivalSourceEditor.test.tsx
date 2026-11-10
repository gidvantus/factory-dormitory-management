import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CustomTabOptionsEditor } from './CustomTabOptionsEditor';
import { defaultTabOptions } from './customTabOptions';
import { mockFetch } from '../../test/mockFetch';

afterEach(() => vi.unstubAllGlobals());
it('выбирает план заездов внутри конструктора, связывает дополнительные поля и выключает ручную правку', async () => {
  mockFetch(() => ({
    status: 200,
    body: [
      { id: 'full_name', label: 'ФИО', kind: 'text' },
      { id: 'person:shifts', label: 'Количество смен', kind: 'number' },
    ],
  }));
  function Example(): JSX.Element {
    const [value, setValue] = useState(defaultTabOptions);
    return (
      <>
        <CustomTabOptionsEditor
          dormitoryId="37"
          value={value}
          onChange={setValue}
          columns={[
            { id: 1, name: 'ФИО', kind: 'text', archived: false },
            { name: 'Смены', kind: 'number', archived: false },
          ]}
        />
        <output aria-label="Настройки">{JSON.stringify(value)}</output>
      </>
    );
  }
  render(<Example />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Источник данных' }), {
    target: { value: 'arrival_plan' },
  });
  expect(screen.queryByRole('checkbox', { name: 'Добавить строку' })).not.toBeInTheDocument();
  await within(screen.getByRole('combobox', { name: 'Поле плана заездов: Смены' })).findByRole(
    'option',
    { name: 'Количество смен' },
  );
  await userEvent
    .setup()
    .selectOptions(
      screen.getByRole('combobox', { name: 'Поле плана заездов: Смены' }),
      'person:shifts',
    );
  const settings = JSON.parse(screen.getByLabelText('Настройки').textContent ?? '{}');
  expect(settings.arrival_columns).toEqual({ '1': 'full_name', 'name:Смены': 'person:shifts' });
  expect(settings.import_enabled).toBe(false);
  expect(settings.add_row).toBe(false);
  expect(settings.period_mode).toBe('month');
});
