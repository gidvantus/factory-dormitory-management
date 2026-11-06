import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, RefObject } from 'react';

import {
  ApiError,
  deactivateOrganizationSolution,
  deactivateSubscription,
  getSubscription,
  updateSubscription,
} from '../api/client';
import type {
  NextSubscription,
  SubscriptionRight,
  SubscriptionState,
  SubscriptionTariff,
} from '../api/client';
import { formatDay } from '../lib/format';

/** Текст для сети и неожиданного отказа: `detail` сервера важнее общего текста. */
const LOAD_ERROR = 'Не удалось загрузить тариф';
const SAVE_ERROR = 'Не удалось сохранить срок';
const DEACTIVATE_ERROR = 'Не удалось снять активность';

/** Тексты панели — из макета постановки, дословно. */
const EMPTY_TARIFF = 'Тариф не назначен';
const EMPTY_TARIFF_HINT = 'Тариф появляется после оплаты счёта; назначить его из кабинета нельзя.';
const EMPTY_SOLUTIONS = 'Расширений нет';
const UNTIL_HINT =
  'Последний включённый день. Запишется как 23:59:59 по Москве — ' +
  'в клиентском кабинете тариф будет действовать до этого дня.';
const NOTE =
  'Снятие активности не удаляет запись: оно записывает срок в прошлое. ' +
  'Вернуть активность из кабинета нельзя — тариф и права появляются после оплаты.';
const NOTE_PERPETUAL =
  '«Изменить срок» на бессрочном тарифе ставит дату: бессрочность снимается ' +
  'этой правкой и только ею. Обратно в бессрочный из кабинета не вернуть.';

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'ready'; data: SubscriptionState };

/**
 * Отказ правки срока.
 *
 * `invalid` — отказ валидации (`422`): на таком поле стоит `aria-invalid`, а
 * текст пришёл из основного API («Укажите срок действия в формате ГГГГ-ММ-ДД»).
 */
interface SaveError {
  text: string;
  invalid: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}

/** Срок тарифа словами: «по ДД.ММ.ГГГГ», «срок истёк ДД.ММ.ГГГГ» или «бессрочно». */
function untilText(tariff: SubscriptionTariff): string {
  if (tariff.ends_at === null || tariff.paid_until === null) {
    return 'бессрочно';
  }
  const day = formatDay(tariff.paid_until);
  return tariff.is_live ? `по ${day}` : `срок истёк ${day}`;
}

/** Срок права на расширение словами — тем же правилом, что у тарифа. */
function rightText(right: SubscriptionRight): string {
  if (!right.is_live) {
    return 'не действует';
  }
  if (right.paid_until === null) {
    return 'бессрочно';
  }
  return `действует по ${formatDay(right.paid_until)}`;
}

/** Строка «оплачен вперёд»: название будущего тарифа и его срок. */
function nextText(next: NextSubscription): string {
  if (next.paid_until === null) {
    return `${next.tariff.name}, бессрочно`;
  }
  return `${next.tariff.name}, по ${formatDay(next.paid_until)}`;
}

/**
 * Подпись предела мест.
 *
 * `member_limit` отвечает на вопрос «сколько можно пригласить», но не говорит,
 * откуда число: разложение на «по тарифу» и «докуплено» берёт готовый
 * `extra_seats` из ответа и второй формулы не заводит.
 */
function seatsLabel(limit: number, extra: number): string {
  if (extra <= 0) {
    return 'мест по тарифу';
  }
  return `мест: ${limit - extra} по тарифу и ${extra} докуплено`;
}

/**
 * Панель «Тариф и расширения» карточки организации (#189).
 *
 * Данные грузятся своим запросом (`GET /api/organizations/{id}/subscription`) и
 * живут отдельно от карточки: отказ чтения рисуется внутри панели и не ломает
 * «Реквизиты» выше. Состояния: загрузка, отказ с «Повторить», пусто («Тариф не
 * назначен», «Расширений нет»), просмотр, правка срока, двухшаговое снятие.
 *
 * Ответ на любое действие — новый объект состояния, и экран показывает его:
 * повторного запроса нет, дата берётся из ответа, а не из того, что ввели.
 * Тексты отказов — `detail` основного API дословно, в `role="alert"`.
 */
