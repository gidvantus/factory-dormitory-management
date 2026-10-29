import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type {
  Dormitory,
  NotificationRule,
  NotificationRuleCatalog,
  TableColumn,
  TableKey,
} from '../api/client';
import { WorkspaceIcon } from './WorkspaceIcon';
import { NotificationRuleDialog } from './NotificationRuleDialog';
import { ruleConditionsText } from './notificationRulesText';
import styles from './Workspace.module.css';

/** Тексты состояний блока — дословно из контракта, без переписывания на клиенте. */
export const RULES_LOAD_ERROR_TEXT = 'Не удалось загрузить правила. Проверьте соединение.';
export const RULES_ACTION_ERROR_TEXT = 'Не удалось изменить правило. Проверьте соединение.';

/**
 * Блок «Правила уведомлений» на странице «Уведомления».
 *
 * Правила персональные и привязаны к общежитию, поэтому блок начинается с
 * селектора общежития: у человека без общежития показывать нечего. Список,
 * каталог для диалога и переключатель — разные запросы, поэтому состояний три:
 * загрузка, ошибка с «Повторить» и список (пустой список — отдельное состояние).
 *
 * Отказ `403` — «решение не подключено»: страница уже спрашивает право у
 * провайдера, но показывать состояние обязана и при ответе ручки — право могло
 * закончиться между загрузками.
 */
