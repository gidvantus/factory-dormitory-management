import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReportLink } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { ReportLinkEditor } from './ReportLinkEditor';

afterEach(() => vi.unstubAllGlobals());
function Editor({ initial = null }: { initial?: ReportLink | null }): JSX.Element {
  const [link, setLink] = useState(initial);
  return (
    <>
      <ReportLinkEditor dormitoryId="1" initial={initial} onChange={setLink} disabled={false} />
      <output data-testid="link">{JSON.stringify(link)}</output>
    </>
  );
}
it('связывает строку с количеством из плана без условий по сотрудникам и столбцам', async () => {
  const user = userEvent.setup();
  mockFetch(() => ({ status: 200, body: [] }));
  render(<Editor />);
  await user.selectOptions(screen.getByLabelText('Раздел'), 'arrival_plan');
  expect(screen.getByTestId('link')).toHaveTextContent('{"table_key":"arrival_plan"}');
  expect(screen.getByText(/ФИО на расчёт не влияют/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Столбец')).not.toBeInTheDocument();
});
it('восстанавливает связь при редактировании строки отчёта', async () => {
  mockFetch(() => ({ status: 200, body: [] }));
  render(<Editor initial={{ table_key: 'arrival_plan' }} />);
  expect(screen.getByLabelText('Раздел')).toHaveValue('arrival_plan');
  expect(await screen.findByText(/ФИО на расчёт не влияют/)).toBeInTheDocument();
  expect(screen.getByTestId('link')).toHaveTextContent('{"table_key":"arrival_plan"}');
});
