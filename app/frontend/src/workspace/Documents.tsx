import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { api, ApiError, invoiceActFileUrl, invoiceFileUrl } from '../api/client';
import type { Invoice, InvoiceStatus, UpdatableInvoiceStatus } from '../api/client';
import { useSolutions } from './SolutionsProvider';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Workspace.module.css';

const LOAD_ERROR = 'Не удалось загрузить документы. Проверьте соединение и попробуйте ещё раз.';
const SAVE_ERROR = 'Не удалось изменить статус счёта. Проверьте соединение и попробуйте ещё раз.';

const EMPTY_NOTICE = 'Счетов пока нет';
const EMPTY_HINT = 'Счёт появится здесь после покупки тарифа на странице «Тарифы».';

const PURCHASE_SUCCESS = 'Счёт выставлен. Он появился в списке документов.';

/**
 * Модификатор бейджа по статусу счёта: оплаченный и закрытый — «хорошо», новый
 * ждёт действия, отменённый закрыт. Цвета берутся у существующих `.tag--*`.
 */
const STATUS_CLASSES: Record<InvoiceStatus, string> = {
  new: 'tag--wait',
  paid: 'tag--ok',
  closed: 'tag--ok',
  cancelled: 'tag--out',
};

/** Дата счёта без времени: в строке списка часы только мешают. */
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
}

/** Сервер объясняет отказ точнее общего текста. */
function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return LOAD_ERROR;
}

/** Текст отказа при смене статуса: 409 «так нельзя» объясняет сервер. */
function statusErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return SAVE_ERROR;
}

/** Флаг успешной покупки приходит состоянием перехода с `/pricing`. */
function purchasedFlag(state: unknown): boolean {
  return (
    !!state && typeof state === 'object' && (state as { purchased?: unknown }).purchased === true
  );
}

/**
 * Раздел «Документы»: счета организации, их статусы и файлы.
 *
 * Раздел работает и на закрытом пробном периоде — поэтому он не перечислен в
 * `CLOSED_SECTIONS` кабинета: счёт выставляется именно тогда, когда кабинет
 * закрыт и его нужно открыть оплатой.
 *
 * Оплата здесь же меняет права организации: счёт за решение при оплате выдаёт
 * или продлевает право (`app/solutions.py`). Признак владения держит оболочка
 * кабинета (`SolutionsProvider`), которая читает каталог один раз, — поэтому
 * успешная оплата обязана попросить её перечитать каталог. Иначе право уже
 * действует на сервере, а метка «Подключено» и пункт «Уведомления» не появятся
 * до перезагрузки: переход по меню — клиентский, оболочка не перемонтируется.
 *
 * Скачивание идёт обычной ссылкой `href`, а не `fetch`: ответ — файл вложением,
 * и браузер открывает его сам. Управа на статус спрашивается у сервера
 * (`can_manage`): роль без права правки видит те же счета, но без кнопок — иначе
 * правило ролей пришлось бы держать второй копией на клиенте.
 */
