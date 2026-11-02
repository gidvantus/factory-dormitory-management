import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { Modal, ModalCancelButton } from './Modal';
import { UnsavedChangesProvider } from './UnsavedChanges';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('защищает закрытие и перезагрузку, сохраняет ввод при отказе от закрытия', async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const closed = vi.fn();
  render(
    <Modal title="Форма" testId="form" onClose={closed}>
      <form>
        <label>
          Комментарий
          <input />
        </label>
        <ModalCancelButton />
      </form>
    </Modal>,
  );
  await user.type(screen.getByLabelText('Комментарий'), 'Нужен автобус');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await user.keyboard('{Escape}');
  expect(closed).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Комментарий')).toHaveValue('Нужен автобус');
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(closed).toHaveBeenCalledOnce();
});

it('защищает переход внутри приложения и снимает защиту после успешного сброса формы', async () => {
  // Node Request и jsdom AbortSignal принадлежат разным средам; сети в этом тесте нет.
  const NativeRequest = Request;
  vi.stubGlobal(
    'Request',
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined });
      }
    },
  );
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  function Editor(): JSX.Element {
    const [value, setValue] = useState('');
    return (
      <Modal title="Форма" testId="form" onClose={() => undefined}>
        <form onReset={() => setValue('')}>
          <input
            aria-label="Текст"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="reset">Сохранено</button>
        </form>
      </Modal>
    );
  }
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <UnsavedChangesProvider>
          <Editor />
        </UnsavedChangesProvider>
      ),
    },
    { path: '/next', element: <p>Следующая страница</p> },
  ]);
  render(<RouterProvider router={router} />);
  await user.type(screen.getByLabelText('Текст'), 'Черновик');
  await act(() => router.navigate('/next'));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(router.state.location.pathname).toBe('/');
  await user.click(screen.getByRole('button', { name: 'Сохранено' }));
  confirm.mockClear();
  await act(() => router.navigate('/next'));
  expect(await screen.findByText('Следующая страница')).toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
});

it('сохраняет защиту после неуспешного сохранения', async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <Modal title="Форма" testId="form" onClose={() => undefined}>
      <form onSubmit={(event) => event.preventDefault()}>
        <input aria-label="Текст" />
        <button>Сохранить</button>
      </form>
    </Modal>,
  );
  await user.type(screen.getByLabelText('Текст'), 'Черновик');
  fireEvent.submit(screen.getByRole('button', { name: 'Сохранить' }).closest('form')!);
  await user.click(screen.getByRole('button', { name: 'Закрыть окно' }));
  expect(confirm).toHaveBeenCalledOnce();
});
