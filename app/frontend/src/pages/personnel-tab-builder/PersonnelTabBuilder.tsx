import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import { PersonnelBlockIcon } from '../../workspace/personnel/PersonnelBlockIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import { dateLabel, dormName, personName } from '../../workspace/personnel/helpers';
import cabinet from '../../workspace/Workspace.module.css';
import p from '../../workspace/personnel/Personnel.module.css';
import w from '../../workspace/personnel/PersonnelWorkspace.module.css';
import {
  cloneTable,
  isTabVisible,
  kindNames,
  loadState,
  newTab,
  reorderTabs,
  seedData,
  STORAGE_KEY,
  emptyBuilderState,
} from './model';
import type { DemoState, PersonnelTab } from './model';
import { TabEditor } from './TabEditor';
import { BlocksContent, PeopleContent } from './TabContent';
import { TableContent } from './AdvancedTable';
import { PlanningContent } from './PlanningContent';
import s from './Tabs.module.css';
import { isComputed, sourceUsers } from './calculations';
import type { PersonnelData } from '../../api/personnel';
import { Personnel } from '../../workspace/Personnel';
import { loadProjectState, PROJECT_STORAGE_KEY } from './projectModel';
import { ColumnRuleDialog } from './ColumnRuleDialog';
import type { BuilderRuntime } from './BuilderRuntime';
import { useBuilderDraft } from './useBuilderDraft';