export function Documents(): JSX.Element {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [acting, setActing] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const location = useLocation();
  const purchased = purchasedFlag(location.state);
  // Права организации: их перечитывают после оплаты — см. докстринг выше.
  const { reload: reloadSolutions } = useSolutions();

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .invoices(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setInvoices(value);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(loadErrorMessage(error));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  async function changeStatus(invoice: Invoice, next: UpdatableInvoiceStatus): Promise<void> {
    if (acting !== null) return;
    setActing(invoice.id);
    setActionError('');
    try {
      const updated = await api.setInvoiceStatus(invoice.id, next);
      setInvoices((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      // Переход в `paid` — единственная смена статуса, которая выдаёт право:
      // закрытие и отмена счёта права не трогают, и лишний запрос им ни к чему.
      if (next === 'paid') reloadSolutions();
    } catch (error) {
      setActionError(statusErrorMessage(error));
    } finally {
      setActing(null);
    }
  }

  return (
    <section aria-labelledby="documents-title" data-testid="documents-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="documents-title" tabIndex={-1}>
            Документы
          </h1>
          <p className={styles.subtitle}>Счета и акты вашей организации</p>
        </div>
      </div>

      {purchased && (
        <p className="alert alert--ok" role="status" data-testid="documents-purchase-success">
          {PURCHASE_SUCCESS}
        </p>
      )}

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="documents-loading">
          Загружаем документы…
        </p>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="documents-error">
          <p>{loadError}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </div>
      )}

      {actionError && (
        <p className="alert alert--error" role="alert" data-testid="documents-action-error">
          {actionError}
        </p>
      )}

      {status === 'ready' && invoices.length === 0 && (
        <div className={styles['empty-state']} data-testid="documents-empty">
          <span className={styles['empty-state-icon']}>
            <WorkspaceIcon name="document" />
          </span>
          <h2>{EMPTY_NOTICE}</h2>
          <p>{EMPTY_HINT}</p>
          <Link className="btn btn--primary btn--sm" to="/pricing">
            К тарифам
          </Link>
        </div>
      )}

      {status === 'ready' && invoices.length > 0 && (
        <section
          className={styles['table-card']}
          aria-labelledby="documents-table-title"
          data-testid="documents-table"
        >
          <div className={styles['table-heading']}>
            <h2 id="documents-table-title">Счета</h2>
            <span className={styles['table-meta']}>Файлы скачиваются отдельными документами</span>
          </div>
          <div className={styles['table-scroll']}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Номер</th>
                  <th scope="col">Дата</th>
                  {/* «Предмет» — потому что в счёте за решение в этой колонке
                      стоит название решения, а `tariff_name` — историческое имя
                      колонки снимка. */}
                  <th scope="col">Предмет</th>
                  <th scope="col">Сумма</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Документы</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id} data-testid="documents-row">
                    <td data-testid="document-number">{invoice.number}</td>
                    <td data-testid="document-date">{formatDate(invoice.created_at)}</td>
                    <td data-testid="document-tariff">{invoice.tariff_name ?? '—'}</td>
                    <td data-testid="document-amount">{invoice.amount_label}</td>
                    <td>
                      <span
                        className={`${styles.tag} ${styles[STATUS_CLASSES[invoice.status]]}`}
                        data-testid="document-status"
                      >
                        {invoice.status_label}
                      </span>
                    </td>
                    <td>
                      {/* Действия столбиком: в строке ссылки шли вплотную и
                          читались одной фразой. */}
                      <div className={styles['document-actions']} data-testid="document-actions">
                        <a
                          className="link-button"
                          href={invoiceFileUrl(invoice.id)}
                          data-testid="document-download"
                        >
                          Скачать счёт
                        </a>
                        {invoice.has_act && (
                          <a
                            className="link-button"
                            href={invoiceActFileUrl(invoice.id)}
                            data-testid="document-act"
                          >
                            Скачать акт
                          </a>
                        )}
                        {invoice.can_manage && invoice.status === 'new' && (
                          <>
                            <button
                              type="button"
                              className="link-button"
                              disabled={acting === invoice.id}
                              data-testid="document-status-paid"
                              onClick={() => void changeStatus(invoice, 'paid')}
                            >
                              Оплатить
                            </button>
                            <button
                              type="button"
                              className="link-button"
                              disabled={acting === invoice.id}
                              data-testid="document-status-cancel"
                              onClick={() => void changeStatus(invoice, 'cancelled')}
                            >
                              Отменить
                            </button>
                          </>
                        )}
                        {invoice.can_manage && invoice.status === 'paid' && (
                          <button
                            type="button"
                            className="link-button"
                            disabled={acting === invoice.id}
                            data-testid="document-status-close"
                            onClick={() => void changeStatus(invoice, 'closed')}
                          >
                            Закрыть
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
