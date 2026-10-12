import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../../test/mockFetch';
import { HostelPlaces } from './HostelPlaces';

afterEach(() => vi.unstubAllGlobals());

describe('Места', () => {
  it('показывает свободные места только для чтения и обновляет расчёт после изменения исходной ячейки', async () => {
    let saves = 0;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/hostels?') && !init?.method) {
        const snapshots = [
          { paid: 10, free: 4, total: 9 },
          { paid: 12, free: 6, total: 11 },
          { paid: undefined, free: -6, total: -1 },
        ];
        const current = snapshots[saves];
        return {
          status: 200,
          body: {
            months: [
              {
                month: '2025-10-01',
                days: ['2025-10-01'],
                hostels: [
                  {
                    id: 9,
                    name: 'Хостел',
                    values: {
                      residents_m: { '2025-10-01': 6 },
                      residents_f: { '2025-10-01': 3 },
                      paid_m: current.paid === undefined ? {} : { '2025-10-01': current.paid },
                      paid_f: { '2025-10-01': 8 },
                      free_m: { '2025-10-01': current.free },
                      free_f: { '2025-10-01': 5 },
                      free_total: { '2025-10-01': current.total },
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      if (url.endsWith('/hostels/9/cells/2025-10-01/paid_m') && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ value: saves === 0 ? 12 : null });
        saves += 1;
        return { status: 204 };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    render(<HostelPlaces dormitoryId="7" month="2025-10" onMonthChange={vi.fn()} />);
    const hostel = await screen.findByTestId('hostel-9-2025-10-01');
    const men = within(hostel).getByRole('row', { name: /Свободных мест М/ });
    const women = within(hostel).getByRole('row', { name: /Свободных мест Ж/ });
    const total = within(hostel).getAllByRole('row', { name: /Итого М\+Ж/ })[1];
    expect(within(men).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(women).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(men).getByRole('status')).toHaveTextContent('4');
    expect(within(women).getByRole('status')).toHaveTextContent('5');
    expect(within(total).getByRole('status')).toHaveTextContent('9');
    expect(within(men).getByRole('status')).toHaveAttribute(
      'title',
      'Оплачено мест М − Проживает М',
    );

    const paid = within(hostel).getByRole('textbox', {
      name: 'Хостел, Оплачено мест М, 01.10.2025',
    });
    await user.clear(paid);
    await user.type(paid, '12');
    await user.tab();
    await waitFor(() => expect(within(men).getByRole('status')).toHaveTextContent('6'));
    expect(within(total).getByRole('status')).toHaveTextContent('11');
    expect(within(women).getByRole('status')).toHaveTextContent('5');

    await user.clear(paid);
    await user.tab();
    await waitFor(() => expect(within(men).getByRole('status')).toHaveTextContent('-6'));
    expect(within(total).getByRole('status')).toHaveTextContent('-1');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  });

  it('показывает весь месяц, включая високосный февраль и переход на новый год', async () => {
    const fetchMock = mockFetch((url) => {
      const query = new URL(url, 'http://localhost').searchParams;
      const from = query.get('from')!;
      const to = query.get('to')!;
      const days: string[] = [];
      for (
        let day = from;
        day <= to;
        day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      ) {
        days.push(day);
      }
      return {
        status: 200,
        body: { months: [{ month: from, days, hostels: [{ id: 1, name: 'Хостел', values: {} }] }] },
      };
    });
    function Example(): JSX.Element {
      const [month, setMonth] = useState('2025-12');
      return <HostelPlaces dormitoryId="7" month={month} onMonthChange={setMonth} />;
    }
    const user = userEvent.setup();
    render(<Example />);
    await screen.findByTestId('hostel-1-2025-12-01');
    expect(
      within(screen.getByTestId('hostel-1-2025-12-01')).getAllByRole('columnheader'),
    ).toHaveLength(32);
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));
    await screen.findByTestId('hostel-1-2026-01-01');
    expect(screen.getByLabelText('Месяц и год')).toHaveValue('2026-01');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('from=2026-01-01&to=2026-01-31')),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Месяц и год'), { target: { value: '2024-02' } });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('from=2024-02-01&to=2024-02-29')),
      ).toBe(true),
    );
    await screen.findByTestId('hostel-1-2024-02-01');
    expect(
      within(screen.getByTestId('hostel-1-2024-02-01')).getAllByRole('columnheader'),
    ).toHaveLength(30);
  });

  it('добавляет хостел, сохраняет дневную ячейку и убирает его с выбранного месяца', async () => {
    let exists = false;
    let value: number | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/dormitories/7/hostels?') && !init?.method) {
        const query = new URL(url, 'http://localhost').searchParams;
        const from = query.get('from')!;
        const to = query.get('to')!;
        const days: string[] = [];
        for (
          let day = from;
          day <= to;
          day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
        ) {
          days.push(day);
        }
        return {
          status: 200,
          body: {
            months: [
              {
                month: from,
                days,
                hostels: exists
                  ? [
                      {
                        id: 9,
                        name: 'Хостел 1',
                        values:
                          value === null || from !== '2025-10-01'
                            ? {}
                            : {
                                residents_m: { '2025-10-01': value },
                                residents_total: { '2025-10-01': value },
                              },
                      },
                    ]
                  : [],
              },
            ],
          },
        };
      }
      if (url.endsWith('/api/dormitories/7/hostels') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Хостел 1', month: '2025-10-01' });
        exists = true;
        return { status: 201, body: { id: 9, name: 'Хостел 1' } };
      }
      if (
        url.endsWith('/api/dormitories/7/hostels/9/cells/2025-10-01/residents_m') &&
        init?.method === 'PUT'
      ) {
        expect(JSON.parse(String(init.body))).toEqual({ value: 4 });
        value = 4;
        return { status: 204 };
      }
      if (
        url.includes('/api/dormitories/7/hostels/9?month=2025-10-01') &&
        init?.method === 'DELETE'
      ) {
        exists = false;
        return { status: 204 };
      }
      return { status: 404, body: {} };
    });
    const user = userEvent.setup();
    function Example(): JSX.Element {
      const [month, setMonth] = useState('2025-10');
      return <HostelPlaces dormitoryId="7" month={month} onMonthChange={setMonth} />;
    }
    render(<Example />);
    expect(fetchMock.mock.calls[0][0]).toContain('from=2025-10-01&to=2025-10-31');
    await user.click(await screen.findByRole('button', { name: '+ Добавить хостел' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить хостел' });
    await user.type(within(dialog).getByLabelText('Название хостела'), 'Хостел 1');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить хостел' }));
    const hostel = await screen.findByTestId('hostel-9-2025-10-01');
    expect(within(hostel).getAllByRole('columnheader')).toHaveLength(32);
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));
    await waitFor(() => expect(screen.getByLabelText('Месяц и год')).toHaveValue('2025-11'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('from=2025-11-01&to=2025-11-30')),
      ).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Предыдущий месяц' }));
    await waitFor(() => expect(screen.getByTestId('hostel-9-2025-10-01')).toBeInTheDocument());
    const input = within(screen.getByTestId('hostel-9-2025-10-01')).getByRole('textbox', {
      name: 'Хостел 1, Проживает М, 01.10.2025',
    });
    await user.type(input, '4');
    await user.tab();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/cells/2025-10-01/residents_m') && init?.method === 'PUT',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId('hostel-9-2025-10-01')).getAllByRole('row', {
          name: /Итого М\+Ж/,
        })[0],
      ).toHaveTextContent('4'),
    );
    await user.click(
      within(screen.getByTestId('hostel-9-2025-10-01')).getByRole('button', {
        name: /Убрать хостел Хостел 1/,
      }),
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Убрать «Хостел 1»' })).getByRole('button', {
        name: 'Убрать хостел',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('hostel-9-2025-10-01')).not.toBeInTheDocument(),
    );
  });
});
