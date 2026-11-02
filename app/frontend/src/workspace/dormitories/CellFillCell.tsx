import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../api/client';
import type { CellFillRecord, CellFillRow, TableColumn } from '../../api/client';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { useColumns } from './tableColumnsContext';
import s from './CellFill.module.css';

export function CellFillCell({
  column,
  row,
  readOnly,
}: {
  column: TableColumn;
  row: CellFillRow;
  readOnly: boolean;
}): JSX.Element {
  const context = useColumns();
  const { dormitoryId, table, trackSave, waitForRowSaves } = context;
  const data = context.fillRows?.[row.id] ?? row;
  const value = data.fill_values?.[column.id];
  const error = data.fill_errors?.[column.id];
  const config = column.fill!;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [records, setRecords] = useState<CellFillRecord[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setFailure('');
    const timer = window.setTimeout(
      () => {
        void api
          .cellFillRecords(dormitoryId, config.source, config.field, search, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted) {
              setRecords(result.records);
              setMore(result.has_more);
              setLoading(false);
            }
          })
          .catch((caught: unknown) => {
            if (!controller.signal.aborted) {
              setLoading(false);
              setFailure(
                caught instanceof ApiError ? caught.message : 'Не удалось загрузить записи.',
              );
            }
          });
      },
      search ? 200 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, dormitoryId, config.source, config.field, search, attempt]);

  async function select(recordId: string | null): Promise<void> {
    if (saving || readOnly) return;
    setSaving(true);
    setFailure('');
    try {
      await waitForRowSaves(row.id, `${row.id}:fill-${column.id}`);
      const result = await trackSave(
        `${row.id}:fill-${column.id}`,
        api.selectCellRecord(dormitoryId, table, row.id, column.id, recordId),
      );
      context.fillSaved?.(result);
      setOpen(false);
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'Не удалось выбрать запись.');
    } finally {
      setSaving(false);
    }
  }
  const label = `${column.name}, строка ${row.id}`;
  const formatted =
    value == null || value === ''
      ? '—'
      : typeof value === 'boolean'
        ? value
          ? 'Да'
          : 'Нет'
        : column.kind === 'date'
          ? String(value).split('-').reverse().join('.')
          : String(value);
  return (
    <div className={s.cell}>
      {config.mode === 'pick' ? (
        <button
          type="button"
          className={`btn btn--outline btn--compact ${s.selectRecord}`}
          disabled={readOnly || saving}
          aria-label={`Выбрать запись: ${label}`}
          onClick={() => {
            setOpen(true);
            setSearch('');
            setFailure('');
          }}
        >
          <span aria-hidden="true">↗</span>
          {value == null ? 'Выберите запись' : formatted}
        </button>
      ) : (
        <span
          className={s.value}
          aria-label={label}
          title={config.update === 'copy' ? 'Разовая копия' : 'Данные из таблицы-источника'}
        >
          <span aria-hidden="true">↗</span>
          {formatted}
        </span>
      )}
      {error && (
        <small className={s.error} role="alert">
          {error}
        </small>
      )}
      {!open && failure && (
        <small role="alert" className={s.error}>
          {failure}
        </small>
      )}
      {/* Окно вне таблицы: стили её ячеек не должны менять поиск и список записей. */}
      {open &&
        createPortal(
          <Modal
            title={`Выбрать запись: ${column.name}`}
            testId={`fill-record-${row.id}-${column.id}`}
            onClose={() => setOpen(false)}
            closeDisabled={saving}
            protectChanges={false}
          >
            <label className={s.searchLabel}>
              Найти запись
              <input
                className={s.search}
                type="search"
                maxLength={200}
                value={search}
                disabled={saving}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Имя, табельный номер или номер записи"
              />
            </label>
            {loading ? (
              <p role="status">Загружаем записи…</p>
            ) : (
              <div className={s.results}>
                {records.map((record) => (
                  <button
                    className={`btn btn--choice btn--compact ${s.recordOption}`}
                    key={record.id}
                    type="button"
                    disabled={saving}
                    aria-pressed={
                      data.fill_selections?.[column.id]?.source === config.source &&
                      data.fill_selections?.[column.id]?.record_id === record.id
                    }
                    onClick={() => void select(record.id)}
                  >
                    <strong>{record.label}</strong>
                    <small>{record.detail}</small>
                  </button>
                ))}
              </div>
            )}
            {!loading && !failure && !records.length && (
              <p className={s.help}>
                {search
                  ? 'Ничего не найдено. Измените запрос.'
                  : 'В таблице-источнике пока нет записей.'}
              </p>
            )}
            {more && !loading && <p className={s.help}>Показаны первые записи. Уточните поиск.</p>}
            {failure && (
              <p role="alert" className={s.error}>
                {failure}{' '}
                <button
                  type="button"
                  className="link-button"
                  disabled={saving}
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Повторить
                </button>
              </p>
            )}
            <div className={`dialog-actions ${s.actions}`}>
              <ModalCancelButton
                className="btn btn--ghost btn--compact"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                Отмена
              </ModalCancelButton>
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                disabled={saving || data.fill_selections?.[column.id]?.source !== config.source}
                aria-busy={saving}
                onClick={() => void select(null)}
              >
                {saving ? 'Сохраняем…' : 'Очистить выбор'}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
}
