import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { Tariff } from '../api/client';
import { Modal } from '../components/Modal';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Workspace.module.css';

const LOAD_ERROR = 'Не удалось загрузить тариф. Проверьте соединение и попробуйте ещё раз.';
const SAVE_ERROR = 'Не удалось сохранить выбор. Проверьте соединение и попробуйте ещё раз.';
const OPTIONS_ERROR = 'Не удалось загрузить прайс. Проверьте соединение и попробуйте ещё раз.';

const EMPTY_NOTICE = 'У организации пока нет тарифа';
const EMPTY_HINT = 'Выберите тариф из прайса — он появится здесь и в обзоре.';
const READONLY_NOTICE = 'Менять тариф может владелец или администратор организации';
const READONLY_EMPTY_HINT = 'Тариф назначит владелец или администратор организации.';

/** Сервер объясняет отказ точнее общего текста: 404 — тариф пропал из прайса. */
function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return fallback;
}

/**
 * Раздел «Тариф»: у организации на виду только её собственный тариф.
 *
 * Публичный прайс целиком — это рабочий инструмент, а не то, что нужно
 * организации каждый день: здесь показывается один выбранный тариф, и он же
 * виден в обзоре. Полный прайс живёт на отдельном адресе
 * `/cabinet/tariffs/catalog`, и ссылка на него есть только у тех, кому сервер
 * вернул `editable=true`.
 *
 * Роль решает сервер: клиент не выводит права из `role` и не показывает кнопки
 * тому, кому они не положены.
 */
