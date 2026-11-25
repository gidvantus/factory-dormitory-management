/**
 * Хранилище согласия на cookie: чистые функции над `document.cookie`,
 * без React и без обращения к API. Версия согласия лежит прямо в значении
 * cookie, поэтому смена формулировки текста обновляется поднятием версии:
 * старое значение согласием не считается и плашка показывается заново.
 */

export const CONSENT_COOKIE = 'domovoy_cookie_consent';

/**
 * Версия согласия — это редакция текста, под которой его собирают. Значение
 * поднято до `v2` вместе с появлением в тексте плашки обезличенной статистики
 * (Яндекс.Метрика): согласие `v1` собрано под прежнюю, более узкую формулировку
 * и согласием не считается, поэтому после выкатки плашку увидят все посетители,
 * а счётчик до нового «Принять» не загружается. Имя cookie при смене версии
 * не меняется — так сохранённый выбор не размножается по нескольким cookie.
 */
export const CONSENT_VALUE = 'v2';

/**
 * Событие, которое бросается после записи согласия. Слушатели — те, кому
 * согласие нужно, чтобы начать работу (загрузка счётчика Метрики): сама плашка
 * о них ничего не знает и продолжает оставаться простым предупреждением.
 */
export const CONSENT_CHANGED_EVENT = 'domovoy:cookie-consent';

export const CONSENT_MAX_AGE_DAYS = 180;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Значение cookie по имени или `null`, если такой cookie не выставлен. */
function readCookie(doc: Document, name: string): string | null {
  for (const part of doc.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/** Согласие дано только при точном совпадении значения с текущей версией. */
export function isConsentGiven(doc: Document = document): boolean {
  return readCookie(doc, CONSENT_COOKIE) === CONSENT_VALUE;
}

/**
 * Запоминает согласие на 180 дней. `Secure` добавляется только для https:
 * стенд и локальная разработка идут по http, и с безусловным флагом
 * браузер отбросил бы cookie.
 *
 * Событие бросается после записи, а не до неё: слушатель, проверяющий согласие
 * через `isConsentGiven()`, обязан увидеть уже сохранённое значение.
 */
export function rememberConsent(doc: Document = document): void {
  const maxAge = CONSENT_MAX_AGE_DAYS * SECONDS_PER_DAY;
  const secure = doc.location.protocol === 'https:' ? '; Secure' : '';
  doc.cookie = `${CONSENT_COOKIE}=${CONSENT_VALUE}; path=/; max-age=${maxAge}; SameSite=Lax${secure}`;
  doc.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}
