import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../api/client';
import type { Organization as OrganizationRecord } from '../api/client';
import styles from './Workspace.module.css';

/** Подпись вместо пустого поля: null означает незаполненную организацию. */
export const EMPTY_ORGANIZATION_NAME = 'Без названия';

/** Сколько цифр бывает в ИНН: 10 у организации, 12 у предпринимателя. */
const INN_LENGTHS = [10, 12];

export const LOOKUP_SEARCHING_TEXT = 'Ищем организацию…';
export const LOOKUP_NOT_FOUND_TEXT = 'По этому ИНН ничего не найдено';
export const LOOKUP_UNAVAILABLE_TEXT =
  'Сервис проверки недоступен. Проверьте ИНН и попробуйте снова.';
/** ИНН уже есть в базе у другой организации: ИНН уникален, сохранить его нельзя. */
export const LOOKUP_INN_TAKEN_TEXT = 'Этот ИНН уже занят другой организацией. Укажите другой ИНН.';

/** Вердикт поиска. `idle` — по текущему значению поиска ещё не было. */
type LookupVerdict = 'idle' | 'searching' | 'found' | 'not_found' | 'unavailable' | 'taken';

/**
 * Вердикт поиска вместе с ИНН, к которому он относится.
 *
 * Поле ИНН остаётся редактируемым и после ответа сервера, поэтому вердикт
 * хранится парой: «занято» относится к конкретному номеру, и правка поля
 * снимает его сама собой, без ручного сброса состояния.
 */
interface LookupState {
  verdict: LookupVerdict;
  inn: string;
}

const IDLE_LOOKUP: LookupState = { verdict: 'idle', inn: '' };