export function PersonnelTabBuilder({
  project: previewProject = false,
  projectData,
  runtime,
}: { project?: boolean; projectData?: PersonnelData; runtime?: BuilderRuntime } = {}): JSX.Element {
  const project = previewProject || !!runtime;
  const [localState, setLocalState] = useState<DemoState>(() =>
    runtime ? emptyBuilderState() : project ? loadProjectState() : loadState(),
  );
  const state = runtime?.state ?? localState;
  const setState = runtime?.setState ?? setLocalState;
  const [localData, setData] = useState<PersonnelData>(() =>
    runtime
      ? {
          today: new Date().toISOString().slice(0, 10),
          employees: [],
          dormitories: [],
          arrival_plans: [],
          plans: [],
          preferences: { revision: 0, blocks: null, lists: [] },
        }
      : seedData(),
  );
  const data = runtime?.data ?? projectData ?? localData;
  const [params, setParams] = useSearchParams();
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ tab: PersonnelTab; isNew: boolean } | null>(null);
  const [managing, setManaging] = useState(false);
  const [managerError, setManagerError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [menu, setMenu] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [ruleColumn, setRuleColumn] = useState<string | null>(null);
  useBuilderDraft(!!editor || managing || !!ruleColumn);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState('');
  const visible = state.tabs.filter((tab) => isTabVisible(tab, state.tabs));
  const roots = visible.filter((tab) => !tab.parentId);
  const requested =
    pendingTab ??
    params.get('tab') ??
    (project && params.has('view')
      ? params.get('view') === 'list'
        ? 'employees'
        : params.get('view') === 'planning'
          ? 'planning'
          : 'workspace'
      : state.defaultTab);
  const selected =
    visible.find((tab) => tab.id === requested) ??
    visible.find((tab) => tab.id === state.defaultTab) ??
    roots[0];
  const root = selected.parentId ? roots.find((tab) => tab.id === selected.parentId)! : selected;
  const children = visible.filter((tab) => tab.parentId === root.id);
  const active = root.isGroup
    ? selected.parentId === root.id
      ? selected
      : (children[0] ?? root)
    : selected;
  const person = !project && data.employees.find((item) => item.id === personId);
  const custom = state.tabs.filter((tab) => !tab.builtin && !tab.archived);
  useEffect(() => {
    document
      .getElementById(`personnel-tab-${root.id}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [root.id]);
  useEffect(() => {
    if (runtime) return;
    const previous = document.title;
    document.title = 'Конструктор подвкладок персонала — Домовой';
    return () => {
      document.title = previous;
    };
  }, [runtime]);
  useEffect(() => {
    if (runtime) return;
    try {
      localStorage.setItem(project ? PROJECT_STORAGE_KEY : STORAGE_KEY, JSON.stringify(state));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [state, project, runtime]);
  useEffect(() => {
    if (!editor && !managing && !personId && !ruleColumn) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [editor, managing, personId, ruleColumn]);
  useEffect(() => {
    if (!pendingTab || editor) return;
    // Сначала окно снимает защиту черновика, затем обновляется адрес.
    const timer = setTimeout(() => {
      setParams({ tab: pendingTab });
      setPendingTab(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [pendingTab, editor, setParams]);
  function select(id: string): void {
    setPendingTab(null);
    setParams({ tab: id });
    setNotice('');
  }
  function update(tab: PersonnelTab): void {
    setState((current) => ({
      ...current,
      defaultTab:
        (tab.hidden || tab.archived) &&
        (current.defaultTab === tab.id ||
          current.tabs.some((item) => item.id === current.defaultTab && item.parentId === tab.id))
          ? 'workspace'
          : current.defaultTab,
      tabs: current.tabs.map((item) => (item.id === tab.id ? tab : item)),
    }));
  }
  function employeeView(criteria?: PersonnelTab['criteria']): void {
    if (criteria) update({ ...state.tabs.find((tab) => tab.id === 'employees')!, criteria });
    select('employees');
  }
  function beginEditor(tab: PersonnelTab, isNew: boolean): void {
    if (!runtime) {
      setEditor({ tab, isNew });
      return;
    }
    setLoadingData(true);
    setDataError('');
    void runtime
      .loadData()
      .then(() => setEditor({ tab, isNew }))
      .catch((error) =>
        setDataError(
          error instanceof Error ? error.message : 'Не удалось загрузить данные конструктора',
        ),
      )
      .finally(() => setLoadingData(false));
  }
  const content = (controls?: {
    onPerson: (id: string) => void;
    onList: (criteria: PersonnelTab['criteria']) => void;
  }): JSX.Element => (
    <>
      {root.isGroup && (
        <div className={s.nestedTabs}>
          <div role="tablist" aria-label={`Подвкладки: ${root.name}`} className={s.buttons}>
            {children.map((tab) => (
              <button
                type="button"
                role="tab"
                key={tab.id}
                id={`personnel-child-${tab.id}`}
                aria-selected={active.id === tab.id}
                aria-controls="personnel-tab-content"
                className={`btn ${active.id === tab.id ? 'btn--primary' : 'btn--ghost'} btn--compact`}
                onClick={() => select(tab.id)}
              >
                {tab.name}
              </button>
            ))}
          </div>
          <button
            className="btn btn--outline btn--compact"
            onClick={() =>
              beginEditor(
                {
                  ...cloneTable(root, '', root.tableOptions.table_format === 'calendar'),
                  parentId: root.id,
                },
                true,
              )
            }
          >
            + Вложенная подвкладка
          </button>
        </div>
      )}
      {notice && (
        <p className={s.notice} role="status">
          ✓ {notice}
        </p>
      )}
      {storageError && (
        <p className={s.error} role="alert">
          Браузер не разрешил сохранить пример. До перезагрузки все действия доступны.
        </p>
      )}
      <section
        className={s.content}
        role="tabpanel"
        id="personnel-tab-content"
        aria-labelledby={
          active.parentId ? `personnel-child-${active.id}` : `personnel-tab-${active.id}`
        }
      >
        <div className={s.contentHeading}>
          <div>
            <div className={s.titleLine}>
              <h2>{active.name}</h2>
              {!active.builtin && <span className="tag tag--ok">Своя подвкладка</span>}
            </div>
            {active.description && <p>{active.description}</p>}
          </div>
          {!active.builtin && !active.isGroup && (
            <button
              className="btn btn--ghost btn--compact"
              onClick={() => beginEditor(active, false)}
            >
              <PersonnelBlockIcon name="settings" />
              Настроить подвкладку
            </button>
          )}
        </div>
        {active.kind === 'employees' && (
          <PeopleContent
            key={active.id}
            tab={active}
            data={data}
            onChange={update}
            onPerson={controls?.onPerson ?? setPersonId}
          />
        )}
        {active.kind === 'table' && !active.isGroup && (
          <TableContent
            key={active.id}
            tab={active}
            tabs={state.tabs}
            data={data}
            onChange={update}
            onPerson={controls?.onPerson ?? setPersonId}
            onCopy={() =>
              beginEditor(
                cloneTable(
                  active,
                  `${active.name} — копия`,
                  active.tableOptions.table_format === 'calendar' &&
                    active.rows.some((row) => isComputed(row.rule)),
                ),
                true,
              )
            }
          />
        )}
        {active.isGroup && (
          <div className={s.empty}>
            <strong>В этой вкладке пока нет активных подвкладок</strong>
            <p>Добавьте вложенную подвкладку или восстановите скрытую в управлении.</p>
          </div>
        )}
        {!project &&
          state.tabs
            .filter((tab) => tab.kind === 'planning')
            .map((tab) => (
              <div key={tab.id} hidden={active.id !== tab.id}>
                <PlanningContent
                  data={data}
                  onPlansChange={(arrival_plans) =>
                    setData((current) => ({ ...current, arrival_plans }))
                  }
                />
              </div>
            ))}
        {active.kind === 'blocks' && (
          <BlocksContent
            key={active.id}
            tab={active}
            data={data}
            onChange={update}
            onPerson={controls?.onPerson ?? setPersonId}
            onEmployees={(criteria) =>
              controls
                ? controls.onList(
                    criteria ?? state.tabs.find((tab) => tab.id === 'employees')!.criteria,
                  )
                : employeeView(criteria)
            }
            onPlanning={() => (project ? setParams({ view: 'planning' }) : select('planning'))}
          />
        )}
      </section>
    </>
  );
  const screen = (
    <>
      {!runtime && (
        <div className={s.demoNote}>
          <WorkspaceIcon name="info" />
          <p>
            Тестовая копия страницы «Персонал». Можно менять данные и настройки — они сохраняются
            только в этом браузере.
          </p>
        </div>
      )}
      {dataError && (
        <p role="alert" className={s.error}>
          {dataError}
        </p>
      )}
      <Personnel
        extension={{
          onData: runtime?.onNativeData,
          active: !active.builtin,
          actions: (
            <>
              <button
                className="btn btn--outline btn--compact"
                disabled={runtime && !runtime.ready}
                onClick={() => setManaging(true)}
              >
                Управление подвкладками
              </button>
              <button
                className="btn btn--primary btn--compact"
                disabled={loadingData || (runtime && !runtime.ready)}
                onClick={() => beginEditor(newTab(), true)}
              >
                + Добавить подвкладку
              </button>
            </>
          ),
          tabs: roots
            .filter((tab) => !tab.builtin)
            .map((tab) => (
              <button
                key={tab.id}
                id={`personnel-tab-${tab.id}`}
                role="tab"
                aria-selected={root.id === tab.id}
                onClick={() => select(tab.id)}
              >
                {tab.name}
              </button>
            )),
          content: (controls) => (
            <div className={s.page}>
              {!runtime && active.id === 'work-register' && (
                <div className={s.tryHint}>
                  <p>
                    Попробуйте: нажмите «Изменить» у сотрудника и поменяйте часы или ставку.
                    «Начислено» пересчитается, телефон подтянется из карточки. Формула и связь
                    настраиваются кнопкой «Настроить подвкладку».
                  </p>
                  <div className={s.buttons}>
                    <button
                      className="btn btn--outline btn--compact"
                      onClick={() => setRuleColumn('work-total')}
                    >
                      Изменить формулу начисления
                    </button>
                    <button
                      className="btn btn--outline btn--compact"
                      onClick={() => setRuleColumn('work-phone')}
                    >
                      Настроить связь с карточкой
                    </button>
                  </div>
                </div>
              )}
              {runtime && !runtime.data ? (
                <p role="status">Загружаем данные подвкладки…</p>
              ) : (
                content(controls)
              )}
            </div>
          ),
        }}
      />
    </>
  );
  const dialogs = (
    <>
      {ruleColumn && active.columns.some((column) => column.id === ruleColumn) && (
        <ColumnRuleDialog
          key={`${active.id}:${ruleColumn}`}
          tab={active}
          tabs={state.tabs}
          column={active.columns.find((column) => column.id === ruleColumn)!}
          data={data}
          onSave={update}
          onClose={() => setRuleColumn(null)}
        />
      )}
      {editor && (
        <TabEditor
          key={editor.tab.id}
          initial={editor.tab}
          tabs={state.tabs}
          data={data}
          isNew={editor.isNew}
          isDefault={state.defaultTab === editor.tab.id}
          onClose={() => setEditor(null)}
          onSave={(tab, makeDefault, childrenNames) => {
            const childTabs = childrenNames.map((name) => ({
              ...cloneTable(tab, name, tab.tableOptions.table_format === 'calendar'),
              parentId: tab.id,
            }));
            const savedTab = childrenNames.length ? { ...tab, isGroup: true } : tab;
            setState((current) => ({
              ...current,
              defaultTab: makeDefault
                ? tab.id
                : current.defaultTab === tab.id
                  ? 'workspace'
                  : current.defaultTab,
              tabs: editor.isNew
                ? [...current.tabs, savedTab, ...childTabs]
                : current.tabs.map((item) => (item.id === tab.id ? savedTab : item)),
            }));
            setEditor(null);
            setPendingTab(tab.id);
            setNotice(
              editor.isNew
                ? `Подвкладка «${tab.name}» создана.`
                : 'Настройки подвкладки сохранены.',
            );
          }}
        />
      )}
      {managing && (
        <Modal
          title="Подвкладки персонала"
          testId="personnel-tab-manager"
          panelClassName={s.manager}
          onClose={() => setManaging(false)}
        >
          <div className={s.managerBody}>
            {managerError && (
              <p role="alert" className={s.error}>
                {managerError}
              </p>
            )}
            <p className={s.muted}>
              Основные разделы остаются на месте. Свои можно переименовать, расположить в нужном
              порядке, скрыть или отправить в архив.
            </p>
            {state.tabs
              .filter((tab) => tab.builtin)
              .map((tab) => (
                <div className={s.managerRow} key={tab.id}>
                  <strong>{tab.name}</strong>
                  <span className={s.muted}>Основная</span>
                </div>
              ))}
            <h3>Свои подвкладки</h3>
            {custom.map((tab) => (
              <div key={tab.id} className={s.managerRow} data-child={!!tab.parentId}>
                <div>
                  <strong>{tab.name}</strong>
                  <small>
                    {kindNames[tab.kind]}
                    {tab.isGroup ? ' · с подвкладками' : ''}
                    {tab.parentId
                      ? ` · внутри «${state.tabs.find((parent) => parent.id === tab.parentId)?.name}»`
                      : ''}
                    {tab.hidden ? ' · скрыта' : ''}
                    {state.defaultTab === tab.id ? ' · открывается первой' : ''}
                  </small>
                </div>
                <div className={s.buttons}>
                  <button
                    className="btn btn--quiet btn--compact"
                    aria-label={`Поднять подвкладку ${tab.name}`}
                    disabled={
                      custom
                        .filter((item) => item.parentId === tab.parentId)
                        .findIndex((item) => item.id === tab.id) === 0
                    }
                    onClick={() => {
                      setState((current) => ({
                        ...current,
                        tabs: reorderTabs(current.tabs, tab.id, -1),
                      }));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn--quiet btn--compact"
                    aria-label={`Опустить подвкладку ${tab.name}`}
                    disabled={
                      custom.filter((item) => item.parentId === tab.parentId).at(-1)?.id === tab.id
                    }
                    onClick={() => {
                      setState((current) => ({
                        ...current,
                        tabs: reorderTabs(current.tabs, tab.id, 1),
                      }));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn--ghost btn--compact"
                    aria-label={`Настроить подвкладку ${tab.name}`}
                    onClick={() => {
                      setManaging(false);
                      beginEditor(tab, false);
                    }}
                  >
                    Настроить
                  </button>
                  <button
                    className="btn btn--ghost btn--compact"
                    aria-label={`${tab.hidden ? 'Показать' : 'Скрыть'} подвкладку ${tab.name}`}
                    onClick={() => update({ ...tab, hidden: !tab.hidden })}
                  >
                    {tab.hidden ? 'Показать' : 'Скрыть'}
                  </button>
                  <button
                    className="btn btn--quiet btn--compact"
                    aria-label={`В архив подвкладку ${tab.name}`}
                    onClick={() => {
                      const ids = [
                        tab.id,
                        ...state.tabs
                          .filter((item) => item.parentId === tab.id)
                          .map((item) => item.id),
                      ];
                      const users = sourceUsers(state.tabs, ids);
                      if (users.length) {
                        setManagerError(
                          `Эта вкладка используется в связях: ${users.join(', ')}. Сначала измените источники.`,
                        );
                        return;
                      }
                      setManagerError('');
                      update({ ...tab, archived: true });
                      setNotice(
                        `Подвкладка «${tab.name}» в архиве. Её можно восстановить вместе с записями.`,
                      );
                    }}
                  >
                    В архив
                  </button>
                </div>
              </div>
            ))}
            {!custom.length && <p className={s.muted}>Свои подвкладки пока не добавлены.</p>}
            {state.tabs.some((tab) => tab.archived) && (
              <details className={s.archived}>
                <summary>
                  Архив подвкладок ({state.tabs.filter((tab) => tab.archived).length})
                </summary>
                {state.tabs
                  .filter((tab) => tab.archived)
                  .map((tab) => (
                    <div key={tab.id} className={s.managerRow}>
                      <div>
                        <strong>{tab.name}</strong>
                        <small>{kindNames[tab.kind]} · все записи сохранены</small>
                      </div>
                      <button
                        className="btn btn--outline btn--compact"
                        aria-label={`Восстановить подвкладку ${tab.name}`}
                        onClick={() => update({ ...tab, hidden: false, archived: false })}
                      >
                        Восстановить
                      </button>
                    </div>
                  ))}
              </details>
            )}
            <div className="dialog-actions">
              <button className="btn btn--primary btn--compact" onClick={() => setManaging(false)}>
                Готово
              </button>
            </div>
          </div>
        </Modal>
      )}
      {person && (
        <Modal
          title={personName(person)}
          testId="demo-personnel-profile"
          onClose={() => setPersonId(null)}
        >
          <div className={s.recordForm}>
            <span className="tag tag--ok">Карточка из реестра сотрудников</span>
            <dl className={s.profileDetails}>
              <div>
                <dt>Табельный номер</dt>
                <dd>{person.personnel_number}</dd>
              </div>
              <div>
                <dt>Телефон</dt>
                <dd>{person.phone || 'Не указан'}</dd>
              </div>
              {person.current.map((source) => (
                <div key={source.row_id}>
                  <dt>{dormName(data, source.dormitory_id)}</dt>
                  <dd>
                    {String(source.values.hostel_name)}
                    <br />
                    Вахта: {dateLabel(String(source.values.shift_start))} —{' '}
                    {dateLabel(String(source.values.shift_end))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Modal>
      )}
    </>
  );
  if (runtime)
    return (
      <>
        {screen}
        {dialogs}
      </>
    );
  return (
    <div className={`${cabinet.shell} ${project ? '' : s.page}`} data-menu-open={String(menu)}>
      <button
        className={cabinet['mobile-backdrop']}
        aria-label="Закрыть меню"
        tabIndex={-1}
        onClick={() => setMenu(false)}
      />
      <aside className={cabinet.sidebar}>
        <Link className={cabinet.brand} to="/preview/personnel-tab-builder">
          <span className={s.brand}>
            <WorkspaceIcon name="house" />
          </span>
          <span className={cabinet['brand-name']}>Домовой</span>
        </Link>
        <p className={cabinet['brand-note']}>Учёт проживающих в общежитиях</p>
        <nav aria-label="Разделы кабинета" className={s.sideNav}>
          {(
            [
              ['overview', 'Обзор', '/cabinet'],
              ['house', 'Общежития', '/cabinet/dormitories'],
              ['people', 'Персонал', '/preview/personnel-tab-builder'],
              ['chart', 'Статистика', '/cabinet/statistics'],
            ] as [WorkspaceIconName, string, string][]
          ).map(([icon, name, url]) => (
            <Link
              key={name}
              to={url}
              className={cabinet['nav-link']}
              aria-current={name === 'Персонал' ? 'page' : undefined}
            >
              <WorkspaceIcon name={icon} />
              {name}
            </Link>
          ))}
        </nav>
        <div className={cabinet['sidebar-bottom']}>
          <div className={cabinet.account}>
            <span className={cabinet['account-avatar']}>ТК</span>
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
            onClick={() => setMenu(!menu)}
          >
            <WorkspaceIcon name="menu" />
          </button>
          <div className={cabinet.breadcrumbs}>
            <span>Рабочее пространство</span>
            <WorkspaceIcon name="chevron" />
            <strong>Персонал</strong>
          </div>
          <span className={cabinet['preview-label']}>Тестовая страница</span>
        </header>
        <main className={project ? undefined : `${s.main} ${w.surface}`}>
          {project ? (
            screen
          ) : (
            <>
              <div className={s.demoNote}>
                <WorkspaceIcon name="info" />
                <p>
                  Пример конструктора подвкладок. Новые подвкладки, их настройки и записи
                  сохраняются только в этом браузере.
                </p>
              </div>
              <div className={s.pageHeading}>
                <div>
                  <h1>Персонал</h1>
                  <p>Сотрудники, заезды и ваши рабочие подборки.</p>
                </div>
                <div className={s.buttons}>
                  <button
                    className="btn btn--outline btn--compact"
                    onClick={() => setManaging(true)}
                  >
                    <PersonnelBlockIcon name="settings" />
                    Управление подвкладками
                  </button>
                  <button
                    className="btn btn--primary btn--compact"
                    onClick={() => setEditor({ tab: newTab(), isNew: true })}
                  >
                    + Добавить подвкладку
                  </button>
                </div>
              </div>
              <div className={s.tabStrip}>
                <div
                  role="tablist"
                  aria-label="Подвкладки персонала"
                  className={`${p.tabs} ${w.tabs} ${s.tabs}`}
                >
                  {roots.map((tab) => (
                    <button
                      key={tab.id}
                      id={`personnel-tab-${tab.id}`}
                      role="tab"
                      aria-selected={root.id === tab.id}
                      aria-controls="personnel-tab-content"
                      onClick={() => select(tab.id)}
                    >
                      {tab.name}
                      {!tab.builtin && (
                        <span className={s.customMark} title="Своя подвкладка" aria-hidden="true">
                          ●
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              {content()}
              <p className={s.pageFoot}>
                Три основные подвкладки сохранены. Свои подвкладки отмечены зелёной точкой и
                настраиваются независимо.
              </p>
            </>
          )}
        </main>
      </div>
      {dialogs}
    </div>
  );
}