export function Tariffs(): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tariff, setTariff] = useState<Tariff | null>(null);
  const [editable, setEditable] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const [choosing, setChoosing] = useState(false);
  const [options, setOptions] = useState<Tariff[]>([]);
  const [optionsStatus, setOptionsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [optionsError, setOptionsError] = useState('');
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .currentTariff(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setTariff(data.tariff);
        setEditable(data.editable);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(actionErrorMessage(error, LOAD_ERROR));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  // Список для выбора — опубликованный прайс: скрытый тариф выбрать нельзя, и
  // сервер отвечает на такую попытку тем же 404, что и на чужой id.
  useEffect(() => {
    if (!choosing) return;
    const controller = new AbortController();
    setOptionsStatus('loading');
    void api
      .tariffs(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setOptions(items);
        setOptionsStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setOptionsError(actionErrorMessage(error, OPTIONS_ERROR));
        setOptionsStatus('error');
      });
    return () => controller.abort();
  }, [choosing, optionsAttempt]);

  function reload(): void {
    setAttempt((value) => value + 1);
  }

  function openChooser(): void {
    setSelectedId(tariff?.id ?? null);
    setFormError('');
    setOptionsAttempt(0);
    setChoosing(true);
  }

  function closeChooser(): void {
    setChoosing(false);
    setFormError('');
  }

  async function save(): Promise<void> {
    if (saving || selectedId === null) return;
    setSaving(true);
    setFormError('');
    try {
      const data = await api.setCurrentTariff(selectedId);
      setTariff(data.tariff);
      setEditable(data.editable);
      setStatus('ready');
      closeChooser();
    } catch (error: unknown) {
      setFormError(actionErrorMessage(error, SAVE_ERROR));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="tariffs-title" data-testid="tariffs-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="tariffs-title" tabIndex={-1}>
            Тариф
          </h1>
          <p className={styles.subtitle}>Тариф вашей организации</p>
        </div>
        {status === 'ready' && editable && (
          <button
            className="btn btn--primary btn--sm"
            type="button"
            data-testid={tariff ? 'tariff-change' : 'tariff-choose'}
            onClick={openChooser}
          >
            {tariff ? 'Сменить тариф' : 'Выбрать тариф'}
          </button>
        )}
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="tariffs-loading">
          Загружаем тариф…
        </p>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="tariffs-error">
          <p>{loadError}</p>
          <button type="button" onClick={reload}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && !editable && (
        <p className={styles['tariffs-readonly']} data-testid="tariffs-readonly">
          {READONLY_NOTICE}
        </p>
      )}

      {status === 'ready' && tariff && (
        <section
          className={styles['table-card']}
          aria-labelledby="tariff-current-title"
          data-testid="tariff-current"
        >
          <div className={styles['table-heading']}>
            <h2 id="tariff-current-title" data-testid="tariff-current-name">
              {tariff.name}
            </h2>
            <span
              className={`${styles.tag} ${tariff.is_visible ? styles['tag--ok'] : styles['tag--wait']}`}
              data-testid="tariff-current-visibility"
              data-visible={String(tariff.is_visible)}
            >
              {tariff.is_visible ? 'Опубликован' : 'Снят с публикации'}
            </span>
          </div>
          <div className={styles['tariff-card']}>
            {tariff.description && (
              <p
                className={styles['tariff-card-description']}
                data-testid="tariff-current-description"
              >
                {tariff.description}
              </p>
            )}
            <p className={styles['tariff-card-price']} data-testid="tariff-current-price">
              {tariff.price_label}
            </p>
            {tariff.unit_label && (
              <p className={styles['muted-cell']} data-testid="tariff-current-unit">
                {tariff.unit_label}
              </p>
            )}
            {editable && (
              <p className={styles['muted-cell']}>
                <Link to="/cabinet/tariffs/catalog" data-testid="tariff-catalog-link">
                  Прайс-лист публичной страницы
                </Link>
              </p>
            )}
          </div>
        </section>
      )}

      {status === 'ready' && !tariff && (
        <div className={styles['empty-state']} data-testid="tariffs-empty">
          <span className={styles['empty-state-icon']}>
            <WorkspaceIcon name="chart" />
          </span>
          <h2>{EMPTY_NOTICE}</h2>
          <p>{editable ? EMPTY_HINT : READONLY_EMPTY_HINT}</p>
        </div>
      )}

      {choosing && (
        <Modal
          title={tariff ? 'Сменить тариф' : 'Выбрать тариф'}
          testId="tariff-modal"
          onClose={closeChooser}
          closeDisabled={saving}
        >
          <div className={styles['organization-form']}>
            {optionsStatus === 'loading' && (
              <p className="field__hint" role="status" data-testid="tariff-choice-loading">
                Загружаем прайс…
              </p>
            )}

            {optionsStatus === 'error' && (
              <div
                className={styles['organization-error']}
                role="alert"
                data-testid="tariff-choice-error"
              >
                <p>{optionsError}</p>
                <button type="button" onClick={() => setOptionsAttempt((value) => value + 1)}>
                  Повторить
                </button>
              </div>
            )}

            {optionsStatus === 'ready' && options.length === 0 && (
              <p className="field__hint" data-testid="tariff-choice-empty">
                В прайсе нет опубликованных тарифов. Добавьте тариф в прайс-листе.
              </p>
            )}

            {optionsStatus === 'ready' && options.length > 0 && (
              <ul className={styles['tariff-choice-list']} aria-label="Опубликованные тарифы">
                {options.map((option) => (
                  <li key={option.id}>
                    <label
                      className={styles['tariff-choice']}
                      htmlFor={`tariff-option-${option.id}`}
                    >
                      <input
                        id={`tariff-option-${option.id}`}
                        data-testid="tariff-option"
                        type="radio"
                        name="tariff-choice"
                        value={option.id}
                        checked={selectedId === option.id}
                        disabled={saving}
                        onChange={() => setSelectedId(option.id)}
                      />
                      <span>
                        <strong>{option.name}</strong>
                        <span className={styles['muted-cell']}> · {option.price_label}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {formError && (
              <p className="alert alert--error" role="alert" data-testid="tariff-form-error">
                {formError}
              </p>
            )}

            <div className={styles['form-actions']}>
              <button
                className="btn btn--primary"
                type="button"
                disabled={saving || selectedId === null}
                data-testid="tariff-save"
                onClick={() => void save()}
              >
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
              <button
                className="btn btn--outline"
                type="button"
                disabled={saving}
                data-testid="tariff-cancel"
                onClick={closeChooser}
              >
                Отмена
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
