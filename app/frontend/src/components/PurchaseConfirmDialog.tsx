import { useState } from 'react';

import type { Tariff } from '../api/client';
import { Modal } from './Modal';
import { TariffPrice } from './TariffPrice';
import styles from './PurchaseConfirmDialog.module.css';

/** Страница оферты: тот же адрес, что в подвале сайта и на регистрации. */
const OFFER_PATH = '/documents/offer';

/**
 * Отказ `422` «отметки нет» — дословно текст `app/backend/app/offer.py`
 * (`OFFER_ACCEPTANCE_REQUIRED_DETAIL`), который сервер отдаёт в `detail`.
 *
 * Только он живёт под чекбоксом и красит его: у `409` «тариф уже выбран»,
 * `401`, `403` и сбоя сети причина не в галочке, и объявлять её невалидной
 * нельзя — повторная отметка такого отказа не исправит.
 */
const OFFER_ACCEPTANCE_REQUIRED = 'Отметьте согласие с условиями оферты';

interface PurchaseConfirmDialogProps {
  /** Что покупаем: из карточки тарифа, по которой нажали «Купить». */
  tariff: Tariff;
  /** Запрос в пути: окно не закрывается, чтобы не потерять ответ сервера. */
  submitting: boolean;
  /** Отказ сервера как есть: про отметку он или нет, решает само окно. */
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
 * сервер, — под чекбоксом, потому что он про отметку.
 *
 * Отказы другой природы (тариф уже выбран, конец сессии, нет прав, сеть) про
 * галочку ничего не говорят: они показываются отдельным алертом над кнопками, а
 * чекбокс остаётся валидным.
 *
 * Окно одно на публичный прайс: раздел кабинета «Тарифы» удалён в #87, и
 * `/cabinet/tariffs` ведёт на прайс. Решения магазина улучшений покупаются без
 * отметки и это окно не открывают.
 */
export function PurchaseConfirmDialog({
  tariff,
  submitting,
  error,
  onCancel,
  onConfirm,
}: PurchaseConfirmDialogProps): JSX.Element {
  const [accepted, setAccepted] = useState(false);
  // Отказ про отметку против всех остальных: первый красит чекбокс, вторые — нет.
  const offerError = error.includes(OFFER_ACCEPTANCE_REQUIRED) ? error : '';
  const requestError = offerError === '' ? error : '';

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
            aria-invalid={offerError ? true : undefined}
            aria-describedby={offerError ? 'purchase-offer-error' : undefined}
          />
          <span className="field__consent-text">
            Подтверждаю согласие с{' '}
            <a className="field__consent-link" href={OFFER_PATH} target="_blank" rel="noreferrer">
              условиями оферты
            </a>
          </span>
        </label>
        {offerError ? (
          <p
            className="field__error"
            id="purchase-offer-error"
            role="alert"
            data-testid="purchase-confirm-error"
          >
            {offerError}
          </p>
        ) : null}
      </div>

      {/* Отказ не про галочку: отдельный алерт, чекбокс при нём валиден. */}
      {requestError ? (
        <p className="alert alert--error" role="alert" data-testid="purchase-confirm-request-error">
          {requestError}
        </p>
      ) : null}

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