export function NotificationRules(): JSX.Element {
  const [dormitories, setDormitories] = useState<Dormitory[]>([]);
  const [dormitoryId, setDormitoryId] = useState<number | null>(null);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [catalog, setCatalog] = useState<NotificationRuleCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<{ initial: NotificationRule | null } | null>(null);
  /** Подписи вариантов списка для условий: таблица → столбцы (см. `ruleConditionsText`). */
  const [columnsByTable, setColumnsByTable] = useState<Record<string, TableColumn[]>>({});

  const current = dormitories.find((item) => item.id === dormitoryId);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .dormitories(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        // Архивное общежитие правил не принимает: в селекторе ему не место.
        const active = items.filter((item) => !item.is_archived);
        setDormitories(active);
        setDormitoryId((value) => value ?? active[0]?.id ?? null);
        if (active.length === 0) setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(RULES_LOAD_ERROR_TEXT);
        setLoading(false);
        if (caught instanceof ApiError && caught.status === 403) setLocked(true);
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (dormitoryId === null) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setLocked(false);
    setActionError('');
    setRules([]);
    setCatalog(null);
    // Подписи вариантов принадлежат общежитию: при переключении их надо сбросить.
    setColumnsByTable({});
    void Promise.all([
      api.notificationRules(dormitoryId, controller.signal),
      api.notificationRuleCatalog(dormitoryId, controller.signal),
    ])
      .then(([list, catalogResponse]) => {
        if (controller.signal.aborted) return;
        setRules(list);
        setCatalog(catalogResponse);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 403) {
          setLocked(true);
        } else {
          setError(RULES_LOAD_ERROR_TEXT);
        }
        setLoading(false);
      });
    return () => controller.abort();
  }, [dormitoryId, attempt]);

  // Подписи вариантов списка нужны только правилам с условием по столбцу вида
  // `select`: каталог вариантов не отдаёт, их приносит ручка столбцов таблицы.
  // Неудачный ответ запоминаем пустым списком — иначе повторяли бы его вечно.
  useEffect(() => {
    if (dormitoryId === null || catalog === null) return undefined;
    const needed = new Set<string>();
    for (const rule of rules) {
      const table = catalog.tables.find((item) => item.key === rule.table_key);
      if (!table) continue;
      if (
        rule.conditions.some(
          (condition) =>
            table.columns.find((column) => column.id === condition.column_id)?.kind === 'select',
        )
      ) {
        needed.add(rule.table_key);
      }
    }
    const missing = [...needed].filter((key) => !(key in columnsByTable));
    if (missing.length === 0) return undefined;
    const controller = new AbortController();
    void Promise.all(
      missing.map((key) =>
        api
          .tableColumns(String(dormitoryId), key as TableKey, controller.signal)
          .then((items) => [key, items] as const)
          .catch(() => [key, [] as TableColumn[]] as const),
      ),
    ).then((loaded) => {
      if (controller.signal.aborted) return;
      setColumnsByTable((value) => ({ ...value, ...Object.fromEntries(loaded) }));
    });
    return () => controller.abort();
  }, [dormitoryId, catalog, rules, columnsByTable]);

  async function toggle(rule: NotificationRule, enabled: boolean): Promise<void> {
    if (dormitoryId === null || busyId !== null) return;
    setBusyId(rule.id);
    setActionError('');
    try {
      const saved = await api.updateNotificationRule(dormitoryId, rule.id, {
        name: rule.name,
        table_key: rule.table_key,
        // PUT переписывает правило целиком: остальные поля обязаны уехать как были.
        is_enabled: enabled,
        conditions: rule.conditions,
      });
      setRules((items) => items.map((item) => (item.id === saved.id ? saved : item)));
    } catch (caught: unknown) {
      setActionError(caught instanceof ApiError ? caught.message : RULES_ACTION_ERROR_TEXT);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(rule: NotificationRule): Promise<void> {
    if (dormitoryId === null || busyId !== null) return;
    setBusyId(rule.id);
    setActionError('');
    try {
      await api.deleteNotificationRule(dormitoryId, rule.id);
      setRules((items) => items.filter((item) => item.id !== rule.id));
    } catch (caught: unknown) {
      // 404 — правило уже удалено (например, другой вкладкой): строка просто исчезает.
      if (caught instanceof ApiError && caught.status === 404) {
        setRules((items) => items.filter((item) => item.id !== rule.id));
      } else {
        setActionError(caught instanceof ApiError ? caught.message : RULES_ACTION_ERROR_TEXT);
      }
    } finally {
      setBusyId(null);
    }
  }

  function saved(rule: NotificationRule): void {
    setRules((items) =>
      items.some((item) => item.id === rule.id)
        ? items.map((item) => (item.id === rule.id ? rule : item))
        : [rule, ...items],
    );
    setDialog(null);
  }

  return (
    <section
      className={`${styles['profile-card']} ${styles['rules-card']}`}
      aria-labelledby="rules-title"
      data-testid="telegram-rules"
    >
      <div className={styles['rules-head']}>
        <div>
          <h2 id="rules-title">Правила уведомлений</h2>
          <p>Срабатывают, когда вы сохраняете строку в таблице общежития. Приходят только вам.</p>
        </div>
        {!locked && dormitoryId !== null && (
          <div className={styles['rules-head-actions']}>
            <label className={styles['rule-field']}>
              <span className={styles['rule-field-label']}>Общежитие</span>
              <select
                className={styles['rule-control']}
                value={dormitoryId}
                data-testid="telegram-rule-dormitory"
                onChange={(event) => setDormitoryId(Number(event.target.value))}
              >
                {dormitories.map((dormitory) => (
                  <option key={dormitory.id} value={dormitory.id}>
                    {dormitory.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn--primary btn--compact"
              type="button"
              data-testid="telegram-rule-add"
              disabled={catalog === null || loading}
              onClick={() => setDialog({ initial: null })}
            >
              Добавить правило
            </button>
          </div>
        )}
      </div>

      {locked && (
        <div className={styles['rules-body']}>
          <div
            className={styles['empty-state']}
            data-tone="locked"
            data-testid="telegram-rules-locked"
          >
            <span className={styles['empty-state-icon']}>
              <WorkspaceIcon name="lock" />
            </span>
            <h2>Решение не подключено</h2>
            <p>Уведомления в Telegram — отдельное решение: подключите его в магазине улучшений.</p>
            <Link className="btn btn--primary btn--sm" to="/cabinet/shop">
              В магазин улучшений
            </Link>
          </div>
        </div>
      )}

      {!locked && loading && (
        <div className={styles['rules-body']}>
          <p className={styles['view-note']} role="status" data-testid="telegram-rules-loading">
            Загружаем правила…
          </p>
        </div>
      )}

      {!locked && !loading && error && (
        <div className={styles['rules-body']}>
          <p className="alert alert--error" role="alert" data-testid="telegram-rules-error">
            {error}
          </p>
          <div>
            <button
              className="btn btn--ghost btn--compact"
              type="button"
              data-testid="telegram-rules-retry"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Повторить
            </button>
          </div>
        </div>
      )}

      {!locked && !loading && !error && rules.length === 0 && (
        <div className={styles['rules-body']}>
          <div className={styles['empty-state']} data-testid="telegram-rule-empty">
            <span className={styles['empty-state-icon']}>
              <WorkspaceIcon name="people" />
            </span>
            <h2>Правил пока нет</h2>
            <p>
              Создайте правило: выберите таблицу, задайте условия по столбцам — и сообщение придёт в
              Telegram, когда строка под них подойдёт.
            </p>
            <button
              className="btn btn--primary btn--compact"
              type="button"
              data-testid="telegram-rule-empty-add"
              disabled={catalog === null}
              onClick={() => setDialog({ initial: null })}
            >
              Добавить правило
            </button>
          </div>
        </div>
      )}

      {!locked && !loading && !error && rules.length > 0 && (
        <>
          <div className={styles['rule-row-head']} aria-hidden="true">
            <div>Правило</div>
            <div>Таблица</div>
            <div>Включено</div>
            <div />
          </div>
          <ul className={styles['rule-list']}>
            {rules.map((rule) => (
              <li
                className={styles['rule-row']}
                key={rule.id}
                data-testid={`telegram-rule-row-${rule.id}`}
              >
                <div className={styles['rule-main']}>
                  <button
                    className={`link-button ${styles['rule-name']}`}
                    type="button"
                    data-testid={`telegram-rule-edit-${rule.id}`}
                    onClick={() => setDialog({ initial: rule })}
                  >
                    {rule.name}
                  </button>
                  {rule.conditions.length > 0 && (
                    <p className={styles['rule-cond']}>
                      {ruleConditionsText(rule, catalog, columnsByTable)}
                    </p>
                  )}
                  {rule.broken && (
                    <p
                      className={styles['rule-warn']}
                      data-testid={`telegram-rule-broken-${rule.id}`}
                    >
                      <WorkspaceIcon name="info" />
                      Столбец удалён, правило не работает
                    </p>
                  )}
                </div>
                <div className={styles['rule-table']}>
                  <span className={styles['rule-cell-label']}>Таблица</span>
                  {rule.table_title}
                </div>
                <div className={styles['rule-toggle']}>
                  <label className={styles['rule-check']}>
                    <input
                      type="checkbox"
                      checked={rule.is_enabled}
                      disabled={busyId === rule.id}
                      data-testid={`telegram-rule-toggle-${rule.id}`}
                      onChange={(event) => void toggle(rule, event.target.checked)}
                    />
                    <span>{rule.is_enabled ? 'Вкл' : 'Выкл'}</span>
                  </label>
                </div>
                <div className={styles['rule-action']}>
                  <button
                    className="link-button"
                    type="button"
                    data-testid={`telegram-rule-delete-${rule.id}`}
                    disabled={busyId === rule.id}
                    onClick={() => void remove(rule)}
                  >
                    Удалить
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {actionError && (
            <p
              className={`alert alert--error ${styles['rules-action-error']}`}
              role="alert"
              data-testid="telegram-rules-action-error"
            >
              {actionError}
            </p>
          )}
        </>
      )}

      {dialog && dormitoryId !== null && catalog !== null && (
        <NotificationRuleDialog
          dormitoryId={dormitoryId}
          dormitoryName={current?.name ?? ''}
          catalog={catalog}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
    </section>
  );
}
