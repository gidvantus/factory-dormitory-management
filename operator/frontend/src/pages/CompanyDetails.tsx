import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { ApiError, getCompanyDetails, updateCompanyDetails } from '../api/client';
import type { CompanyDetails as CompanyDetailsData, CompanyDetailsUpdate } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';

/** Текст для сети, где `detail` сервера нет вовсе. */
const LOAD_ERROR = 'Не удалось загрузить реквизиты';
const SAVE_ERROR = 'Не удалось сохранить реквизиты';

/**
 * Поля реквизитов: имя в API, подпись, `data-testid` и подсказка.
 *
 * Порядок — порядок контракта половин: он же порядок строк в блоке «Поставщик»
 * печатной формы (`app/backend/app/billing_forms.py`), поэтому оператор видит
 * поля в том же порядке, в каком они попадут в счёт.
 *
 * Подсказки называют формат, но ничего не проверяют: формат ИНН, КПП, ОГРН, БИК
 * и счетов, длины колонок — правило основного API, и его `422` экран показывает
 * дословно. Своя проверка здесь разошлась бы с контрактом на первой же правке.
 */
type FieldName =
  | 'name'
  | 'inn'
  | 'kpp'
  | 'ogrn'
  | 'address'
  | 'bank_name'
  | 'bank_bic'
  | 'bank_account'
  | 'corr_account'
  | 'signatory'
  | 'vat_note';

interface FieldSpec {
  name: FieldName;
  label: string;
  testId: string;
  /** Поле занимает всю строку сетки: длинные значения не влезают в треть. */
  wide?: boolean;
  hint?: string;
  /** Счёт и БИК набираются цифрами — на телефоне это цифровая клавиатура. */
  numeric?: boolean;
  multiline?: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'name', label: 'Название', testId: 'operator-company-name', wide: true },
  {
    name: 'inn',
    label: 'ИНН',
    testId: 'operator-company-inn',
    hint: '10 или 12 цифр',
    numeric: true,
  },
  { name: 'kpp', label: 'КПП', testId: 'operator-company-kpp', hint: '9 символов' },
  {
    name: 'ogrn',
    label: 'ОГРН',
    testId: 'operator-company-ogrn',
    hint: '13 или 15 цифр',
    numeric: true,
  },
  {
    name: 'address',
    label: 'Адрес',
    testId: 'operator-company-address',
    wide: true,
    multiline: true,
  },
  { name: 'bank_name', label: 'Банк', testId: 'operator-company-bank-name', wide: true },
  {
    name: 'bank_bic',
    label: 'БИК',
    testId: 'operator-company-bank-bic',
    hint: '9 цифр',
    numeric: true,
  },
  {
    name: 'bank_account',
    label: 'Расчётный счёт',
    testId: 'operator-company-account',
    hint: '20 цифр',
    numeric: true,
  },
  {
    name: 'corr_account',
    label: 'Корреспондентский счёт',
    testId: 'operator-company-corr-account',
    hint: '20 цифр',
    numeric: true,
  },
  {
    name: 'signatory',
    label: 'Подписант',
    testId: 'operator-company-signatory',
    wide: true,
    hint: 'Например: «Генеральный директор И. И. Иванов»',
  },
  {
    name: 'vat_note',
    label: 'Строка про НДС',
    testId: 'operator-company-vat-note',
    wide: true,
    hint: 'Печатается в счёте и акте; пусто — строки в документе нет',
  },
];

/**
 * Поле, к которому относится отказ сервера.
 *
 * Основной API отвечает русским текстом (`Контракт половин`), и экран узнаёт
 * поле по самому тексту — списком тех сообщений, которые называет контракт.
 * Приставку `Value error, ` уже снял `client.ts`, а несколько сообщений он
 * склеивает через `; ` — виноватым считается первое. Незнакомый отказ поле не
 * помечает: выдумывать связь нельзя, а текст ошибки всё равно показан дословно.
 */
const FIELD_MESSAGES: Readonly<Record<FieldName, readonly string[]>> = {
  name: ['Название длиннее 255 символов'],
  inn: ['ИНН должен состоять из 10 или 12 цифр'],
  kpp: ['КПП должен состоять из 9 символов'],
  ogrn: ['ОГРН должен состоять из 13 или 15 цифр'],
  address: ['Адрес длиннее 500 символов'],
  bank_name: ['Банк длиннее 255 символов'],
  bank_bic: ['БИК банка должен состоять из 9 цифр'],
  bank_account: ['Расчётный счёт должен состоять из 20 цифр'],
  corr_account: ['Корреспондентский счёт должен состоять из 20 цифр'],
  signatory: ['Подписант длиннее 300 символов'],
  vat_note: ['Строка про НДС длиннее 200 символов'],
};

