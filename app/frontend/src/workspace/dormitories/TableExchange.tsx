import { useState } from 'react';
import { ApiError } from '../../api/client';
import type { ExchangeOptions } from '../../api/client';
import {
  downloadTableFile,
  importTableFile,
  TABLE_IMPORT_MAX_BYTES,
} from '../../api/tableExchange';
import { Modal, ModalCancelButton } from '../../components/Modal';
import type { DateRange } from '../dashboard/dates';
import styles from './TableExchange.module.css';

const errorText = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';

export function TableExchange({
  dormitoryId,
  tableKey,
  name,
  options,
  range,
  readOnly,
  history = false,
  calendar = false,
  restoreImportFocus = false,
  beforeAction,
  onImported,
}: {
  dormitoryId: string;
  tableKey: string;
  name: string;
  options: ExchangeOptions;
  range?: DateRange;
  readOnly: boolean;
  history?: boolean;
  calendar?: boolean;
  restoreImportFocus?: boolean;
  beforeAction: () => Promise<void>;
  onImported: (message: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const canImport = !readOnly && !history && (options.import_enabled ?? true);
  const canExport = options.export_enabled ?? true;

  async function download(action: 'template' | 'export'): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await beforeAction();
      await downloadTableFile(dormitoryId, tableKey, action, range, name);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function upload(): Promise<void> {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      await beforeAction();
      const result = await importTableFile(dormitoryId, tableKey, file, range);
      const notice = result.rows_added
        ? `Импорт завершён. Добавлено строк: ${result.rows_added}.`
        : `Импорт завершён. Добавлено ячеек: ${result.cells_added}.`;
      setMessage(notice);
      setOpen(false);
      setFile(null);
      onImported(notice);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!canImport && !canExport) return null;
  return (
    <div className={styles.container}>
      <div className={styles.actions} aria-label={`Импорт и экспорт: ${name}`}>
        {canImport && (
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={busy}
            autoFocus={restoreImportFocus}
            onClick={() => {
              setError('');
              setMessage('');
              setOpen(true);
            }}
          >
            Импорт из Excel
          </button>
        )}
        {canExport && (
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            disabled={busy}
            onClick={() => void download('export')}
          >
            Экспорт в Excel
          </button>
        )}
      </div>
      {!open && error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {open && (
        <Modal
          title={`Импорт: ${name}`}
          onClose={() => setOpen(false)}
          closeDisabled={busy}
          testId="table-import-modal"
        >
          <div className={styles.dialog}>
            <div className={styles.step}>
              <p>
                Скачайте актуальный шаблон, заполните лист «Данные» и загрузите файл .xlsx.
                Сохраняйте названия, порядок и количество столбцов. После изменения таблицы скачайте
                шаблон заново.
              </p>
              <button
                type="button"
                className={`btn btn--ghost btn--compact ${styles.templateButton}`}
                disabled={busy}
                onClick={() => void download('template')}
              >
                Скачать шаблон
              </button>
            </div>
            <div className={styles.step}>
              <p>
                {calendar
                  ? 'В отчёте и размещении заполняются только пустые ячейки выбранного периода. Подписи и расчётные строки менять нельзя.'
                  : 'Строки из файла добавятся к существующим. Сохранённые записи останутся на месте.'}{' '}
                При ошибке файл отклоняется целиком, без частичного сохранения.
              </p>
              <label>
                Заполненный шаблон
                <input
                  type="file"
                  className="file-input"
                  accept=".xlsx"
                  disabled={busy}
                  onChange={(event) => {
                    const selected = event.target.files?.[0];
                    setFile(null);
                    setError('');
                    if (!selected) return;
                    if (!selected.name.toLowerCase().endsWith('.xlsx')) {
                      setError('Выберите файл .xlsx, заполненный по шаблону.');
                    } else if (selected.size > TABLE_IMPORT_MAX_BYTES) {
                      setError('Размер файла не должен превышать 20 МБ.');
                    } else {
                      setFile(selected);
                    }
                  }}
                />
              </label>
            </div>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <div className={`dialog-actions ${styles.footer}`}>
              <ModalCancelButton
                type="button"
                className="btn btn--ghost btn--compact"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Отмена
              </ModalCancelButton>
              <button
                type="button"
                className="btn btn--primary btn--compact"
                disabled={busy || !file}
                onClick={() => void upload()}
              >
                {busy ? 'Обрабатываем…' : 'Добавить данные из файла'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
