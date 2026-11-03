import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TableKey } from '../../api/client';
import type { SourceTable } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { EditorSurfaceContext } from '../../components/EditorSurface';
import type { EditorSnapshot } from '../../components/EditorSurface';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import cabinet from '../../workspace/Workspace.module.css';
import { ReportTable, RowDialog } from '../../workspace/dormitories/ReportTable';
import { DormitorySettingsDialog } from '../../workspace/dormitories/DormitorySettingsDialog';
import { CreateDormitoryDialog } from '../../workspace/dormitories/CreateDormitoryDialog';
import { CreateCustomTabDialog } from '../../workspace/dormitories/CreateCustomTabDialog';
import { ManageCustomTabsDialog } from '../../workspace/dormitories/ManageCustomTabsDialog';
import { CreateTableDialog } from '../../workspace/dormitories/CreateTableDialog';
import { ReportTemplatesPanel } from '../../workspace/dormitories/ReportTemplatesPanel';
import {
  ColumnsControls,
  TableColumnsProvider,
} from '../../workspace/dormitories/ConfigurableColumns';
import { BindingDialog } from '../../workspace/personnel/BindingDialog';
import { SettingsDialog as ArrivalSettingsDialog } from '../../workspace/personnel/arrivals/SettingsDialog';
import { ArrivalCard } from '../../workspace/personnel/arrivals/ArrivalFields';
import { reconfigureArrival } from '../../workspace/personnel/arrivals/data';
import { DashboardBlocks } from '../../workspace/dashboard/DashboardBlocks';
import { EMPTY_DASHBOARD } from '../../workspace/dashboard/data';
import { Statistics } from '../../workspace/Statistics';
import { ListsEditor, PersonnelBlocks } from '../constructor-sandbox/Area';
import { TablePreview } from '../constructor-sandbox/Preview';
import { Sandbox, RANGE, copy } from '../constructor-sandbox/store';
import { installSandboxApis } from '../constructor-sandbox/api';
import { WindowDraftContext } from './WindowDraftContext';
import { WindowIntro } from './WindowIntro';
import { WindowSplit } from './WindowSplit';
import { OrganizedWindow } from './OrganizedWindow';
import s from './Windows.module.css';

const BASE = '/preview/constructors-windows';
const views = [
  { id: 'report', name: 'Общий отчёт', icon: 'document' },
  { id: 'table', name: 'Таблицы и вкладки', icon: 'house' },
  { id: 'arrivals', name: 'План заездов', icon: 'door' },
  { id: 'personnel', name: 'Персонал', icon: 'people' },
  { id: 'dashboard', name: 'Обзор', icon: 'overview' },
  { id: 'statistics', name: 'Статистика', icon: 'chart' },
] as const;
type View = (typeof views)[number]['id'];
type WindowKind =
  | 'formula'
  | 'links'
  | 'places'
  | 'structure'
  | 'structure-templates'
  | 'create-dormitory'
  | 'create-tab'
  | 'tabs'
  | 'create-table'
  | 'report-templates'
  | 'binding'
  | 'arrival-fields'
  | 'arrival-display'
  | null;