function invalidField(text: string): FieldName | null {
  const first = text.split('; ')[0];
  for (const [field, messages] of Object.entries(FIELD_MESSAGES)) {
    if (messages.includes(first)) return field as FieldName;
  }
  return null;
}

/** Поля формы строками: `null` из ответа остаётся пустым полем, без прочерка. */
type FormValues = Record<FieldName, string>;

const EMPTY_FORM: FormValues = {
  name: '',
  inn: '',
  kpp: '',
  ogrn: '',
  address: '',
  bank_name: '',
  bank_bic: '',
  bank_account: '',
  corr_account: '',
  signatory: '',
  vat_note: '',
};

/** Форма по строке ответа: значения — из последнего ответа сервера. */
function formFrom(data: CompanyDetailsData): FormValues {
  return {
    name: data.name ?? '',
    inn: data.inn ?? '',
    kpp: data.kpp ?? '',
    ogrn: data.ogrn ?? '',
    address: data.address ?? '',
    bank_name: data.bank_name ?? '',
    bank_bic: data.bank_bic ?? '',
    bank_account: data.bank_account ?? '',
    corr_account: data.corr_account ?? '',
    signatory: data.signatory ?? '',
    vat_note: data.vat_note ?? '',
  };
}

/**
 * Тело правки: уходят все одиннадцать полей, как требует контракт.
 *
 * Пустое поле (в том числе из одних пробелов) уходит как `null` — это и есть
 * очистка. Длины и форматы не проверяются: правило живёт в основном API, и его
 * отказ кабинет обязан показать дословно.
 */
function toPayload(values: FormValues): CompanyDetailsUpdate {
  const field = (value: string): string | null => (value.trim() === '' ? null : value);
  return {
    name: field(values.name),
    inn: field(values.inn),
    kpp: field(values.kpp),
    ogrn: field(values.ogrn),
    address: field(values.address),
    bank_name: field(values.bank_name),
    bank_bic: field(values.bank_bic),
    bank_account: field(values.bank_account),
    corr_account: field(values.corr_account),
    signatory: field(values.signatory),
    vat_note: field(values.vat_note),
  };
}

/**
 * Текст отказа для экрана.
 *
 * Контракт кабинета: `detail` показывается дословно. Сюда приходят и тексты
 * основного API через прокси («Реквизиты поставщика не заведены», сообщения
 * валидаторов, `502`/`503`), поэтому переписывать их нельзя — исключение только
 * для сети, где текста сервера нет вовсе.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}

/**
 * Состояние загрузки.
 *
 * `ready` не носит ответа: экран показывает не строку реквизитов, а форму, и
 * живёт она отдельным состоянием `form`, которое обновляет и загрузка, и
 * сохранение. Держать `data` ещё и здесь значило бы иметь вторую копию того же
 * ответа, которую никто не читает.
 */
