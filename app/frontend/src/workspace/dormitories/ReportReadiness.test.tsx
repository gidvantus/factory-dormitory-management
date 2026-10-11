import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { api, ApiError } from '../../api/client';
import type { DailyReportReadiness } from '../../api/client';
import { ReportReadiness } from './ReportReadiness';

const NOT_READY: DailyReportReadiness = {
  report_date: '2026-10-09',
  is_ready: false,
  confirmed_at: null,
  confirmed_by: null,
};
const READY: DailyReportReadiness = {
  ...NOT_READY,
  is_ready: true,
  confirmed_at: '2026-10-09T12:00:00Z',
  confirmed_by: 'Анна',
};

afterEach(() => vi.restoreAllMocks());

it('сохраняет и снимает подтверждение за день, полученный от сервера', async () => {
  const user = userEvent.setup();
  vi.spyOn(api, 'reportReadiness').mockResolvedValue(NOT_READY);
  const save = vi
    .spyOn(api, 'setReportReadiness')
    .mockResolvedValueOnce(READY)
    .mockResolvedValueOnce(NOT_READY);
  const view = render(<ReportReadiness dormitoryId="7" />);
  await user.click(await screen.findByRole('checkbox', { name: 'Отчёт не готов' }));
  expect(save).toHaveBeenLastCalledWith('7', '2026-10-09', true);
  expect(await screen.findByRole('checkbox', { name: 'Отчёт готов' })).toBeChecked();
  // Повторное открытие читает сохранённую отметку.
  vi.mocked(api.reportReadiness).mockResolvedValue(READY);
  view.unmount();
  render(<ReportReadiness dormitoryId="7" />);
  expect(await screen.findByRole('checkbox', { name: 'Отчёт готов' })).toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Отчёт готов' }));
  expect(save).toHaveBeenLastCalledWith('7', '2026-10-09', false);
  expect(await screen.findByRole('checkbox', { name: 'Отчёт не готов' })).not.toBeChecked();
});

it('не показывает успешное подтверждение при ошибке и блокирует повторное нажатие во время сохранения', async () => {
  vi.spyOn(api, 'reportReadiness').mockResolvedValue(NOT_READY);
  let rejectSave!: (reason: unknown) => void;
  const save = vi.spyOn(api, 'setReportReadiness').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  render(<ReportReadiness dormitoryId="7" />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Отчёт не готов' }));
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  rejectSave(new Error('Offline'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить отметку.');
  expect(screen.getByRole('checkbox')).toBeEnabled();
  expect(save).toHaveBeenCalledTimes(1);
});

it('обновляет отметку при возвращении на страницу и смене дня, обрабатывает устаревшую дату', async () => {
  const read = vi.spyOn(api, 'reportReadiness').mockResolvedValue(READY);
  vi.spyOn(api, 'setReportReadiness').mockRejectedValue(new ApiError(409, 'Дата изменилась.'));
  render(<ReportReadiness dormitoryId="7" />);
  expect(await screen.findByRole('checkbox', { name: 'Отчёт готов' })).toBeChecked();
  read.mockResolvedValue({ ...NOT_READY, report_date: '2026-10-10' });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Отчёт не готов' })).toBeEnabled(),
  );
  expect(screen.getByText('За сегодня · 10.10.2026')).toBeInTheDocument();
  read.mockResolvedValue({ ...READY, report_date: '2026-10-10' });
  fireEvent(window, new Event('focus'));
  expect(await screen.findByRole('checkbox', { name: 'Отчёт готов' })).toBeChecked();
});
