import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ExchangeOptions } from '../../api/client';
import { useExchangePermissions } from '../../auth/exchangePermissions';
import {
  cancelTableImport,
  downloadTableFile,
  importTableFile,
  tableImportStatus,
  TABLE_IMPORT_MAX_BYTES,
} from '../../api/tableExchange';
import type { TableImportJob } from '../../api/tableExchange';
import { Modal, ModalCancelButton } from '../../components/Modal';
import type { DateRange } from '../dashboard/dates';
import styles from './TableExchange.module.css';

const errorText = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';

const rowCount = new Intl.NumberFormat('ru-RU');

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
  const attemptKey = `crm:table-import:${dormitoryId}:${tableKey}`;
  const [jobId, setJobId] = useState(() => sessionStorage.getItem(attemptKey));
  const [waiting, setWaiting] = useState(!!jobId);
  const [progress, setProgress] = useState<TableImportJob['progress']>(null);
  const [statusError, setStatusError] = useState('');
  const [cancelSending, setCancelSending] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const uploading = useRef(false);
  const pendingNotice = useRef<string | null>(null);
  const permissions = useExchangePermissions();
  const canImport =
    permissions.import_enabled && !readOnly && !history && (options.import_enabled ?? true);
  const canExport = permissions.export_enabled && (options.export_enabled ?? true);

  const showResult = useCallback(
    (result: TableImportJob): void => {
      setProgress(result.progress);
      if (result.status === 'pending') {
        setWaiting(true);
        setCancelRequested(result.cancel_requested ?? false);
        return;
      }
      sessionStorage.removeItem(attemptKey);
      setJobId(null);
      setWaiting(false);
      setStatusError('');
      setCancelRequested(false);
      setCancelError('');
      if (result.status === 'cancelled') {
        setFile(null);
        setCancelled(true);
        return;
      }
      if (result.status === 'failed') {
        setError(result.detail || 'Не удалось выполнить импорт.');
        return;
      }
      const notice = result.rows_added
        ? `Импорт завершён. Добавлено строк: ${result.rows_added}.`
        : `Импорт завершён. Добавлено ячеек: ${result.cells_added}.`;
      pendingNotice.current = notice;
      setMessage(notice);
      setFile(null);
    },
    [attemptKey],
  );

  useEffect(() => {
    if (open || !message || pendingNotice.current === null) return;
    const notice = pendingNotice.current;
    pendingNotice.current = null;
    onImported(notice);
  }, [message, onImported, open]);

  useEffect(() => {
    if (!jobId || !waiting || cancelSending || !permissions.import_enabled) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    async function check(id: string): Promise<void> {
      try {
        const result = await tableImportStatus(dormitoryId, tableKey, id, controller.signal);
        if (controller.signal.aborted) return;
        setStatusError('');
        setError('');
        showResult(result);
        if (result.status !== 'pending') return;
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 404) {
          setWaiting(false);
          setError('Задание ещё не найдено. Выберите тот же файл и повторите загрузку.');
          return;
        }
        if (caught instanceof ApiError && caught.status < 500 && caught.status !== 429) {
          setWaiting(false);
          setError(errorText(caught));
          return;
        }
        setStatusError('Связь с сервером прервалась. Проверяем статус импорта повторно…');
      }
      timeout = setTimeout(() => void check(id), 1500);
    }
    void check(jobId);
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [
    dormitoryId,
    tableKey,
    jobId,
    waiting,
    cancelSending,
    permissions.import_enabled,
    showResult,
  ]);

  async function download(action: 'template' | 'export'): Promise<void> {
    if (busy || (action === 'template' ? !canImport : !canExport)) return;
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
    if (!canImport || !file || busy || waiting || uploading.current) return;
    uploading.current = true;
    setBusy(true);
    setError('');
    setProgress(null);
    let submitted = false;
    try {
      await beforeAction();
      const id = jobId ?? crypto.randomUUID();
      sessionStorage.setItem(attemptKey, id);
      setJobId(id);
      submitted = true;
      const result = await importTableFile(dormitoryId, tableKey, file, id, range);
      showResult(result);
    } catch (caught) {
      setError(errorText(caught));
      if (
        submitted &&
        (!(caught instanceof ApiError) || caught.status >= 500 || caught.status === 409)
      ) {
        setStatusError('Проверяем, принял ли сервер файл…');
        setWaiting(true);
      }
    } finally {
      uploading.current = false;
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!jobId || !waiting || cancelSending || cancelRequested) return;
    setCancelSending(true);
    setCancelError('');
    try {
      showResult(await cancelTableImport(dormitoryId, tableKey, jobId));
    } catch (caught) {
      setCancelError(errorText(caught));
    } finally {
      setCancelSending(false);
    }
  }

  if (!canImport && !canExport) return null;
  const finished = Boolean(message) || cancelled;
  const cancelling = cancelSending || cancelRequested;
  const percent = message
    ? 100
    : progress && progress.rows_total > 0
      ? Math.min(99, Math.round((progress.rows_processed / progress.rows_total) * 100))
      : undefined;
  const progressView = (waiting || finished) && (
    <div className={styles.progress} role="status">
      {waiting && (statusError || cancelling || !progress) && (
        <p>{statusError || (cancelling ? 'Отменяем импорт…' : 'Файл принят. Проверяем файл…')}</p>
      )}
      {!cancelled && percent !== undefined && (
        <>
          <p>
            {progress
              ? `Обработано строк: ${rowCount.format(progress.rows_processed)} из ${rowCount.format(progress.rows_total)} · ${percent}%`
              : `${percent}%`}
          </p>
          <progress aria-label="Выполнение импорта" value={percent} max={100} />
        </>
      )}
      {message && <p>{message}</p>}
      {cancelled && <p>Импорт отменён. Данные из файла не сохранены.</p>}
    </div>
  );
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
              setCancelled(false);
              if (!waiting) setProgress(null);
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
      {!open && cancelError && <p role="alert">{cancelError}</p>}
      {!open && progressView}
      {open && canImport && (
        <Modal
          title={`Импорт: ${name}`}
          onClose={() => setOpen(false)}
          closeDisabled={busy || cancelSending}
          testId="table-import-modal"
        >
          <div className={styles.dialog}>
            {!finished && (
              <div className={styles.step}>
                <p>
                  Скачайте актуальный шаблон, заполните лист «Данные» и загрузите файл .xlsx.
                  Сохраняйте названия, порядок и количество столбцов. После изменения таблицы
                  скачайте шаблон заново.
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
            )}
            {!finished && (
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
                    disabled={busy || waiting}
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
            )}
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {cancelError && (
              <p role="alert" className={styles.error}>
                {cancelError}
              </p>
            )}
            {progressView}
            <div className={`dialog-actions ${styles.footer}`}>
              <ModalCancelButton
                type="button"
                className="btn btn--ghost btn--compact"
                disabled={busy || cancelSending}
                onClick={() => setOpen(false)}
              >
                {waiting || finished ? 'Закрыть' : 'Отмена'}
              </ModalCancelButton>
              {waiting && (
                <button
                  type="button"
                  className="btn btn--danger btn--compact"
                  disabled={cancelling || !jobId}
                  onClick={() => void cancel()}
                >
                  Отменить импорт
                </button>
              )}
              {cancelled && (
                <button
                  type="button"
                  className="btn btn--primary btn--compact"
                  onClick={() => setCancelled(false)}
                >
                  Выбрать другой файл
                </button>
              )}
              {!waiting && !finished && (
                <button
                  type="button"
                  className="btn btn--primary btn--compact"
                  disabled={busy || waiting || !file}
                  onClick={() => void upload()}
                >
                  {busy ? 'Загружаем файл…' : 'Добавить данные из файла'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
