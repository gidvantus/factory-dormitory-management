import { useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { EditorSnapshot } from '../../components/EditorSurface';
import type { SavedList } from '../../api/personnel';
import { filterPeople } from '../../workspace/personnel/helpers';
import structureStyles from '../../workspace/dormitories/DormitorySettingsDialog.module.css';
import { LivePreview, TablePreview } from '../constructor-sandbox/Preview';
import type { Scene } from '../constructor-sandbox/inventory';
import { WindowDraftContext } from './WindowDraftContext';
import { WindowIntro } from './WindowIntro';
import s from './WindowSplit.module.css';

const editors: Record<string, { kind: string; scene: Scene }> = {
  'report-row-modal': { kind: 'report-row', scene: 'formula' },
  'column-editor-modal': { kind: 'column', scene: 'columns' },
  'create-custom-tab-modal': { kind: 'create-tab', scene: 'create-tab' },
  'create-table-modal': { kind: 'create-table', scene: 'create-table' },
  'personnel-binding': { kind: 'binding', scene: 'binding' },
  'dashboard-widget-dialog': { kind: 'dashboard-block', scene: 'dashboard' },
  'personnel-block-editor': { kind: 'personnel-block', scene: 'personnel-blocks' },
  'personnel-save-list': { kind: 'personnel-save-list', scene: 'personnel-lists' },
  'dormitory-settings-modal': { kind: 'structure', scene: 'structure' },
  'manage-columns-modal': { kind: 'columns-manager', scene: 'columns' },
  'manage-custom-tabs-modal': { kind: 'tabs-manager', scene: 'tabs' },
  'save-report-template-modal': { kind: 'report-template', scene: 'report-templates' },
};

export function WindowSplit({
  editorId,
  children,
}: {
  editorId: string;
  children: ReactNode;
}): JSX.Element {
  const context = useContext(WindowDraftContext);
  const editor = editors[editorId];
  const [lastSnapshot, setLastSnapshot] = useState<EditorSnapshot | null>(null);
  useEffect(() => {
    if (context?.snapshot?.kind === editor?.kind && context?.snapshot)
      setLastSnapshot(context.snapshot);
  }, [context?.snapshot, editor?.kind]);
  if (!editor || !context)
    return (
      <>
        <WindowIntro editorId={editorId} />
        {children}
      </>
    );
  const snapshot =
    context.snapshot?.kind === editor.kind
      ? context.snapshot
      : lastSnapshot?.kind === editor.kind
        ? lastSnapshot
        : null;
  const result = (): JSX.Element => {
    if (editor.kind === 'columns-manager')
      return (
        <>
          <h2>Текущая таблица</h2>
          <TablePreview store={context.store} dorm={context.dorm} table={context.table} />
          <p>Откройте столбец для изменения — его черновик появится рядом с настройками.</p>
        </>
      );
    if (editor.kind === 'tabs-manager')
      return (
        <>
          <h2>Вкладки общежития</h2>
          <ul className={s.tabList}>
            {context.store.dorm(context.dorm).settings.tabs.map((tab) => (
              <li key={tab.id}>
                <strong>{tab.name}</strong>
                <span>
                  {tab.is_active ? 'Видна в общежитии' : 'Скрыта'} ·{' '}
                  {tab.table_created ? 'С таблицей' : 'Без таблицы'}
                </span>
              </li>
            ))}
          </ul>
        </>
      );
    if (editor.kind === 'report-template')
      return (
        <>
          <h2>Состав шаблона</h2>
          <ul className={s.tabList}>
            {context.store.dorm(context.dorm).rows.map((row) => (
              <li key={row.id}>
                <strong>{row.name}</strong>
                <span>
                  {row.formula ?? (row.link ? 'Связь с источником' : 'Ручное заполнение')}
                </span>
              </li>
            ))}
          </ul>
          <p>Ежедневные значения в шаблон не входят.</p>
        </>
      );
    if (!snapshot)
      return (
        <p className={s.empty} role="status">
          Подготовка примера…
        </p>
      );
    if (editor.kind === 'personnel-save-list') {
      const criteria = (snapshot.value as { criteria: Omit<SavedList, 'id' | 'name'> }).criteria;
      const people = filterPeople(context.store.personnel, criteria);
      return (
        <>
          <h2>{context.form.name || 'Новый список сотрудников'}</h2>
          <p>По сохранённым условиям найдено: {people.length}</p>
          <ul className={s.tabList}>
            {people.map((person) => (
              <li key={person.id}>
                <strong>{person.full_name}</strong>
                <span>
                  {person.personnel_number || 'Без табельного номера'} ·{' '}
                  {person.phone || 'Телефон не заполнен'}
                </span>
              </li>
            ))}
          </ul>
        </>
      );
    }
    return (
      <LivePreview
        store={context.store}
        dorm={context.dorm}
        table={context.table}
        scene={editor.scene}
        snapshot={snapshot}
        form={context.form}
        rowId={
          snapshot.kind === 'report-row' ? (snapshot.value as { rowId: number | null }).rowId : null
        }
      />
    );
  };
  return (
    <div className={s.split} data-window-split="true">
      {editorId === 'dormitory-settings-modal' && (
        <style>{`
        .${s.settings} .${structureStyles.workspace}{grid-template-columns:minmax(0,1fr)}
        .${s.settings} .${structureStyles.sidebar}{max-height:180px;overflow:auto;border-right:0;border-bottom:1px solid var(--color-border);padding:12px}
        .${s.settings} .${structureStyles.editor}{padding:20px 0;overflow:visible}
        .${s.settings} .${structureStyles.editorHeading}{flex-wrap:wrap}
        .${s.settings} .${structureStyles.pages}{padding:12px 0;flex-wrap:wrap}
        .${s.settings} .${structureStyles.footer}{position:sticky;bottom:-24px;background:var(--color-bg-surface);z-index:2}
      `}</style>
      )}
      <section className={s.settings} aria-label="Настройки конструктора">
        <div className={s.sectionTitle}>Настройки</div>
        <WindowIntro editorId={editorId} showPreview={false} />
        {children}
      </section>
      <aside
        className={s.result}
        aria-label="Живой результат конструктора"
        aria-live="polite"
        aria-atomic="false"
      >
        <div className={s.resultHead}>
          <strong>
            <i />
            Живой результат
          </strong>
          <span>Обновляется при изменении полей</span>
        </div>
        <div className={s.resultContent}>{result()}</div>
        <p className={s.note}>Демонстрационные данные. Изменения применятся после сохранения.</p>
      </aside>
    </div>
  );
}
