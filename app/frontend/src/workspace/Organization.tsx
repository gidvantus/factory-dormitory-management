import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../api/client';
import type { Organization as OrganizationRecord } from '../api/client';
import styles from './Workspace.module.css';

/** Подпись вместо пустого поля: null означает незаполненную организацию. */
export const EMPTY_ORGANIZATION_NAME = 'Без названия';

/**
 * Страница организации: название и ИНН.
 *
 * Формат ИНН проверяет сервер, а не клиент: у организации 10 цифр, у
 * индивидуального предпринимателя 12, и дублировать это правило здесь
 * означало бы держать две версии одного контракта. Текст ответа сервера
 * (409 и 422) показывается как есть — пользователь должен видеть, что именно
 * не так, а не общее «что-то пошло не так».
 */
export function Organization(): JSX.Element {
  const [record, setRecord] = useState<OrganizationRecord | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [inn, setInn] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [saveError, setSaveError] = useState('');
  const inFlight = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const innRef = useRef<HTMLInputElement>(null);
  // Куда вернуть фокус, когда сохранение закончится. Пока идёт запрос, кнопка
  // «Сохранить» задизейблена и фокус с неё слетает на `<body>`; без этого
  // возврата пользователь клавиатуры теряет место на странице.
  const focusAfterSave = useRef<'name' | 'inn' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .organization(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setRecord(value);
        setName(value.name ?? '');
        setInn(value.inn ?? '');
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // 404 — пользователь не привязан к организации: это не сбой загрузки,
        // и форма здесь не поможет, поэтому состояние отдельное.
        setStatus(error instanceof ApiError && error.status === 404 ? 'forbidden' : 'error');
      });
    return () => controller.abort();
  }, [attempt]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaved('');
    setSaveError('');
    try {
      const updated = await api.saveOrganization({ name, inn });
      setRecord(updated);
      setName(updated.name ?? '');
      setInn(updated.inn ?? '');
      setSaved('Изменения сохранены.');
      // Успех: возвращаем фокус на первое поле формы, чтобы не отдавать его `<body>`.
      focusAfterSave.current = 'name';
    } catch (error) {
      setSaveError(saveErrorMessage(error));
      focusAfterSave.current = fieldForError(error);
    } finally {
      inFlight.current = false;
      setSaving(false);
      const target = focusAfterSave.current;
      focusAfterSave.current = null;
      // Кадр нужен потому, что сразу после `setSaving(false)` поля ещё
      // задизейблены, а задизейбленный элемент фокус не принимает.
      window.requestAnimationFrame(() => {
        const field = target === 'inn' ? innRef.current : nameRef.current;
        field?.focus({ preventScroll: true });
      });
    }
  }

  return (
    <section aria-labelledby="organization-title" data-testid="organization-page">
      <div className="page-head">
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="organization-title" tabIndex={-1}>
            Организация
          </h1>
          <p className={styles.subtitle}>Название и ИНН вашей организации</p>
        </div>
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="organization-loading">
          Загружаем данные организации…
        </p>
      )}

      {status === 'forbidden' && (
        <section
          className={styles['profile-card']}
          aria-labelledby="organization-forbidden-title"
          data-testid="organization-not-linked"
        >
          <div className={styles['profile-intro']}>
            <div>
              <h2 id="organization-forbidden-title">Организация не привязана</h2>
              <p>Ваша учётная запись не привязана к организации.</p>
            </div>
          </div>
        </section>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="organization-error">
          <p>Не удалось загрузить данные организации.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && (
        <section
          className={styles['profile-card']}
          aria-labelledby="organization-card-title"
          data-testid="organization-card"
        >
          <div className={styles['profile-intro']}>
            <div>
              <h2 id="organization-card-title">{record?.name ?? EMPTY_ORGANIZATION_NAME}</h2>
              <p>Данные можно изменить в любой момент.</p>
            </div>
          </div>
          <form
            className={styles['organization-form']}
            noValidate
            aria-busy={saving}
            onSubmit={(event) => void submit(event)}
          >
            <div className="field">
              <label className="field__label" htmlFor="organization-name">
                Название организации
              </label>
              <input
                className="field__input"
                id="organization-name"
                data-testid="organization-name"
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
                disabled={saving}
                placeholder="Например, ООО «Ромашка»"
                aria-describedby="organization-name-hint"
              />
              <p className={styles['organization-hint']} id="organization-name-hint">
                Название обязательно. Пустым оно быть не может.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="organization-inn">
                ИНН
              </label>
              <input
                className="field__input"
                id="organization-inn"
                data-testid="organization-inn"
                ref={innRef}
                value={inn}
                onChange={(event) => setInn(event.target.value)}
                inputMode="numeric"
                disabled={saving}
                placeholder="10 или 12 цифр"
                aria-describedby="organization-inn-hint"
              />
              <p className={styles['organization-hint']} id="organization-inn-hint">
                10 цифр у организации, 12 — у индивидуального предпринимателя. Пустое поле очищает
                ИНН.
              </p>
            </div>

            {saved && (
              <p className="alert alert--ok" role="status" data-testid="organization-save-success">
                {saved}
              </p>
            )}
            {saveError && (
              <p className="alert alert--error" role="alert" data-testid="organization-save-error">
                {saveError}
              </p>
            )}

            <button
              className="btn btn--primary"
              type="submit"
              disabled={saving}
              data-testid="organization-submit"
            >
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </form>
        </section>
      )}
    </section>
  );
}

/** 401 — это конец сессии, а не отказ валидации: текст должен отличаться. */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return 'Не удалось сохранить изменения. Проверьте соединение и попробуйте ещё раз.';
}

/**
 * Куда вернуть фокус при ошибке сохранения.
 *
 * Поле определяется по имени в тексте сервера (`inn: …`, `name: …`), а не по
 * префиксу строки: сообщение 409 начинается со слова «Организация», хотя
 * касается именно ИНН, и по префиксу фокус уехал бы не туда. Если поле не
 * названо, возвращаемся на первое — там начинается форма.
 */
function fieldForError(error: unknown): 'name' | 'inn' {
  if (error instanceof ApiError && /(?:^|[\s;])inn\s*:/i.test(error.message)) {
    return 'inn';
  }
  return 'name';
}