/**
 * Страница организации: редактируется только ИНН.
 *
 * Название, КПП, ОГРН и адрес регистрации приходят из DaData по введённому ИНН
 * и хранятся на сервере; руками они не правятся, поэтому в форме это
 * задизейбленные поля. Название обязательно на сервере, и заполняет его тоже
 * поиск: пустая заготовка организации без названия остаётся допустимой.
 *
 * Поиск идёт по `blur` и `Enter`, а не на каждую цифру: запрос к внешнему
 * сервису на каждый символ — это лишняя нагрузка и мигающий статус. Повторный
 * запрос с тем же ИНН не уходит, а предыдущий отменяется через `AbortController`.
 * Пока идёт поиск, поля и кнопка «Сохранить» заблокированы: сохранять
 * недозаполненные реквизиты нельзя, а после ответа они снова доступны.
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
  const [kpp, setKpp] = useState('');
  const [ogrn, setOgrn] = useState('');
  const [address, setAddress] = useState('');
  const [lookup, setLookup] = useState<LookupState>(IDLE_LOOKUP);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [saveError, setSaveError] = useState('');
  const inFlight = useRef(false);
  const innRef = useRef<HTMLInputElement>(null);
  // Куда вернуть фокус, когда сохранение закончится. Пока идёт запрос, кнопка
  // «Сохранить» задизейблена и фокус с неё слетает на `<body>`; без этого
  // возврата пользователь клавиатуры теряет место на странице.
  const restoreFocus = useRef(false);
  // Отмена предыдущего поиска: его ответ уже некуда класть.
  const lookupController = useRef<AbortController | null>(null);

  // Вердикт относится к конкретному ИНН: после правки поля он устаревает сам.
  const verdict = lookup.inn === inn ? lookup.verdict : 'idle';
  const searching = verdict === 'searching';
  const innTaken = verdict === 'taken';

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
        setKpp(value.kpp ?? '');
        setOgrn(value.ogrn ?? '');
        setAddress(value.address ?? '');
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

  // Уход со страницы отменяет незавершённый поиск: ответ уже некуда класть.
  useEffect(() => () => lookupController.current?.abort(), []);

  /**
   * Поиск реквизитов по введённому ИНН.
   *
   * Уходит только для 10 или 12 цифр: на неполном ИНН сервер ответил бы 422, а
   * пользователь увидел бы ошибку там, где он ещё просто не допечатал номер.
   */
  function runLookup(): void {
    const digits = inn.replace(/\D/g, '');
    if (!INN_LENGTHS.includes(digits.length)) return;
    // Вердикт по этому значению уже есть — в том числе «уже ищем»: повторный
    // запрос не уходит, даже если фокус заходил и уходил.
    if (lookup.inn === digits) return;

    lookupController.current?.abort();
    const controller = new AbortController();
    lookupController.current = controller;
    setLookup({ verdict: 'searching', inn: digits });

    void api
      .lookupOrganization(digits, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.reason === 'inn_taken') {
          // ИНН занят другой организацией: ИНН в базе уникален, сохранить его
          // нельзя, а реквизиты чужой организации пользователю не нужны.
          fillRequisites('', '', '', '');
          setLookup({ verdict: 'taken', inn: digits });
          return;
        }
        if (!result.found) {
          // Сервис не нашёл организацию: поля остаются пустыми, но сохранение
          // доступно — пользователь может сохранить один ИНН.
          fillRequisites('', '', '', '');
          setLookup({
            verdict: result.reason === 'unavailable' ? 'unavailable' : 'not_found',
            inn: digits,
          });
          return;
        }
        const details = result.details;
        fillRequisites(
          details?.name ?? '',
          details?.kpp ?? '',
          details?.ogrn ?? '',
          details?.address ?? '',
        );
        setLookup({ verdict: 'found', inn: digits });
      })
      .catch(() => {
        // Отменённый запрос — не ошибка: его заменил следующий.
        if (controller.signal.aborted) return;
        fillRequisites('', '', '', '');
        setLookup({ verdict: 'unavailable', inn: digits });
      });
  }

  function fillRequisites(
    nextName: string,
    nextKpp: string,
    nextOgrn: string,
    nextAddress: string,
  ): void {
    setName(nextName);
    setKpp(nextKpp);
    setOgrn(nextOgrn);
    setAddress(nextAddress);
  }

  /** ИНН вводится только цифрами: буквы и разделители отбрасываются на вводе. */
  function changeInn(value: string): void {
    setInn(value.replace(/\D/g, ''));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Занятый ИНН не сохраняется: кнопка в этом состоянии заблокирована, а
    // проверка здесь — страховка от отправки формы другим путём.
    if (inFlight.current || innTaken) return;
    inFlight.current = true;
    setSaving(true);
    setSaved('');
    setSaveError('');
    try {
      const updated = await api.saveOrganization({ name, inn, kpp, ogrn, address });
      setRecord(updated);
      setName(updated.name ?? '');
      setInn(updated.inn ?? '');
      setKpp(updated.kpp ?? '');
      setOgrn(updated.ogrn ?? '');
      setAddress(updated.address ?? '');
      setSaved('Изменения сохранены.');
      restoreFocus.current = true;
    } catch (error) {
      setSaveError(saveErrorMessage(error));
      restoreFocus.current = true;
    } finally {
      inFlight.current = false;
      setSaving(false);
      if (restoreFocus.current) {
        restoreFocus.current = false;
        // Кадр нужен потому, что сразу после `setSaving(false)` поля ещё
        // задизейблены, а задизейбленный элемент фокус не принимает. Поле ИНН —
        // единственное редактируемое, поэтому фокус возвращается именно туда,
        // какое бы поле ни назвал сервер в тексте ошибки.
        window.requestAnimationFrame(() => {
          innRef.current?.focus({ preventScroll: true });
        });
      }
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
          <p className={styles.subtitle}>Название и реквизиты вашей организации</p>
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
              <p>Название и реквизиты заполняются по ИНН.</p>
            </div>
          </div>
          <form
            className={styles['organization-form']}
            noValidate
            aria-busy={saving || searching}
            onSubmit={(event) => void submit(event)}
          >
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
                onChange={(event) => changeInn(event.target.value)}
                onBlur={runLookup}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  runLookup();
                }}
                inputMode="numeric"
                disabled={saving || searching}
                placeholder="10 или 12 цифр"
                aria-describedby="organization-inn-hint"
              />
              <p className={styles['organization-hint']} id="organization-inn-hint">
                10 цифр у организации, 12 — у индивидуального предпринимателя. Название, КПП, ОГРН и
                адрес заполнятся системой.
              </p>
              {searching && (
                <div className={styles['organization-lookup']}>
                  <p
                    className={styles['organization-source']}
                    role="status"
                    data-testid="organization-lookup-status"
                  >
                    {LOOKUP_SEARCHING_TEXT}
                  </p>
                  <progress
                    className={styles['organization-lookup-progress']}
                    data-testid="organization-lookup-progress"
                    aria-label="Поиск организации по ИНН"
                  />
                </div>
              )}
              {innTaken && (
                <p
                  className="alert alert--error"
                  role="alert"
                  data-testid="organization-lookup-error"
                >
                  {LOOKUP_INN_TAKEN_TEXT}
                </p>
              )}
              {(verdict === 'not_found' || verdict === 'unavailable') && (
                <p
                  className="alert alert--error"
                  role="alert"
                  data-testid="organization-lookup-error"
                >
                  {verdict === 'not_found' ? LOOKUP_NOT_FOUND_TEXT : LOOKUP_UNAVAILABLE_TEXT}
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="organization-name">
                Название организации
              </label>
              <input
                className="field__input"
                id="organization-name"
                data-testid="organization-name"
                value={name}
                disabled
                placeholder="Заполнится по ИНН"
                aria-describedby="organization-name-hint"
              />
              <p className={styles['organization-hint']} id="organization-name-hint">
                Заполняется из DaData. Здесь не редактируется.
              </p>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="organization-kpp">
                КПП
              </label>
              <input
                className="field__input"
                id="organization-kpp"
                data-testid="organization-kpp"
                value={kpp}
                disabled
                placeholder="Заполнится по ИНН"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="organization-ogrn">
                ОГРН
              </label>
              <input
                className="field__input"
                id="organization-ogrn"
                data-testid="organization-ogrn"
                value={ogrn}
                disabled
                placeholder="Заполнится по ИНН"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="organization-address">
                Адрес регистрации
              </label>
              <input
                className="field__input"
                id="organization-address"
                data-testid="organization-address"
                value={address}
                disabled
                placeholder="Заполнится по ИНН"
              />
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
              disabled={saving || searching || innTaken}
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
