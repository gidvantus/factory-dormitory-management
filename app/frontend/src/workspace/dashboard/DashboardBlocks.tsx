import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../../api/client';
import type { DashboardLayout, WidgetDefinition } from '../../api/dashboardBlocks';
import { DEFAULT_LAYOUT } from '../../api/dashboardBlocks';
import { Modal } from '../../components/Modal';
import type { DashboardData } from './data';
import { formatCount } from './data';
import type { DateRange } from './dates';
import { formatDate } from './dates';
import { WidgetDialog } from './WidgetDialog';
import { WidgetChart } from './WidgetChart';
import styles from './Dashboard.module.css';

interface BuiltinCard {
  key: string;
  name: string;
  content: ReactNode;
}
export function DashboardBlocks({
  data,
  range,
  loading,
  cards,
  onChange,
}: {
  data: DashboardData;
  range: DateRange;
  loading: boolean;
  cards: BuiltinCard[];
  onChange: () => void;
}): JSX.Element {
  const [layout, setLayout] = useState<DashboardLayout>(data.layout ?? DEFAULT_LAYOUT);
  const [arranging, setArranging] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<WidgetDefinition | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<WidgetDefinition | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  useEffect(() => {
    if (data.layout) {
      const incoming = data.layout;
      setLayout((current) => (incoming.revision >= current.revision ? incoming : current));
    }
  }, [data.layout]);
  const visible = layout.order.filter((key) => !layout.hidden.includes(key));
  const name = (key: string): string =>
    cards.find((card) => card.key === key)?.name ??
    layout.blocks.find((block) => 'custom:' + block.id === key)?.config.name ??
    key;
  const saved = (next: DashboardLayout): void => {
    setLayout(next);
    setEditing(undefined);
    setDeleting(null);
    setError('');
    onChange();
  };
  async function saveOrder(order: string[], hidden = layout.hidden): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      saved(await api.saveDashboardLayout({ revision: layout.revision, order, hidden }));
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить порядок.');
      if (caught instanceof ApiError && caught.status === 409) onChange();
    } finally {
      setSaving(false);
      setDragging(null);
    }
  }
  function move(source: string, target: string): void {
    if (source === target || saving) return;
    const order = layout.order.filter((key) => key !== source),
      index = layout.order.indexOf(target);
    order.splice(index, 0, source);
    void saveOrder(order);
  }
  async function remove(): Promise<void> {
    if (!deleting || saving) return;
    setSaving(true);
    setError('');
    try {
      saved(await api.deleteDashboardBlock(deleting.id, layout.revision));
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось удалить блок.');
      if (caught instanceof ApiError && caught.status === 409) onChange();
    } finally {
      setSaving(false);
    }
  }
  const valuesFresh = !data.layout || data.layout.revision === layout.revision;
  return (
    <>
      <div className={styles.blocksHeading}>
        <div>
          <h2>Блоки дашборда</h2>
          <p>Общие для всех пользователей</p>
        </div>
        <div className={styles.blocksActions}>
          <button type="button" onClick={() => setEditing(null)} disabled={saving || loading}>
            + Добавить блок
          </button>
          <button
            type="button"
            aria-pressed={arranging}
            onClick={() => setArranging((value) => !value)}
          >
            {arranging ? 'Готово' : 'Настроить блоки'}
          </button>
          {layout.hidden.length > 0 && (
            <button
              type="button"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((value) => !value)}
            >
              Скрытые ({layout.hidden.length})
            </button>
          )}
        </div>
      </div>
      {arranging && (
        <p className={styles.blocksHint}>
          Перетаскивайте блоки за «⠿» или используйте стрелки. Изменения сохраняются для всех
          пользователей.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.loadError}>
          {error}{' '}
          <button type="button" onClick={onChange}>
            Обновить дашборд
          </button>
        </p>
      )}
      {showHidden && layout.hidden.length > 0 && (
        <div className={styles.hiddenBlocks} aria-label="Скрытые блоки">
          {layout.order
            .filter((key) => layout.hidden.includes(key))
            .map((key) => (
              <div key={key}>
                <span>{name(key)}</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void saveOrder(
                      layout.order,
                      layout.hidden.filter((item) => item !== key),
                    )
                  }
                >
                  Показать
                </button>
              </div>
            ))}
        </div>
      )}
      <div className={styles.breakdownGrid} aria-busy={loading || saving}>
        {visible.map((key, index) => {
          const builtin = cards.find((card) => card.key === key),
            block = layout.blocks.find((item) => 'custom:' + item.id === key),
            result = data.widgets?.find((item) => item.id === block?.id);
          return (
            <div
              key={key}
              className={styles.blockTile}
              data-block-key={key}
              data-dragging={dragging === key ? 'true' : 'false'}
              onDragOver={(event) => {
                if (arranging && !saving) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) move(dragging, key);
              }}
            >
              {arranging && (
                <div className={styles.blockTools}>
                  <span
                    role="img"
                    className={styles.dragHandle}
                    draggable={!saving}
                    aria-label={'Перетащить блок «' + name(key) + '»'}
                    onDragStart={(event) => {
                      setDragging(key);
                      event.dataTransfer.setData('text/plain', key);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragging(null)}
                  >
                    ⠿
                  </span>
                  <button
                    type="button"
                    disabled={saving || index === 0}
                    aria-label={'Переместить «' + name(key) + '» выше'}
                    onClick={() => move(key, visible[index - 1])}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={saving || index === visible.length - 1}
                    aria-label={'Переместить «' + name(key) + '» ниже'}
                    onClick={() => move(key, visible[index + 1])}
                  >
                    ↓
                  </button>
                  {block && (
                    <button type="button" disabled={saving} onClick={() => setEditing(block)}>
                      Настроить
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveOrder(layout.order, [...layout.hidden, key])}
                  >
                    Скрыть
                  </button>
                  {block && (
                    <button type="button" disabled={saving} onClick={() => setDeleting(block)}>
                      Удалить
                    </button>
                  )}
                </div>
              )}
              {builtin?.content}
              {block && (
                <section
                  className={`${styles.card} ${styles.widgetCard}`}
                  aria-labelledby={'widget-title-' + block.id}
                >
                  <div className={styles.cardHead}>
                    <div>
                      <h3 className={styles.cardTitle} id={'widget-title-' + block.id}>
                        {block.config.name}
                      </h3>
                      <p className={styles.cardSubtitle}>
                        {block.config.display === 'chart'
                          ? 'По дням · ' + formatDate(range.from) + ' — ' + formatDate(range.to)
                          : block.config.period === 'snapshot'
                            ? 'На дату среза' +
                              (data.snapshotDate ? ' · ' + formatDate(data.snapshotDate) : '')
                            : 'За период · ' +
                              formatDate(range.from) +
                              ' — ' +
                              formatDate(range.to)}
                      </p>
                    </div>
                  </div>
                  {!result || !valuesFresh ? (
                    <p className={styles.widgetHint} role="status">
                      Пересчитываем показатель…
                    </p>
                  ) : (
                    <>
                      {block.config.display === 'chart' ? (
                        <WidgetChart result={result} range={range} name={block.config.name} />
                      ) : block.config.display === 'number' ? (
                        <p className={styles.widgetNumber}>{formatCount(result.value)}</p>
                      ) : result.items.length ? (
                        <ul className={styles.metricList}>
                          {result.items.map((item) => (
                            <li
                              key={item.label}
                              data-archived={item.is_archived ? 'true' : 'false'}
                            >
                              <span>
                                {item.label}
                                {item.is_archived ? ' (Архив)' : ''}
                              </span>
                              <strong>{formatCount(item.value)}</strong>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.widgetHint}>
                          {result.errors.length
                            ? 'Нет полного результата'
                            : 'Нет подходящих записей'}
                        </p>
                      )}
                      {result.errors.length > 0 && (
                        <details className={styles.widgetErrors}>
                          <summary>Не удалось учесть все данные ({result.errors.length})</summary>
                          {result.errors.map((message) => (
                            <p key={message}>{message}</p>
                          ))}
                        </details>
                      )}
                    </>
                  )}
                  <p className={styles.reportNote}>
                    {block.config.source_kind === 'report'
                      ? 'Большой отчёт'
                      : block.config.source_kind === 'places'
                        ? 'Места'
                        : block.config.operation === 'count'
                          ? 'Количество строк'
                          : 'Сумма столбца'}{' '}
                    · {block.config.all_dormitories ? 'Все общежития' : 'Выбранные общежития'}
                    {block.config.display === 'chart' && block.config.source_kind === 'table'
                      ? block.config.period === 'snapshot'
                        ? ' · Накопительно'
                        : ' · За каждый день'
                      : ''}
                  </p>
                </section>
              )}
            </div>
          );
        })}
      </div>
      {editing !== undefined && (
        <WidgetDialog
          initial={editing}
          revision={layout.revision}
          range={range}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
          onRefresh={onChange}
        />
      )}
      {deleting && (
        <Modal
          title="Удалить блок?"
          testId="delete-dashboard-block"
          onClose={() => setDeleting(null)}
          closeDisabled={saving}
        >
          <p>Удалить блок «{deleting.config.name}» с общего дашборда?</p>
          <div className={styles.blocksActions}>
            <button type="button" disabled={saving} onClick={() => setDeleting(null)}>
              Отмена
            </button>
            <button type="button" disabled={saving} onClick={() => void remove()}>
              Удалить блок
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
