import { useEffect, useRef, useState } from 'react';

import { ApiError, getAccessRights, updateAccessRights } from '../api/client';
import type { AccessRole, RolePermission } from '../api/client';
import { OperatorNav } from '../components/OperatorNav';
import { OperatorTopBar } from '../components/OperatorTopBar';
import { Screen } from '../components/Screen';
import s from './AccessRights.module.css';

const ROLES: Record<AccessRole, string> = {
  manager: 'Менеджер',
  admin: 'Администратор',
  commandant: 'Комендант',
};
const RIGHTS = [
  { key: 'import_enabled', label: 'Импорт' },
  { key: 'export_enabled', label: 'Экспорт' },
  { key: 'overview_enabled', label: 'Обзор' },
  { key: 'dormitories_enabled', label: 'Общежития' },
  { key: 'personnel_enabled', label: 'Персонал' },
  { key: 'statistics_enabled', label: 'Статистика' },
  { key: 'documents_enabled', label: 'Документы' },
  { key: 'shop_enabled', label: 'Магазин улучшений' },
  { key: 'organization_enabled', label: 'Организация' },
  { key: 'members_enabled', label: 'Сотрудники' },
  { key: 'profile_enabled', label: 'Личные данные' },
] as const;

export function AccessRights(): JSX.Element {
  const [rows, setRows] = useState<RolePermission[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setError('');
    void getAccessRights().then(
      (data) => {
        if (!cancelled) setRows(data);
      },
      (caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить права доступа',
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  async function toggle(
    row: RolePermission,
    key: (typeof RIGHTS)[number]['key'],
    checked: boolean,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    setRows(
      (current) =>
        current?.map((item) => (item.role === row.role ? { ...row, [key]: checked } : item)) ??
        null,
    );
    try {
      const saved = await updateAccessRights(row.role, { [key]: checked });
      setRows(
        (current) => current?.map((item) => (item.role === saved.role ? saved : item)) ?? null,
      );
      setNotice('Изменения сохранены');
    } catch (caught) {
      setRows((current) => current?.map((item) => (item.role === row.role ? row : item)) ?? null);
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить права доступа');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Screen nav={<OperatorNav />} right={<OperatorTopBar />}>
      <main className="screen__main">
        <div className={`page ${s.page}`}>
          <div className="page__head">
            <h1 className="page__title">Права доступа</h1>
          </div>
          <p className={s.description}>
            Настройки действуют для сотрудников всех организаций. Отметьте доступные разделы, импорт
            и экспорт для каждой должности. Изменения сохраняются автоматически.
          </p>
          {error && (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          )}
          {rows === null ? (
            error ? (
              <button className="btn btn--ghost" onClick={() => setAttempt((value) => value + 1)}>
                Повторить загрузку
              </button>
            ) : (
              <p className="state" role="status">
                Загружаем права доступа…
              </p>
            )
          ) : (
            <div className={s.card}>
              <table className={s.table} aria-busy={saving}>
                <caption className="visually-hidden">
                  Права должностей на разделы кабинета, импорт и экспорт данных
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Раздел или действие</th>
                    {Object.entries(ROLES).map(([role, label]) => (
                      <th scope="col" key={role}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {RIGHTS.map((right) => (
                    <tr key={right.key}>
                      <th scope="row">{right.label}</th>
                      {rows.map((row) => (
                        <td key={row.role}>
                          <label className={s.control}>
                            <input
                              type="checkbox"
                              aria-label={`${ROLES[row.role]}: ${right.label.toLowerCase()}`}
                              checked={row[right.key]}
                              disabled={saving}
                              onChange={(event) =>
                                void toggle(row, right.key, event.target.checked)
                              }
                            />
                          </label>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={s.note}>
                Владелец организации сохраняет полный доступ. Отключённые разделы скрыты и
                недоступны по прямой ссылке. Разрешения отдельных таблиц также учитываются.
              </p>
            </div>
          )}
          <p className={s.status} role="status" aria-live="polite">
            {saving ? 'Сохраняем…' : notice}
          </p>
        </div>
      </main>
    </Screen>
  );
}
