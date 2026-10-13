import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import {
  ApiError,
  PLACES_IMPORT_MAX_BYTES,
  confirmPlacesImport,
  placesImportTemplateUrl,
  uploadPlacesImport,
} from '../../api/client';
import type { PlacesImportApplied, PlacesImportIssue, PlacesImportResult } from '../../api/client';
import { Modal } from '../../components/Modal';
import styles from './ImportPlacesDialog.module.css';

interface Props {
  dormitoryId: string;
  /** Выбранный месяц вкладки в формате `ГГГГ-ММ`: за него скачивается шаблон. */
  month: string;
  onClose: () => void;
  /** Импорт применён: таблица «Размещение персонала» перезагружается. */
  onImported: () => void;
}

type Stage = 'choose' | 'uploading' | 'parsing' | 'result' | 'applying' | 'done';

const MAX_MB = Math.round(PLACES_IMPORT_MAX_BYTES / (1024 * 1024));

function monthTitle(month: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

/** «Строка 4, колонка 05.11.2025: …» — так ошибку видно в самом файле. */
function issueText(issue: PlacesImportIssue): string {
  const place = [
    issue.row ? `Строка ${issue.row}` : '',
    issue.column ? `колонка ${issue.column}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return place ? `${place}: ${issue.message}` : issue.message;
}

/**
 * Три шага в одном окне: выбор файла, прогресс выгрузки и подтверждение.
 *
 * Разбор идёт на сервере одним запросом, поэтому между шагами одного файла
 * ничего не сохраняется: «Применить» отправляет только номер задания разбора.
 */
export function ImportPlacesDialog({
  dormitoryId,
  month,
  onClose,
  onImported,
}: Props): JSX.Element {
  const [stage, setStage] = useState<Stage>('choose');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<PlacesImportResult | null>(null);
  const [applied, setApplied] = useState<PlacesImportApplied | null>(null);
  const [error, setError] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  const busy = stage === 'uploading' || stage === 'parsing' || stage === 'applying';

  useEffect(() => {
    if (stage === 'result') resultRef.current?.focus();
  }, [stage]);

  async function send(file: File): Promise<void> {
    setError('');
    setResult(null);
    setProgress(0);
    setStage('uploading');
    try {
      const parsed = await uploadPlacesImport(dormitoryId, file, setProgress, () =>
        setStage('parsing'),
      );
      setResult(parsed);
      setStage('result');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить файл.');
      setStage('choose');
    }
  }

  function choose(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Выберите файл .xlsx — шаблон «Размещение персонала».');
      return;
    }
    if (file.size > PLACES_IMPORT_MAX_BYTES) {
      setError(`Файл больше ${MAX_MB} МБ — уменьшите его и попробуйте снова.`);
      return;
    }
    setError('');
    void send(file);
  }

  async function apply(): Promise<void> {
    if (result === null || result.status !== 'ready') return;
    setError('');
    setStage('applying');
    try {
      const done = await confirmPlacesImport(dormitoryId, result.import_id);
      setApplied(done);
      setStage('done');
      onImported();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось применить импорт.');
      setStage('result');
    }
  }

  function again(): void {
    setError('');
    setResult(null);
    setApplied(null);
    setProgress(0);
    setStage('choose');
  }

  return (
    <Modal
      title="Импорт из Excel"
      testId="places-import-modal"
      onClose={onClose}
      closeDisabled={busy}
    >
      {stage !== 'result' && stage !== 'applying' && stage !== 'done' && (
        <>
          <p className={styles.hint}>
            Скачайте шаблон, заполните и загрузите. Импорт заменяет месяц из файла целиком, а пустая
            ячейка удаляет значение.
          </p>
          <a
            className="btn btn--ghost btn--compact"
            data-testid="places-import-download-template"
            href={placesImportTemplateUrl(dormitoryId, month)}
            download
          >
            Скачать шаблон за месяц
          </a>
          <label className={styles.fileField}>
            Файл шаблона (.xlsx), не больше {MAX_MB} МБ
            <input
              type="file"
              accept=".xlsx"
              data-testid="places-import-file"
              onChange={choose}
              disabled={busy}
            />
          </label>
        </>
      )}

      {stage === 'uploading' && (
        <div className={styles.progress}>
          <p role="status">Загружаем файл: {progress} %</p>
          <progress
            className={styles.progressBar}
            data-testid="places-import-progress"
            aria-label="Выгрузка файла"
            value={progress}
            max={100}
          />
        </div>
      )}
      {(stage === 'parsing' || stage === 'applying') && (
        <p role="status" data-testid="places-import-parsing">
          {stage === 'parsing' ? 'Разбираем файл…' : 'Применяем импорт…'}
        </p>
      )}

      {error && (
        <p role="alert" className={styles.error} data-testid="places-import-error">
          {error}
        </p>
      )}

      {(stage === 'result' || stage === 'applying') && result !== null && (
        <div className={styles.result} ref={resultRef} tabIndex={-1}>
          <p>Месяц: {monthTitle(result.months[0] ?? month)}</p>
          {result.errors.length > 0 ? (
            <div data-testid="places-import-errors">
              <p className={styles.error}>
                Файл не применён. Исправьте ошибки и загрузите его снова.
              </p>
              <ul className={styles.issues}>
                {result.errors.map((issue, index) => (
                  <li key={index}>{issueText(issue)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <ul className={styles.summary}>
                <li>Хостелов в файле: {result.counts.hostels}</li>
                <li>Будет записано значений: {result.counts.cells}</li>
                <li>Будет удалено значений: {result.counts.deleted}</li>
              </ul>
              {result.warnings.length > 0 && (
                <div data-testid="places-import-warnings" className={styles.warnings}>
                  <p>Предупреждения:</p>
                  <ul className={styles.issues}>
                    {result.warnings.map((issue, index) => (
                      <li key={index}>{issueText(issue)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              data-testid="places-import-again"
              onClick={again}
              disabled={busy}
            >
              Загрузить другой файл
            </button>
            <button
              type="button"
              className="btn btn--primary btn--compact"
              data-testid="places-import-apply"
              onClick={() => void apply()}
              aria-busy={stage === 'applying'}
              disabled={result.status !== 'ready' || busy}
            >
              Применить импорт
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applied !== null && (
        <div data-testid="places-import-applied" className={styles.result}>
          <p role="status">
            Импорт применён: значений — {applied.cells}, хостелов — {applied.hostels}, месяц —{' '}
            {monthTitle(applied.month)}.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn--primary btn--compact" onClick={onClose}>
              Готово
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