export function ConstructorWindows({
  liveResult = false,
  organizationDemo = false,
}: {
  liveResult?: boolean;
  organizationDemo?: boolean;
}): JSX.Element {
  const basePath = organizationDemo
    ? '/preview/constructors-organized'
    : liveResult
      ? '/preview/constructors-windows-live'
      : BASE;
  const [organized, setOrganized] = useState(true);
  const [store] = useState(() => {
    const data = new Sandbox();
    if (organizationDemo)
      for (const dorm of data.dorms)
        dorm.rows.push({
          id: data.id(),
          name: 'Потребность на завтра',
          formula: '=([Проживает М]+[Проживает Ж])+[Прибыло]-[Выбыло]',
          link: null,
          position: dorm.rows.length,
          values: {},
          errors: {},
        });
    return data;
  });
  const [formulaRowIds] = useState(
    () =>
      new Map(
        store.dorms.map((item) => [
          String(item.info.id),
          item.rows.find((row) => row.name === 'Потребность на завтра')?.id,
        ]),
      ),
  );
  const [ready, setReady] = useState(false);
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requested = params.get('section');
  const view: View = location.pathname.includes('/statistics')
    ? 'statistics'
    : (views.find((item) => item.id === requested)?.id ?? 'report');
  const [windowKind, setWindowKind] = useState<WindowKind>(
    (params.get('window') as WindowKind) ?? null,
  );
  const [dorm, setDorm] = useState('1');
  const [table, setTable] = useState<TableKey>('residents');
  const [personnelTab, setPersonnelTab] = useState<'blocks' | 'lists'>('blocks');
  const [menu, setMenu] = useState(false);
  const [revision, refresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const publish = useCallback((value: EditorSnapshot) => {
    setSnapshot(value);
    if (value.kind === 'none') setForm({});
  }, []);
  const surface = useMemo(
    () => ({
      inline: false,
      windowed: !organizationDemo || organized,
      organized: organizationDemo && organized,
      intro: organizationDemo ? undefined : WindowIntro,
      layout: organizationDemo
        ? organized
          ? OrganizedWindow
          : undefined
        : liveResult
          ? WindowSplit
          : undefined,
      publish,
    }),
    [publish, liveResult, organizationDemo, organized],
  );
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    const restore = installSandboxApis(store);
    setReady(true);
    return restore;
  }, [store]);
  useEffect(() => {
    const old = document.title;
    document.title = organizationDemo
      ? 'Понятная организация конструкторов — Домовой'
      : liveResult
        ? 'Настройки + живой результат в окне — Домовой'
        : 'Конструкторы в отдельных окнах — Домовой';
    return () => {
      document.title = old;
    };
  }, [liveResult, organizationDemo]);
  const source = store.dorm(dorm);
  const selected = views.find((item) => item.id === view)!;
  function go(next: View): void {
    navigate(next === 'statistics' ? `${basePath}/statistics` : `${basePath}?section=${next}`);
    setMenu(false);
    setNotice('');
  }
  function show(kind: WindowKind): void {
    setSnapshot(null);
    setWindowKind(kind);
    setNotice('');
  }
  function close(): void {
    setWindowKind(null);
    setSnapshot(null);
  }
  function changed(message = 'Изменения сохранены.'): void {
    refresh((value) => value + 1);
    setNotice(message);
  }
  function saved(message: string): void {
    changed(message);
    close();
  }
  const row = organizationDemo
    ? (source.rows.find((item) => item.id === formulaRowIds.get(dorm)) ?? null)
    : source.rows.find((item) => item.name === 'Проживает Итого')!;
  const emptyTab = source.settings.tabs.find((item) => !item.table_created);
  const dashboardData = {
    ...EMPTY_DASHBOARD,
    layout: copy(store.layout),
    widgets: store.layout.blocks.map((block) => ({
      ...store.widget(block.config, RANGE.from, RANGE.to),
      id: block.id,
    })),
  };
  const activeWindow = (): JSX.Element | null => {
    if (!ready || !windowKind) return null;
    if (windowKind === 'formula' || windowKind === 'links' || windowKind === 'places')
      return (
        <RowDialog
          dormitoryId={dorm}
          row={windowKind === 'formula' ? row : null}
          initialLink={
            windowKind === 'places'
              ? { table_key: 'places', hostel_id: null, metric: 'free_total' }
              : windowKind === 'links'
                ? source.rows.find((item) => item.link)?.link
                : undefined
          }
          rows={store.report(dorm, RANGE.from, RANGE.to).rows}
          onClose={close}
          onChanged={() => changed('Строка отчёта сохранена.')}
        />
      );
    if (windowKind === 'structure' || windowKind === 'structure-templates')
      return (
        <DormitorySettingsDialog
          dormitoryId={dorm}
          initialKey={table}
          initialPage={windowKind === 'structure-templates' ? 'templates' : 'structure'}
          onClose={close}
          onChanged={() => changed('Настройки общежития сохранены.')}
          onOpen={(key) => {
            if (key === 'report') go('report');
            else {
              setTable(key as TableKey);
              go('table');
            }
            close();
          }}
        />
      );
    if (windowKind === 'create-dormitory')
      return (
        <CreateDormitoryDialog
          triggerRef={trigger}
          onClose={close}
          onCreated={(item) => {
            setDorm(String(item.id));
            saved(`Общежитие «${item.name}» создано.`);
          }}
        />
      );
    if (windowKind === 'create-tab')
      return (
        <CreateCustomTabDialog
          dormitoryId={dorm}
          onClose={close}
          onCreated={(tab) => {
            setTable(tab.table_key);
            go('table');
            saved(`Вкладка «${tab.name}» создана.`);
          }}
        />
      );
    if (windowKind === 'tabs')
      return (
        <ManageCustomTabsDialog
          dormitoryId={dorm}
          onClose={close}
          onLoaded={() => undefined}
          onChanged={() => changed('Вкладки обновлены.')}
          onDeleted={() => changed('Вкладка удалена.')}
          beforeChange={async () => undefined}
          onOpen={(tab) => {
            setTable(tab.table_key);
            go('table');
            close();
          }}
          onStandardChanged={() => changed()}
          onStandardOpen={(section) => {
            if (section.key === 'report') go('report');
            else {
              setTable(section.key as TableKey);
              go('table');
            }
            close();
          }}
        />
      );
    if (windowKind === 'create-table' && emptyTab)
      return (
        <CreateTableDialog
          dormitoryId={dorm}
          tab={emptyTab}
          onClose={close}
          onCreated={(tab) => {
            setTable(tab.table_key);
            saved('Таблица создана.');
          }}
        />
      );
    if (windowKind === 'binding')
      return (
        <BindingDialog
          dormitoryId={dorm}
          tableKey={
            (table.startsWith('custom_') || table === 'archive'
              ? table
              : (source.settings.tabs[0]?.table_key ?? 'archive')) as SourceTable
          }
          onClose={close}
          onSaved={() => saved('Связь с персоналом сохранена.')}
        />
      );
    if (windowKind === 'arrival-fields' || windowKind === 'arrival-display')
      return (
        <ArrivalSettingsDialog
          settings={store.arrivalSettings}
          initialTab={windowKind === 'arrival-fields' ? 'fields' : 'display'}
          sample={store.arrivalSample}
          preview={false}
          usedFields={['shifts', 'transport', 'workdate']}
          onClose={close}
          onSave={(settings) => {
            store.arrivalSample = reconfigureArrival(
              store.arrivalSample,
              store.arrivalSettings,
              settings,
            );
            store.arrivalSettings = settings;
            store.changed();
            saved('Поля формы и правая панель сохранены.');
          }}
        />
      );
    if (windowKind === 'report-templates')
      return (
        <Modal title="Шаблоны отчётов" testId="window-report-templates" onClose={close}>
          <ReportTemplatesPanel />
        </Modal>
      );
    return (
      <Modal title="Создание таблицы" testId="window-create-table" onClose={close}>
        <p>Сначала создайте вкладку без таблицы.</p>
        <button className="btn btn--primary btn--compact" onClick={() => show('create-tab')}>
          Создать вкладку
        </button>
      </Modal>
    );
  };
  const content = (): JSX.Element => {
    if (view === 'report') return <ReportTable key={revision} dormitoryId={dorm} range={RANGE} />;
    if (view === 'table')
      return (
        <>
          <div className={s.tableToolbar}>
            <label>
              Таблица
              <select
                aria-label="Таблица общежития"
                value={table}
                onChange={(event) => setTable(event.target.value as TableKey)}
              >
                {Object.keys(source.settings.tables).map((key) => (
                  <option key={key} value={key}>
                    {source.settings.tabs.find((tab) => tab.table_key === key)?.name ??
                      source.settings.sections.find((section) => section.key === key)?.name ??
                      key}
                  </option>
                ))}
              </select>
            </label>
            <TableColumnsProvider
              key={`${dorm}-${table}-${revision}`}
              dormitoryId={dorm}
              table={table}
            >
              <ColumnsControls />
            </TableColumnsProvider>
          </div>
          <TablePreview store={store} dorm={dorm} table={table} />
        </>
      );
    if (view === 'arrivals')
      return (
        <div className={s.arrivalBoard}>
          <div className={s.arrivalDay}>
            <span>Понедельник</span>
            <strong>2 ноября</strong>
            <small>Ожидается {store.arrivalSample.count} человек</small>
          </div>
          <ArrivalCard arrival={store.arrivalSample} settings={store.arrivalSettings} />
        </div>
      );
    if (view === 'personnel')
      return (
        <>
          <div className={s.subtabs}>
            <button
              className="btn btn--segment btn--compact"
              aria-pressed={personnelTab === 'blocks'}
              onClick={() => setPersonnelTab('blocks')}
            >
              Рабочая поверхность
            </button>
            <button
              className="btn btn--segment btn--compact"
              aria-pressed={personnelTab === 'lists'}
              onClick={() => setPersonnelTab('lists')}
            >
              Свои списки
            </button>
          </div>
          {personnelTab === 'blocks' ? (
            <PersonnelBlocks store={store} />
          ) : (
            <ListsEditor store={store} />
          )}
        </>
      );
    if (view === 'dashboard')
      return (
        <DashboardBlocks
          key={revision}
          data={dashboardData}
          range={RANGE}
          loading={false}
          onChange={() => changed()}
          cards={[]}
        />
      );
    return (
      <Routes>
        <Route
          path="statistics/:reportId?"
          element={<Statistics basePath={`${basePath}/statistics`} initialRange={RANGE} />}
        />
      </Routes>
    );
  };
  const action = (name: string, kind: WindowKind, primary = false): JSX.Element => (
    <button
      className={`btn ${primary ? 'btn--primary' : 'btn--ghost'} btn--compact`}
      onClick={() => show(kind)}
    >
      {name}
    </button>
  );
  return (
    <WindowDraftContext.Provider value={{ store, dorm, table, snapshot, form }}>
      <EditorSurfaceContext.Provider value={surface}>
        <div
          className={`${cabinet.shell} ${s.page}`}
          data-menu-open={String(menu)}
          onChangeCapture={(event) => {
            if (!(event.target instanceof Element)) return;
            const element = event.target.closest('form');
            if (element instanceof HTMLFormElement)
              setForm(
                Object.fromEntries(
                  [...new FormData(element)].filter(
                    (item): item is [string, string] => typeof item[1] === 'string',
                  ),
                ),
              );
          }}
        >
          <button
            className={cabinet['mobile-backdrop']}
            aria-label="Закрыть меню"
            tabIndex={-1}
            onClick={() => setMenu(false)}
          />
          <aside className={cabinet.sidebar}>
            <Link className={cabinet.brand} to={`${basePath}?section=report`}>
              <span className={s.brand}>
                <WorkspaceIcon name="house" />
              </span>
              <span className={cabinet['brand-name']}>Домовой</span>
            </Link>
            <p className={cabinet['brand-note']}>Учёт проживающих в общежитиях</p>
            <nav className={s.navigation} aria-label="Разделы тестового кабинета">
              {views.map((item) => (
                <button
                  key={item.id}
                  className={cabinet['nav-link']}
                  aria-current={view === item.id ? 'page' : undefined}
                  onClick={() => go(item.id)}
                >
                  <WorkspaceIcon name={item.icon as WorkspaceIconName} />
                  {item.name}
                </button>
              ))}
            </nav>
            <div className={cabinet['sidebar-bottom']}>
              <p className={s.sidebarHint}>
                Настройки открываются в отдельных окнах поверх текущего раздела.
              </p>
              <div className={cabinet.account}>
                <span className={cabinet['account-avatar']}>ДК</span>
                <div>
                  <strong className={cabinet['account-name']}>Тестовый кабинет</strong>
                  <p className={cabinet['account-email']}>Демонстрационные данные</p>
                </div>
              </div>
            </div>
          </aside>
          <div className={cabinet.workspace}>
            <header className={cabinet.topbar}>
              <button
                className={cabinet['menu-toggle']}
                aria-label="Открыть меню разделов"
                aria-expanded={menu}
                onClick={() => setMenu((value) => !value)}
              >
                <WorkspaceIcon name="menu" />
              </button>
              <div className={cabinet.breadcrumbs}>
                <span>Рабочее пространство</span>
                <WorkspaceIcon name="chevron" />
                <strong>{selected.name}</strong>
              </div>
              <span className={cabinet['preview-label']}>Тестовая страница</span>
            </header>
            <main className={s.main}>
              <div className={s.notice}>
                <WorkspaceIcon name="info" />
                <span>
                  {organizationDemo
                    ? 'Привычные окна с понятной организацией настроек.'
                    : liveResult
                      ? 'Настройки + живой результат внутри одного окна.'
                      : 'Привычные окна, более понятные настройки.'}
                </span>
                <small>Изменения действуют только на тестовые данные до перезагрузки.</small>
              </div>
              {organizationDemo && (
                <div className={s.compare}>
                  <div>
                    <strong>Сравните на одной и той же форме</strong>
                    <p>
                      Выберите вариант и откройте конструктор. Поля, ограничения и данные
                      одинаковые.
                    </p>
                  </div>
                  <div className={s.compareButtons}>
                    <button
                      type="button"
                      className="btn btn--segment btn--compact"
                      aria-pressed={!organized}
                      onClick={() => setOrganized(false)}
                    >
                      Сейчас в проекте
                    </button>
                    <button
                      type="button"
                      className="btn btn--segment btn--compact"
                      aria-pressed={organized}
                      onClick={() => setOrganized(true)}
                    >
                      Предлагаемая организация
                    </button>
                  </div>
                </div>
              )}
              <div className={s.heading}>
                <div>
                  <p className={s.client}>{source.info.client_name}</p>
                  <h1>{view === 'statistics' ? 'Статистика' : source.info.name}</h1>
                </div>
                <div className={s.headingActions}>
                  <label className={s.dormPicker}>
                    Общежитие
                    <select
                      aria-label="Тестовое общежитие"
                      value={dorm}
                      onChange={(event) => {
                        setDorm(event.target.value);
                        setTable('residents');
                      }}
                    >
                      {store.dorms.map((item) => (
                        <option key={item.info.id} value={item.info.id}>
                          {item.info.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {action('Настройки общежития', 'structure')}
                  <details className={s.otherActions}>
                    <summary>Ещё</summary>
                    <div>
                      {action('Создать общежитие', 'create-dormitory')}
                      {action('Шаблоны структуры', 'structure-templates')}
                      {action('Шаблоны отчётов', 'report-templates')}
                      {action('Управление вкладками', 'tabs')}
                    </div>
                  </details>
                </div>
              </div>
              <div className={s.sectionHeading}>
                <div>
                  <h2>{selected.name}</h2>
                  <p>
                    {view === 'report'
                      ? '25–31 октября 2026 · данные по дням'
                      : view === 'arrivals'
                        ? '2–8 ноября 2026 · план на неделю'
                        : 'Настройки и данные выбранного раздела'}
                  </p>
                </div>
                <div className={s.actions}>
                  {view === 'report' && (
                    <>
                      {action('Настроить формулу', 'formula')}
                      {action('Связать с таблицей', 'links')}
                      {action('Связать с размещением', 'places')}
                    </>
                  )}
                  {view === 'table' && (
                    <>
                      {action('Добавить вкладку', 'create-tab')}
                      {action('Создать таблицу', 'create-table')}
                      {action('Связь с персоналом', 'binding')}
                    </>
                  )}
                  {view === 'arrivals' && (
                    <>
                      {action('Поля формы', 'arrival-fields')}
                      {action('Правая панель', 'arrival-display')}
                    </>
                  )}
                </div>
              </div>
              {notice && (
                <p className={s.saved} role="status">
                  ✓ {notice}
                </p>
              )}
              <section className={s.content} aria-label="Рабочая область">
                {ready ? content() : <p role="status">Подготовка тестовых данных…</p>}
              </section>
              <details className={s.changes}>
                <summary>Что изменилось в окнах</summary>
                <p>
                  {organizationDemo
                    ? 'Поля объединены по смыслу: назначение, источник, поведение и отображение. У длинных форм есть оглавление с переходом к нужной группе. Формулы редактируются целиком, строки вставляются в позицию курсора. Зависимые настройки находятся рядом с управляющим выбором. Удаление отделено от сохранения.'
                    : liveResult
                      ? 'Настройки и живой результат видны одновременно внутри окна. Пример справа обновляется при изменении полей до сохранения. На узком экране результат расположен под настройками.'
                      : 'Настройки открываются поверх текущего раздела. Заголовок и пояснение помогают понять действие. Поля собраны по смыслу, а пример результата можно раскрыть внутри окна.'}{' '}
                  Все существующие типы, связи, шаблоны и проверки сохранены.
                </p>
              </details>
              {store.unsupported.size > 0 && (
                <p role="alert">Недоступное действие стенда: {[...store.unsupported].join(', ')}</p>
              )}
            </main>
          </div>
          {activeWindow()}
        </div>
      </EditorSurfaceContext.Provider>
    </WindowDraftContext.Provider>
  );
}
