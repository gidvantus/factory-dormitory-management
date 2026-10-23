import { useState } from 'react';

import type { Tariff } from '../api/client';
import { Modal } from './Modal';
import { TariffPrice } from './TariffPrice';
import styles from './PurchaseConfirmDialog.module.css';

/** Страница оферты: тот же адрес, что в подвале сайта и на регистрации. */
const OFFER_PATH = '/documents/offer';

interface PurchaseConfirmDialogProps {
  /** Что покупаем: из карточки тарифа, по которой нажали «Купить». */
  tariff: Tariff;
  /** Запрос в пути: окно не закрывается, чтобы не потерять ответ сервера. */
  submitting: boolean;
  /** Отказ сервера: он про отметку, поэтому живёт под чекбоксом. */
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Окно подтверждения покупки тарифа с обязательной отметкой оферты.
 *
 * Согласие — явное действие человека: чекбокс пуст, а «Выставить счёт» погашена
 * до отметки. Клиент отметку не подставляет и не проверяет за сервер: если
 * запрос всё же ушёл без неё, `422` показывается тем же текстом, что требует
 * сервер, — под чекбоксом, а не общим алертом.
 *
 * Окно одно на публичный прайс и кабинет: отличаются только тариф и страница,
 * которая его открыла. Решения магазина улучшений покупаются без отметки и это
 * окно не открывают.
 */
export function PurchaseConfirmDialog({
  tariff,
  submitting,
  error,
  onCancel,
  onConfirm,
}: PurchaseConfirmDialogProps): JSX.Element {
  const [accepted, setAccepted] = useState(false);

  return (
    <Modal
      title={`Покупка тарифа «${tariff.name}»`}
      testId="purchase-confirm"
      onClose={onCancel}
      closeDisabled={submitting}
    >
      <TariffPrice
        label={tariff.price_label}
        className={styles.amount}
        testId="purchase-confirm-amount"
      />

      <div className="field" data-testid="purchase-confirm-offer">
        <label className="field__consent" htmlFor="purchase-offer">
          <input
            className="field__checkbox"
            id="purchase-offer"
            name="offer_accepted"
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'purchase-offer-error' : undefined}
          />
          <span className="field__consent-text">
            Подтверждаю согласие с{' '}
            <a className="field__consent-link" href={OFFER_PATH} target="_blank" rel="noreferrer">
              условиями оферты
            </a>
          </span>
        </label>
        {error ? (
          <p
            className="field__error"
            id="purchase-offer-error"
            role="alert"
            data-testid="purchase-confirm-error"
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="dialog-actions">
        <button
          className="btn btn--ghost btn--compact"
          type="button"
          data-testid="purchase-confirm-cancel"
          disabled={submitting}
          onClick={onCancel}
        >
          Отмена
        </button>
        <button
          className="btn btn--primary btn--compact"
          type="button"
          data-testid="purchase-confirm-submit"
          disabled={!accepted || submitting}
          aria-busy={submitting || undefined}
          onClick={onConfirm}
        >
          {submitting ? 'Выставляем счёт…' : 'Выставить счёт'}
        </button>
      </div>
    </Modal>
  );
}
