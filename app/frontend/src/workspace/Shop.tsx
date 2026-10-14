import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { Solution } from '../api/client';
import { useSolutions } from './SolutionsProvider';
import styles from './Workspace.module.css';

const LOAD_ERROR = 'Не удалось загрузить магазин. Проверьте соединение и попробуйте ещё раз.';
const PURCHASE_ERROR = 'Не удалось выставить счёт. Проверьте соединение и попробуйте ещё раз.';
const EMPTY_NOTICE = 'Решения ещё не опубликованы';

/**
 * Подпись срока права. `expires_at = null` — бессрочное право (`period = 'once'`),
 * а не «срок не задан»: поэтому у него своя формулировка, а не пустая дата.
 */
function expiryLabel(solution: Solution): string {
  if (!solution.expires_at) return 'Действует бессрочно';
  const date = new Date(solution.expires_at);
  if (Number.isNaN(date.getTime())) return `Действует до ${solution.expires_at}`;
  return `Действует до ${date.toLocaleDateString('ru-RU')}`;
}

/** Текст отказа покупки: 401 — конец сессии, остальное объясняет сервер. */
function purchaseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return PURCHASE_ERROR;
}

/**
 * Раздел «Магазин улучшений»: список решений и покупка решения на период.
 *
 * Раздел открыт всегда — как «Тариф» и «Документы», — и в `CLOSED_SECTIONS` не
 * входит: покупка нужна именно на закрытом пробном кабинете, когда кабинет и
 * открывается оплатой.
 *
 * Вид списка повторяет прайс: те же глобальные классы `pricing__*`, тот же
 * порядок «название — цена — описание — кнопка». Цена приходит строкой с
 * сервера (`price_label`), клиент её не считает. Кнопка покупки у уже
 * подключённого решения остаётся доступной — это продление.
 */
export function Shop(): JSX.Element {
  const { status, items, reload } = useSolutions();
  const [buying, setBuying] = useState<number | null>(null);
  const [buyError, setBuyError] = useState('');
  const navigate = useNavigate();

  /**
   * «Купить» заводит организации счёт за выбранное решение и уводит в
   * «Документы»: именно там виден выставленный счёт и кнопка оплаты.
   *
   * Каталог перечитывается после покупки: право появляется только оплатой, но
   * счёт мог быть уже оплачен на другом устройстве, и признак владения не
   * должен остаться прошлым.
   */
  async function buySolution(solutionId: number): Promise<void> {
    if (buying !== null) return;
    setBuying(solutionId);
    setBuyError('');
    try {
      await api.purchaseInvoice({ solution_id: solutionId });
      reload();
      navigate('/cabinet/documents', { state: { purchased: true } });
    } catch (caught: unknown) {
      setBuyError(purchaseErrorMessage(caught));
      setBuying(null);
    }
  }

  return (
    <section aria-labelledby="shop-title" data-testid="shop-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="shop-title" tabIndex={-1}>
            Магазин улучшений
          </h1>
          <p className={styles.subtitle}>Дополнительные решения — отдельно от тарифа</p>
        </div>
      </div>

      {status === 'loading' && (
        <p className="pricing__note" role="status" data-testid="shop-loading">
          Загружаем решения…
        </p>
      )}

      {status === 'error' && (
        <div className="pricing__error" role="alert" data-testid="shop-error">
          <p>{LOAD_ERROR}</p>
          <button
            className="btn btn--outline btn--sm"
            type="button"
            data-testid="shop-retry"
            onClick={reload}
          >
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && items.length === 0 && (
        <p className="pricing__note" data-testid="shop-empty">
          {EMPTY_NOTICE}
        </p>
      )}

      {status === 'ready' && items.length > 0 && (
        <ul className="pricing__grid">
          {items.map((solution) => (
            <li
              className={
                solution.is_owned ? 'card pricing__card pricing__card--owned' : 'card pricing__card'
              }
              key={solution.id}
              data-testid="solution-card"
              data-owned={solution.is_owned ? 'true' : undefined}
            >
              <div className="pricing__card-head">
                <h3 data-testid="solution-name">{solution.name}</h3>
                {/* Право помечается здесь же, в списке: отдельного блока про
                    купленное решение на странице нет. */}
                {solution.is_owned && (
                  <span className="tag tag--ok" data-testid="solution-owned">
                    Подключено
                  </span>
                )}
              </div>
              {/* Цену собирает сервер: карточка показывает `price_label` как есть. */}
              <p className="pricing__price" data-testid="solution-price">
                {solution.price_label}
              </p>
              <p className="pricing__description" data-testid="solution-description">
                {solution.description}
              </p>
              {solution.is_owned && (
                <p className="pricing__note" data-testid="solution-expiry">
                  {expiryLabel(solution)}
                </p>
              )}
              <button
                className="btn btn--primary btn--block"
                type="button"
                data-testid="solution-buy"
                // Доступное имя не сводится к «Купить»: на странице несколько
                // кнопок с одинаковым текстом, и без названия решения они
                // неразличимы для скринридера.
                aria-label={`Купить: ${solution.name}`}
                disabled={buying !== null}
                onClick={() => void buySolution(solution.id)}
              >
                Купить
              </button>
            </li>
          ))}
        </ul>
      )}

      {buyError && (
        <p className="pricing__error" role="alert" data-testid="shop-buy-error">
          {buyError}
        </p>
      )}
    </section>
  );
}
