import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import { BUILTIN_BLOCK_NAMES } from '../../api/dashboardBlocks';
import type { BuiltinBlockConfig, BuiltinMetric, DashboardLayout } from '../../api/dashboardBlocks';
import { Modal, ModalCancelButton } from '../../components/Modal';
import styles from './WidgetDialog.module.css';

export function BuiltinBlockDialog({
  metric,
  layout,
  onSaved,
  onClose,
  onRefresh,
}: {
  metric: BuiltinMetric;
  layout: DashboardLayout;
  onSaved: (layout: DashboardLayout) => void;
  onClose: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const [config, setConfig] = useState<BuiltinBlockConfig>(
    () =>
      layout.builtin_settings?.[metric] ?? {
        name: BUILTIN_BLOCK_NAMES[metric],
        date_mode: 'overview',
        aggregate: 'last',
      },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const { revision, order, hidden, builtin_settings } = layout;
      onSaved(
        await api.saveDashboardLayout({
          revision,
          order,
          hidden,
          builtin_settings: { ...builtin_settings, [metric]: config },
        }),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить блок.');
      if (caught instanceof ApiError && caught.status === 409) onRefresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Настройки блока"
      testId="builtin-block-settings"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <fieldset className={styles.fields} disabled={saving}>
          <label className={styles.field}>
            Название блока
            <input
              value={config.name}
              required
              maxLength={120}
              onChange={(event) => setConfig({ ...config, name: event.target.value })}
            />
          </label>
          <label className={styles.field}>
            Выбор дат
            <select
              value={config.date_mode}
              onChange={(event) =>
                setConfig({
                  ...config,
                  date_mode: event.target.value as BuiltinBlockConfig['date_mode'],
                })
              }
            >
              <option value="overview">Общий период «Обзора»</option>
              <option value="date">Дата внутри блока</option>
              <option value="range">Период внутри блока</option>
            </select>
          </label>
          {config.date_mode === 'range' && (
            <label className={styles.field}>
              Показатель за период
              <select
                value={config.aggregate}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    aggregate: event.target.value as BuiltinBlockConfig['aggregate'],
                  })
                }
              >
                <option value="last">Значение на последний день</option>
                <option value="average">Среднее за период</option>
                <option value="sum">Сумма за период</option>
              </select>
            </label>
          )}
        </fieldset>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <ModalCancelButton onClick={onClose} disabled={saving}>
            Отмена
          </ModalCancelButton>
          <button type="submit" className={styles.primary} disabled={saving || !config.name.trim()}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