export function SubscriptionPanel({ organizationId }: { organizationId: number }): JSX.Element {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  // Номер попытки: «Повторить» перезапускает чтение, не меняя организацию.
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [until, setUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  // Ожидание подтверждения: запрос уходит только со второго шага.
  const [confirmingTariff, setConfirmingTariff] = useState(false);
  const [confirmingSolution, setConfirmingSolution] = useState<string | null>(null);
  // Что сейчас выполняется: `tariff` или код расширения. Пока запрос идёт,
  // кнопки неактивны и два нажатия не уходят.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Куда вернуть фокус после исчезнувшей из DOM кнопки: `tariff` или код права.
  const focusAfterRender = useRef<string | null>(null);
  const actionErrorRef = useRef<HTMLParagraphElement | null>(null);
  const saveErrorRef = useRef<HTMLParagraphElement | null>(null);
  const tariffEditRef = useRef<HTMLButtonElement | null>(null);
  const solutionButtons = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    getSubscription(organizationId).then(
      (data) => {
        if (active) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', text: errorMessage(error, LOAD_ERROR) });
      },
    );
    return () => {
      active = false;
    };
  }, [organizationId, attempt]);

  // После отказа фокус — на алерте: кнопка на время запроса неактивна, и браузер
  // снимает с неё фокус, а требование постановки — чтобы отказ был прочитан.
  useEffect(() => {
    if (actionError !== null) actionErrorRef.current?.focus();
  }, [actionError]);

  useEffect(() => {
    if (saveError !== null) saveErrorRef.current?.focus();
  }, [saveError]);

  /**
   * Возврат фокуса после исчезнувшей кнопки.
   *
   * Нажатые «Подтвердить», «Не надо» и «Отмена» уходят из DOM, и фокус уехал бы
   * на `body` — следующий Tab начал бы обход экрана сначала. У расширения после
   * снятия кнопка неактивна, а неактивная кнопка фокус не берёт, поэтому запасной
   * адрес — «Изменить срок» тарифа.
   */
  useEffect(() => {
    const target = focusAfterRender.current;
    if (target === null) return;
    focusAfterRender.current = null;
    if (target === 'tariff') {
      tariffEditRef.current?.focus();
      return;
    }
    const button = solutionButtons.current[target];
    if (button !== null && button !== undefined && !button.disabled) {
      button.focus();
      return;
    }
    tariffEditRef.current?.focus();
  });

  function handleEdit(tariff: SubscriptionTariff): void {
    setActionError(null);
    setSaveError(null);
    setConfirmingTariff(false);
    setConfirmingSolution(null);
    setUntil(tariff.paid_until ?? '');
    setEditing(true);
  }

  function handleCancel(): void {
    setSaveError(null);
    setEditing(false);
    focusAfterRender.current = 'tariff';
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || state.status !== 'ready') return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateSubscription(organizationId, until);
      setState({ status: 'ready', data: updated });
      setEditing(false);
      focusAfterRender.current = 'tariff';
    } catch (error: unknown) {
      setSaveError({
        text: errorMessage(error, SAVE_ERROR),
        invalid: error instanceof ApiError && error.status === 422,
      });
    } finally {
      setSaving(false);
    }
  }

  function askDeactivateTariff(): void {
    setActionError(null);
    setSaveError(null);
    setEditing(false);
    setConfirmingSolution(null);
    setConfirmingTariff(true);
  }

  function declineDeactivateTariff(): void {
    setConfirmingTariff(false);
    focusAfterRender.current = 'tariff';
  }

  function askDeactivateSolution(code: string): void {
    setActionError(null);
    setSaveError(null);
    setEditing(false);
    setConfirmingTariff(false);
    setConfirmingSolution(code);
  }

  function declineDeactivateSolution(code: string): void {
    setConfirmingSolution(null);
    focusAfterRender.current = code;
  }

  /** Снятие активности тарифа: тела нет, ответ — новое состояние экрана. */
  async function confirmDeactivateTariff(): Promise<void> {
    if (busy !== null) return;
    setConfirmingTariff(false);
    setActionError(null);
    setBusy('tariff');
    try {
      const updated = await deactivateSubscription(organizationId);
      setState({ status: 'ready', data: updated });
    } catch (error: unknown) {
      setActionError(errorMessage(error, DEACTIVATE_ERROR));
    } finally {
      focusAfterRender.current = 'tariff';
      setBusy(null);
    }
  }

  /** Снятие активности права на расширение: строка остаётся, гаснет срок. */
  async function confirmDeactivateSolution(right: SubscriptionRight): Promise<void> {
    if (busy !== null) return;
    setConfirmingSolution(null);
    setActionError(null);
    setBusy(right.code);
    try {
      const updated = await deactivateOrganizationSolution(organizationId, right.code);
      setState({ status: 'ready', data: updated });
    } catch (error: unknown) {
      setActionError(errorMessage(error, DEACTIVATE_ERROR));
    } finally {
      focusAfterRender.current = right.code;
      setBusy(null);
    }
  }

  /**
   * Панель занята записью: идёт снятие активности или сохранение срока.
   *
   * `saving` здесь не для красоты: две записи в одном round-trip (срок и снятие)
   * оставили бы экран с состоянием того ответа, который придёт последним, — то
   * есть строка расширения или дата могли бы остаться от предыдущего состояния.
   * Пока идёт любой запрос, кнопки действий неактивны, и второй запрос не уходит.
   */
  const locked = busy !== null || saving;

  /** Просмотр: тариф (или пусто), форма правки, отказ действия, права. */
  function renderReady(data: SubscriptionState): JSX.Element {
    const tariff = data.tariff;
    return (
      <div className="sub">
        {tariff === null ? (
          <>
            <div className="sub__head">
              <div className="sub__main">
                <p
                  className="sub__name sub__name--none"
                  data-testid="operator-subscription-tariff-name"
                >
                  {EMPTY_TARIFF}
                </p>
              </div>
            </div>
            <p className="sub__hint">{EMPTY_TARIFF_HINT}</p>
          </>
        ) : (
          <TariffHead
            tariff={tariff}
            daysLeft={data.days_left}
            memberLimit={data.member_limit}
            extraSeats={data.extra_seats}
            editing={editing}
            locked={locked}
            confirming={confirmingTariff}
            editRef={tariffEditRef}
            onEdit={() => handleEdit(tariff)}
            onAskDeactivate={askDeactivateTariff}
            onDecline={declineDeactivateTariff}
            onConfirm={() => void confirmDeactivateTariff()}
          />
        )}

        {editing && tariff !== null && (
          <form className="form form--sub" noValidate onSubmit={handleSave}>
            <div className="field">
              <label className="field__label" htmlFor="subscription-until">
                Действует по
              </label>
              <input
                className="field__input"
                id="subscription-until"
                name="paid_until"
                type="date"
                value={until}
                disabled={saving}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setUntil(event.target.value)}
                aria-invalid={saveError !== null && saveError.invalid ? true : undefined}
                aria-describedby={
                  saveError === null || !saveError.invalid
                    ? 'subscription-until-hint'
                    : 'subscription-until-error'
                }
                data-testid="operator-subscription-tariff-until-input"
              />
            </div>
            <p className="field__hint" id="subscription-until-hint">
              {UNTIL_HINT}
            </p>
            {saveError !== null && (
              <p
                className="alert alert--error"
                id="subscription-until-error"
                role="alert"
                tabIndex={-1}
                ref={saveErrorRef}
                data-testid="operator-subscription-action-error"
              >
                {saveError.text}
              </p>
            )}
            <div className="form__actions">
              <button
                className="btn btn--primary"
                type="submit"
                disabled={saving}
                aria-busy={saving ? true : undefined}
                data-testid="operator-subscription-tariff-save"
              >
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={handleCancel}
                disabled={saving}
                data-testid="operator-subscription-tariff-cancel"
              >
                Отмена
              </button>
            </div>
          </form>
        )}

        {actionError !== null && (
          <p
            className="alert alert--error sub__error"
            role="alert"
            tabIndex={-1}
            ref={actionErrorRef}
            data-testid="operator-subscription-action-error"
          >
            {actionError}
          </p>
        )}

        {data.next !== null && (
          <p className="sub__next" data-testid="operator-subscription-next">
            Оплачен вперёд:
            <span className="sub__next-value">{nextText(data.next)}</span>
          </p>
        )}

        <div className="sub__solutions" data-testid="operator-subscription-solutions">
          <h3 className="sub__section">Расширения</h3>
          {data.solutions.length === 0 ? (
            <p className="sub__empty" data-testid="operator-subscription-solutions-empty">
              {EMPTY_SOLUTIONS}
            </p>
          ) : (
            <ul className="sub__list">
              {data.solutions.map((right) => {
                const confirming = confirmingSolution === right.code;
                const rightBusy = busy === right.code;
                return (
                  <li
                    key={right.code}
                    className={right.is_live ? 'sub__solution' : 'sub__solution sub__solution--off'}
                    data-testid="operator-subscription-solution-row"
                  >
                    <span
                      className="sub__solution-name"
                      data-testid="operator-subscription-solution-name"
                    >
                      {right.name}
                    </span>
                    <span
                      className="sub__solution-state"
                      data-testid="operator-subscription-solution-state"
                    >
                      {rightText(right)}
                    </span>
                    {right.is_live && confirming ? (
                      <div className="sub__solution-actions">
                        <button
                          className="btn btn--danger btn--compact"
                          type="button"
                          onClick={() => void confirmDeactivateSolution(right)}
                          disabled={locked}
                          aria-busy={rightBusy ? true : undefined}
                          data-testid="operator-subscription-solution-deactivate-confirm"
                        >
                          Подтвердить
                        </button>
                        <button
                          className="btn btn--ghost btn--compact"
                          type="button"
                          onClick={() => declineDeactivateSolution(right.code)}
                          disabled={locked}
                          data-testid="operator-subscription-solution-deactivate-decline"
                        >
                          Не надо
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn btn--ghost btn--compact btn--danger"
                        type="button"
                        ref={(element) => {
                          solutionButtons.current[right.code] = element;
                        }}
                        onClick={() => askDeactivateSolution(right.code)}
                        // Снимать нечего: право уже не действует.
                        disabled={!right.is_live || locked}
                        aria-busy={rightBusy ? true : undefined}
                        data-testid="operator-subscription-solution-deactivate"
                      >
                        Снять активность
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="panel__note">
          {tariff !== null && tariff.ends_at === null ? NOTE_PERPETUAL : NOTE}
        </p>
      </div>
    );
  }

  return (
    <div
      className="panel"
      data-testid="operator-subscription"
      aria-busy={locked ? true : undefined}
    >
      <div className="panel__head">
        <h2 className="panel__title">Тариф и расширения</h2>
      </div>

      {state.status === 'loading' && (
        <p className="state" role="status" data-testid="operator-subscription-loading">
          <span className="spinner" aria-hidden="true" />
          Загружаем тариф…
        </p>
      )}

      {state.status === 'error' && (
        <div className="alert-line sub__alert-line">
          <p className="alert alert--error" role="alert" data-testid="operator-subscription-error">
            {state.text}
          </p>
          <button
            className="btn btn--ghost btn--compact"
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
            data-testid="operator-subscription-retry"
          >
            Повторить
          </button>
        </div>
      )}

      {state.status === 'ready' && renderReady(state.data)}
    </div>
  );
}

/** Голова панели: тариф, срок, остаток дней и предел мест с действиями. */
interface TariffHeadProps {
  tariff: SubscriptionTariff;
  daysLeft: number;
  memberLimit: number | null;
  extraSeats: number;
  editing: boolean;
  locked: boolean;
  confirming: boolean;
  editRef: RefObject<HTMLButtonElement>;
  onEdit: () => void;
  onAskDeactivate: () => void;
  onDecline: () => void;
  onConfirm: () => void;
}

function TariffHead({
  tariff,
  daysLeft,
  memberLimit,
  extraSeats,
  editing,
  locked,
  confirming,
  editRef,
  onEdit,
  onAskDeactivate,
  onDecline,
  onConfirm,
}: TariffHeadProps): JSX.Element {
  return (
    <>
      <div className="sub__head">
        <div className="sub__main">
          <p className="sub__name" data-testid="operator-subscription-tariff-name">
            {tariff.name}
          </p>
          <p className="sub__state" data-testid="operator-subscription-tariff-until">
            <span
              className={tariff.is_live ? 'flag' : 'flag flag--off'}
              data-testid="operator-subscription-tariff-state"
            >
              <span className="flag__dot" aria-hidden="true" />
              {tariff.is_live ? 'действует' : 'не действует'}
            </span>
            <span className="sub__state-text">{untilText(tariff)}</span>
          </p>
        </div>
        {!editing && (
          <div className="sub__actions">
            <button
              className="btn btn--ghost btn--compact"
              type="button"
              ref={editRef}
              onClick={onEdit}
              disabled={locked}
              data-testid="operator-subscription-tariff-edit"
            >
              Изменить срок
            </button>
            {confirming ? (
              <>
                <button
                  className="btn btn--danger btn--compact"
                  type="button"
                  onClick={onConfirm}
                  disabled={locked}
                  aria-busy={locked ? true : undefined}
                  data-testid="operator-subscription-tariff-deactivate-confirm"
                >
                  Подтвердить
                </button>
                <button
                  className="btn btn--ghost btn--compact"
                  type="button"
                  onClick={onDecline}
                  disabled={locked}
                  data-testid="operator-subscription-tariff-deactivate-decline"
                >
                  Не надо
                </button>
              </>
            ) : (
              <button
                className="btn btn--ghost btn--compact btn--danger"
                type="button"
                onClick={onAskDeactivate}
                // Снимать нечего: срок уже в прошлом. Так же ведёт себя и сервер —
                // повторное снятие возвращает то же состояние.
                disabled={!tariff.is_live || locked}
                data-testid="operator-subscription-tariff-deactivate"
              >
                Снять активность
              </button>
            )}
          </div>
        )}
      </div>

      {/* У истёкшего тарифа блока остатка нет вовсе: ноль ничего не добавляет
          к «срок истёк». У бессрочного нет дней, но места остаются. */}
      {tariff.is_live && (tariff.ends_at !== null || memberLimit !== null) && (
        <div className="counts sub__counts">
          {tariff.ends_at !== null && (
            <div className="counts__item">
              <span className="counts__value">{daysLeft}</span>
              <span className="counts__label">дней осталось</span>
            </div>
          )}
          {memberLimit !== null && (
            <div className="counts__item">
              <span className="counts__value">{memberLimit}</span>
              <span className="counts__label">{seatsLabel(memberLimit, extraSeats)}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