type LoadState = { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready' };

/**
 * Реквизиты поставщика и строка про НДС — единственное место, где они правятся.
 *
 * Данные — из кабинета-API (`GET/PATCH /api/company-details`), тот ходит в
 * основной API по сервисному токену. Из этих полей печатные формы счёта и акта
 * собирают блок «Поставщик» и строку про НДС, а уже выданные PDF лежат в
 * хранилище, поэтому правка действует только на документы, собранные после неё.
 *
 * Состояния: загрузка («Загружаем реквизиты…»); ошибка загрузки — текст `detail`
 * дословно и «Повторить»; форма — пустая (нормальное первое состояние: реквизитов
 * ещё нет) или заполненная; отправка — кнопка неактивна («Сохраняем…»); успех —
 * «Сохранено» без перезагрузки; отказ — текст дословно в `role="alert"` над
 * формой, введённые значения остаются в полях.
 */
export function CompanyDetails(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Поле, которое сервер назвал виноватым: на нём `aria-invalid`.
  const [errorField, setErrorField] = useState<FieldName | null>(null);
  // Повтор загрузки: «Повторить» — это новый номер попытки, а не второй запрос
  // поверх первого.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    getCompanyDetails().then(
      (data) => {
        if (!active) return;
        setState({ status: 'ready' });
        setForm(formFrom(data));
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', text: errorMessage(error, LOAD_ERROR) });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  /** Правка поля: «Сохранено» гаснет, потому что значения снова не сохранены. */
  function handleChange(field: FieldName, value: string): void {
    setForm((current) => ({ ...current, [field]: value }));
    setSaved(false);
  }

  /**
   * Сохранение: единственное место, откуда уходит `PATCH`.
   *
   * Ответ заменяет форму: значения берутся из того, что сохранил сервер, а не из
   * черновика. Отказ форму не сбрасывает — введённое остаётся, текст `detail`
   * показывается дословно над формой, виноватое поле помечается `aria-invalid`.
   */
  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setErrorField(null);
    try {
      const updated = await updateCompanyDetails(toPayload(form));
      setForm(formFrom(updated));
      setSaved(true);
    } catch (error: unknown) {
      const text = errorMessage(error, SAVE_ERROR);
      setSaveError(text);
      setErrorField(invalidField(text));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className="page page--company">
          <div className="page__head">
            <h1 className="page__title">Реквизиты поставщика</h1>
            <p className="page__meta">Печатаются в счетах и актах</p>
          </div>

          {state.status === 'loading' && (
            <div className="state" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              Загружаем реквизиты…
            </div>
          )}

          {state.status === 'error' && (
            <>
              <p className="alert alert--error" role="alert" data-testid="operator-company-error">
                {state.text}
              </p>
              <div className="form__actions">
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => setAttempt((current) => current + 1)}
                  data-testid="operator-company-retry"
                >
                  Повторить
                </button>
              </div>
            </>
          )}

          {state.status === 'ready' && (
            <div className="panel">
              <div className="panel__head">
                <h2 className="panel__title">Поставщик</h2>
              </div>

              {/* Отказ сохранения — над формой, а не после сетки полей: оператор
                  правит верхнее поле и жмёт Enter, и сообщение о том, что PATCH
                  не прошёл, должно быть в поле зрения, а не ниже одиннадцати
                  полей. `id` остаётся тем же: на него ссылаются `aria-describedby`
                  виноватого поля. */}
              {saveError !== null && (
                <p
                  className="alert alert--error panel__alert"
                  id="company-error"
                  role="alert"
                  data-testid="operator-company-error"
                >
                  {saveError}
                </p>
              )}

              <form
                className="form form--panel"
                noValidate
                onSubmit={(event) => void handleSave(event)}
                data-testid="operator-company"
              >
                <div className="form__grid form__grid--company">
                  {FIELDS.map((field) => (
                    <div className={field.wide ? 'field field--wide' : 'field'} key={field.name}>
                      <label className="field__label" htmlFor={`company-${field.name}`}>
                        {field.label}
                      </label>
                      {field.multiline === true ? (
                        <textarea
                          className="field__input field__input--area"
                          id={`company-${field.name}`}
                          name={field.name}
                          rows={2}
                          value={form[field.name]}
                          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                            handleChange(field.name, event.target.value)
                          }
                          aria-invalid={errorField === field.name ? true : undefined}
                          aria-describedby={errorField === field.name ? 'company-error' : undefined}
                          data-testid={field.testId}
                        />
                      ) : (
                        <input
                          className="field__input"
                          id={`company-${field.name}`}
                          name={field.name}
                          type="text"
                          inputMode={field.numeric === true ? 'numeric' : undefined}
                          value={form[field.name]}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            handleChange(field.name, event.target.value)
                          }
                          aria-invalid={errorField === field.name ? true : undefined}
                          aria-describedby={errorField === field.name ? 'company-error' : undefined}
                          data-testid={field.testId}
                        />
                      )}
                      {field.hint !== undefined && <p className="field__hint">{field.hint}</p>}
                    </div>
                  ))}
                </div>

                <div className="form__actions">
                  <button
                    className="btn btn--primary"
                    type="submit"
                    disabled={saving}
                    aria-busy={saving ? true : undefined}
                    data-testid="operator-company-save"
                  >
                    {saving ? 'Сохраняем…' : 'Сохранить'}
                  </button>
                  {saved && (
                    <p className="form__saved" role="status" data-testid="operator-company-saved">
                      Сохранено
                    </p>
                  )}
                </div>
              </form>

              <p className="panel__note">
                Правка действует на документы, собранные после неё: уже выданные счета и акты лежат
                в хранилище и не перерисовываются.
              </p>
            </div>
          )}
        </div>
      </main>
    </Screen>
  );
}
