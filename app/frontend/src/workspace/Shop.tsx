import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import { ShopSolutionCard } from './ShopSolutionCard';
import { useSolutions } from './SolutionsProvider';
import styles from './Workspace.module.css';
import shopStyles from './Shop.module.css';

const LOAD_ERROR = 'Не удалось загрузить магазин. Проверьте соединение и попробуйте ещё раз.';
const PURCHASE_ERROR = 'Не удалось выставить счёт. Проверьте соединение и попробуйте ещё раз.';
const EMPTY_NOTICE = 'Решения ещё не опубликованы';

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
 * Оформление «01 Витрина»: описание и пример решения над строкой покупки.
 * Цена приходит строкой с сервера (`price_label`), клиент её не считает.
 * Кнопка покупки у уже подключённого решения доступна для продления.
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
          <p className={styles.eyebrow}>Больше возможностей для вашей команды</p>
          <h1 id="shop-title" tabIndex={-1}>
            Магазин улучшений
          </h1>
          <p className={styles.subtitle}>Дополнительные решения — отдельно от тарифа</p>
        </div>
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="shop-loading">
          Загружаем решения…
        </p>
      )}

      {status === 'error' && (
        <div className={shopStyles.error} role="alert" data-testid="shop-error">
          <p>{LOAD_ERROR}</p>
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            data-testid="shop-retry"
            onClick={reload}
          >
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && items.length === 0 && (
        <p className={styles['view-note']} data-testid="shop-empty">
          {EMPTY_NOTICE}
        </p>
      )}

      {status === 'ready' && items.length > 0 && (
        <ul className={shopStyles.catalog}>
          {items.map((solution) => (
            <li key={solution.id}>
              <ShopSolutionCard
                solution={solution}
                buying={buying}
                onBuy={(id) => void buySolution(id)}
              />
            </li>
          ))}
        </ul>
      )}

      {buyError && (
        <p className={shopStyles.purchaseError} role="alert" data-testid="shop-buy-error">
          {buyError}
        </p>
      )}
    </section>
  );
}
