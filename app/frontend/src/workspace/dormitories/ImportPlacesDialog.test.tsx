import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlacesImportResult } from '../../api/client';
import { ImportPlacesDialog } from './ImportPlacesDialog';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), confirm: vi.fn() }));

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, uploadPlacesImport: mocks.upload, confirmPlacesImport: mocks.confirm };
});

function ready(overrides: Partial<PlacesImportResult> = {}): PlacesImportResult {
  return {
    import_id: 4,
    status: 'ready',
    months: ['2025-11-01'],
    counts: { hostels: 2, cells: 7, deleted: 3 },
    rows: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function renderDialog(onImported = vi.fn()): { onImported: ReturnType<typeof vi.fn> } {
  render(
    <ImportPlacesDialog
      dormitoryId="7"
      month="2025-11"
      onClose={vi.fn()}
      onImported={onImported}
    />,
  );
  return { onImported };
}

beforeEach(() => {
  mocks.upload.mockReset();
  mocks.confirm.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('Импорт «Размещение персонала»', () => {
  it('ведёт файл через прогресс и разбор, показывает счётчики и применяет импорт', async () => {
    let resolveUpload!: (value: PlacesImportResult) => void;
    const callbacks: { progress: (percent: number) => void; uploaded: () => void } = {
      progress: () => undefined,
      uploaded: () => undefined,
    };
    mocks.upload.mockImplementation(
      (_id: string, _file: File, progress: (percent: number) => void, uploaded?: () => void) => {
        callbacks.progress = progress;
        callbacks.uploaded = uploaded ?? (() => undefined);
        return new Promise<PlacesImportResult>((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    mocks.confirm.mockResolvedValue({
      import_id: 4,
      month: '2025-11-01',
      hostels: 2,
      cells: 7,
    });
    const user = userEvent.setup();
    const { onImported } = renderDialog();

    expect(screen.getByTestId('places-import-download-template')).toHaveAttribute(
      'href',
      '/api/dormitories/7/hostels/import/template?month=2025-11-01',
    );
    expect(
      screen.getByText(
        'Скачайте шаблон, заполните и загрузите. Импорт заменяет месяц из файла целиком, а пустая ячейка удаляет значение.',
      ),
    ).toBeInTheDocument();

    await user.upload(screen.getByTestId('places-import-file'), new File(['x'], 'mesta.xlsx'));
    await act(async () => callbacks.progress(40));
    expect(screen.getByText('Загружаем файл: 40 %')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '40');

    await act(async () => callbacks.uploaded());
    expect(screen.getByTestId('places-import-parsing')).toHaveTextContent('Разбираем файл…');

    await act(async () => resolveUpload(ready()));
    expect(await screen.findByText('Хостелов в файле: 2')).toBeInTheDocument();
    expect(screen.getByText('Будет записано значений: 7')).toBeInTheDocument();
    expect(screen.getByText('Будет удалено значений: 3')).toBeInTheDocument();
    expect(screen.getByText(/Месяц: ноябрь 2025/)).toBeInTheDocument();

    await user.click(screen.getByTestId('places-import-apply'));
    expect(await screen.findByTestId('places-import-applied')).toHaveTextContent('Импорт применён');
    expect(mocks.confirm).toHaveBeenCalledWith('7', 4);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('при ошибках разбора показывает строки и колонки и не даёт применять', async () => {
    mocks.upload.mockResolvedValue(
      ready({
        status: 'failed',
        errors: [
          { row: 4, column: '05.11.2025', message: '«много» — не число' },
          { row: 1, column: '08.11.2025', message: 'В файле нет колонки' },
        ],
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.upload(screen.getByTestId('places-import-file'), new File(['x'], 'mesta.xlsx'));

    const box = await screen.findByTestId('places-import-errors');
    expect(
      within(box).getByText('Строка 4, колонка 05.11.2025: «много» — не число'),
    ).toBeInTheDocument();
    expect(
      within(box).getByText('Строка 1, колонка 08.11.2025: В файле нет колонки'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('places-import-apply')).toBeDisabled();

    await user.click(screen.getByTestId('places-import-again'));
    expect(screen.getByTestId('places-import-file')).toBeInTheDocument();
    expect(screen.queryByTestId('places-import-errors')).not.toBeInTheDocument();
  });

  it('показывает предупреждения разбора', async () => {
    mocks.upload.mockResolvedValue(
      ready({
        warnings: [{ row: 1, column: 'Итого М+Ж', message: 'считается автоматически и пропущена' }],
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.upload(screen.getByTestId('places-import-file'), new File(['x'], 'mesta.xlsx'));

    const warnings = await screen.findByTestId('places-import-warnings');
    expect(
      within(warnings).getByText(
        'Строка 1, колонка Итого М+Ж: считается автоматически и пропущена',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('places-import-apply')).toBeEnabled();
  });

  it('отклоняет слишком большой файл и файл не .xlsx до отправки', async () => {
    const user = userEvent.setup();
    mocks.upload.mockResolvedValue(ready());
    renderDialog();

    const big = new File(['x'], 'big.xlsx');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(screen.getByTestId('places-import-file'), big);
    expect(screen.getByTestId('places-import-error')).toHaveTextContent('Файл больше 20 МБ');
    expect(mocks.upload).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('places-import-file'), {
      target: { files: [new File(['x'], 'mesta.txt', { type: 'text/plain' })] },
    });
    expect(screen.getByTestId('places-import-error')).toHaveTextContent('Выберите файл .xlsx');
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
