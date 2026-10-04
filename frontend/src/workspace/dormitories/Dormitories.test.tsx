import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client';
import type { Dormitory } from '../../api/client';
import { mockFetch } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

const DORMITORY: Dormitory = {
  id: 7,
  name: 'Северное',
  client_name: 'Стройкомплект',
  created_at: '2026-10-04T10:00:00Z',
};
const USER = {
  email: 'worker@example.com',
  full_name: 'Иван Иванов',
  created_at: '2026-01-01T00:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockList(items: Dormitory[] = []): void {
  mockFetch((url) => {
    if (url.endsWith('/api/me')) return { status: 200, body: USER };
    if (url.endsWith('/api/dormitories')) return { status: 200, body: items };
    if (url.endsWith('/api/dormitories/7')) return { status: 200, body: DORMITORY };
    return { status: 404, body: { detail: 'Общежитие не найдено' } };
  });
}

async function openDialog(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  const button = await screen.findByTestId('create-dormitory-button');
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  return user;
}

async function fillDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Название общежития'), DORMITORY.name);
  await user.type(screen.getByLabelText('Название клиента'), DORMITORY.client_name);
}

describe('общежития', () => {
  it('создаёт карточку с клиентом перед названием, открывает пустую страницу и возвращает в список', async () => {
    let items: Dormitory[] = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/api/me')) return { status: 200, body: USER };
      if (url.endsWith('/api/dormitories') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          name: DORMITORY.name,
          client_name: DORMITORY.client_name,
        });
        items = [DORMITORY];
        return { status: 201, body: DORMITORY };
      }
      if (url.endsWith('/api/dormitories')) return { status: 200, body: items };
      return { status: 200, body: DORMITORY };
    });
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    expect(screen.getByLabelText('Название общежития')).toHaveFocus();
    await fillDialog(user);
    await user.click(screen.getByTestId('create-dormitory-submit'));
    const card = await screen.findByTestId('dormitory-card-7');
    expect(card.textContent).toBe(`${DORMITORY.client_name}${DORMITORY.name}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
    await user.click(card);
    const details = await screen.findByTestId('dormitory-details-page');
    await waitFor(() => expect(within(details).queryByRole('status')).not.toBeInTheDocument());
    expect(details.textContent).toBe('Назад');
    expect(screen.getByTestId('workspace-nav-dormitories')).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByTestId('dormitory-back'));
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('проверяет обязательные поля до отправки и закрывается по Escape с возвратом фокуса', async () => {
    mockList();
    const create = vi.spyOn(api, 'createDormitory');
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByLabelText('Название общежития')).toHaveFocus();
    expect(create).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Название общежития'), 'Несохранённое');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('create-dormitory-button')).toHaveFocus();
    expect(document.body.style.overflow).not.toBe('hidden');
    await user.click(screen.getByTestId('create-dormitory-button'));
    expect(screen.getByLabelText('Название общежития')).toHaveValue('');
  });

  it('не теряет введённые данные при ошибке и позволяет повторить сохранение', async () => {
    mockList();
    const create = vi
      .spyOn(api, 'createDormitory')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(DORMITORY);
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    await fillDialog(user);
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось создать общежитие');
    expect(screen.getByLabelText('Название общежития')).toHaveValue(DORMITORY.name);
    expect(screen.getByLabelText('Название клиента')).toHaveValue(DORMITORY.client_name);
    await user.click(screen.getByTestId('create-dormitory-submit'));
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('блокирует повторную отправку и закрытие, пока сохраняется общежитие', async () => {
    mockList();
    let resolve!: (value: Dormitory) => void;
    const create = vi.spyOn(api, 'createDormitory').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderApp('/cabinet/dormitories');
    const user = await openDialog();
    await fillDialog(user);
    const form = screen.getByTestId('create-dormitory-submit').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('create-dormitory-submit')).toBeDisabled();
    expect(screen.getByTestId('create-dormitory-modal-close')).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    resolve(DORMITORY);
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
  });

  it('восстанавливает сохранённые карточки при открытии списка и даёт повторить загрузку', async () => {
    mockList();
    vi.spyOn(api, 'dormitories')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce([DORMITORY]);
    renderApp('/cabinet/dormitories');
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить список');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('dormitory-card-7')).toBeInTheDocument();
  });

  it('открывает общежитие по прямой ссылке', async () => {
    mockList([DORMITORY]);
    renderApp('/cabinet/dormitories/7');
    const details = await screen.findByTestId('dormitory-details-page');
    await waitFor(() => expect(within(details).queryByRole('status')).not.toBeInTheDocument());
    expect(details.textContent).toBe('Назад');
  });

  it('показывает отсутствие общежития и оставляет рабочую кнопку назад', async () => {
    mockList();
    renderApp('/cabinet/dormitories/999');
    expect(await screen.findByRole('alert')).toHaveTextContent('Общежитие не найдено');
    expect(screen.getByTestId('dormitory-back')).toHaveAttribute('href', '/cabinet/dormitories');
  });
});
