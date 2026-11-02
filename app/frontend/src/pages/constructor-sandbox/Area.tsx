import { useCallback, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import type { CustomTab, ReportRow, TableKey } from '../../api/client';
import type { Block, SavedList, SourceTable } from '../../api/personnel';
import { EditorSurfaceContext, useEditorPreview } from '../../components/EditorSurface';
import type { EditorSnapshot } from '../../components/EditorSurface';
import { useUnsavedChanges } from '../../components/useUnsavedChanges';
import { DormitorySettingsDialog } from '../../workspace/dormitories/DormitorySettingsDialog';
import structureStyles from '../../workspace/dormitories/DormitorySettingsDialog.module.css';
import { CreateDormitoryDialog } from '../../workspace/dormitories/CreateDormitoryDialog';
import { CreateCustomTabDialog } from '../../workspace/dormitories/CreateCustomTabDialog';
import { CreateTableDialog } from '../../workspace/dormitories/CreateTableDialog';
import { ManageCustomTabsDialog } from '../../workspace/dormitories/ManageCustomTabsDialog';
import {
  ColumnsControls,
  TableColumnsProvider,
} from '../../workspace/dormitories/ConfigurableColumns';
import { ReportTable, RowDialog } from '../../workspace/dormitories/ReportTable';
import { ReportTemplatesPanel } from '../../workspace/dormitories/ReportTemplatesPanel';
import { BindingDialog } from '../../workspace/personnel/BindingDialog';
import { BlockDialog, SaveListDialog } from '../../workspace/personnel/Dialogs';
import { PersonnelWorkspaceBlock } from '../../workspace/personnel/PersonnelWorkspaceBlock';
import { EmployeeListFilters } from '../../workspace/personnel/EmployeeListFilterPanel';
import { employeeListFields } from '../../workspace/personnel/employeeListFilters';
import { filterPeople } from '../../workspace/personnel/helpers';
import { SettingsDialog as ArrivalSettingsDialog } from '../../workspace/personnel/arrivals/SettingsDialog';
import { ArrivalCard } from '../../workspace/personnel/arrivals/ArrivalFields';
import { reconfigureArrival } from '../../workspace/personnel/arrivals/data';
import { DashboardBlocks } from '../../workspace/dashboard/DashboardBlocks';
import { EMPTY_DASHBOARD } from '../../workspace/dashboard/data';
import { Statistics } from '../../workspace/Statistics';
import statisticStyles from '../../workspace/statistics/Statistics.module.css';
import { LivePreview, TablePreview } from './Preview';
import { copy, RANGE, Sandbox } from './store';
import type { Scene } from './inventory';
import s from './Sandbox.module.css';

export const BASE = '/preview/constructors-project';

export function ListsEditor({ store }: { store: Sandbox }): JSX.Element {
  const blank = {
    filter: 'all' as const,
    dormitory: null,
    days: 7,
    query: '',
    scope: [] as number[],
    column_filters: [],
  };
  const [criteria, setCriteria] = useState<Omit<SavedList, 'id' | 'name'>>(blank);
  const [baseline, setBaseline] = useState(JSON.stringify(blank));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useUnsavedChanges(JSON.stringify(criteria) !== baseline);
  useEditorPreview('personnel-list', criteria);
  const people = filterPeople(store.personnel, criteria);
  return (
    <>
      <div className={s.savedLists}>
        <h2>Мои списки</h2>
        {store.personnel.preferences.lists.map((list) => (
          <div key={list.id}>
            <button
              className="btn btn--ghost btn--compact"
              onClick={() => {
                const { id: _id, name: _name, ...next } = list;
                void _id;
                void _name;
                setCriteria(copy(next));
                setBaseline(JSON.stringify(next));
              }}
            >
              {list.name}
            </button>
            <button
              className="btn btn--ghost btn--compact"
              aria-label={`Убрать список «${list.name}»`}
              onClick={() => {
                store.personnel.preferences.lists = store.personnel.preferences.lists.filter(
                  (item) => item.id !== list.id,
                );
                store.changed();
              }}
            >
              Убрать
            </button>
          </div>
        ))}
      </div>
      <div className={s.fields}>
        <label>
          Кого показать
          <select
            value={criteria.filter}
            onChange={(event) =>
              setCriteria({ ...criteria, filter: event.target.value as SavedList['filter'] })
            }
          >
            <option value="all">Все сотрудники</option>
            <option value="current">Проживают</option>
            <option value="ending">Заканчивается вахта</option>
          </select>
        </label>
        <label>
          Общежитие
          <select
            value={criteria.dormitory ?? ''}
            onChange={(event) =>
              setCriteria({
                ...criteria,
                dormitory: event.target.value ? Number(event.target.value) : null,
              })
            }
          >
            <option value="">Все общежития</option>
            {store.personnel.dormitories.map((dorm) => (
              <option key={dorm.id} value={dorm.id}>
                {dorm.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Период окончания вахты, дней
          <input
            type="number"
            min={1}
            max={365}
            value={criteria.days}
            onChange={(event) =>
              setCriteria({
                ...criteria,
                days: Math.max(1, Math.min(365, Number(event.target.value) || 1)),
              })
            }
          />
        </label>
        <label>
          Поиск
          <input
            value={criteria.query}
            onChange={(event) => setCriteria({ ...criteria, query: event.target.value })}
            placeholder="ФИО, табельный номер, телефон"
          />
        </label>
      </div>
      <fieldset className={s.scope}>
        <legend>Общежития в сохранённом списке</legend>
        {store.personnel.dormitories.map((dorm) => (
          <label key={dorm.id}>
            <input
              type="checkbox"
              checked={criteria.scope.includes(dorm.id)}
              onChange={(event) =>
                setCriteria({
                  ...criteria,
                  scope: event.target.checked
                    ? [...criteria.scope, dorm.id]
                    : criteria.scope.filter((id) => id !== dorm.id),
                })
              }
            />
            {dorm.name}
          </label>
        ))}
        <small>Если не выбрано ни одного — учитываются все.</small>
      </fieldset>
      <EmployeeListFilters
        data={store.personnel}
        criteria={criteria}
        fields={employeeListFields(store.personnel, criteria)}
        onChange={(column_filters) => setCriteria({ ...criteria, column_filters })}
      />
      <p className={s.note}>Под условия подходят {people.length} сотрудников.</p>
      <button className={s.primary} onClick={() => setSaving(true)}>
        Сохранить свой список
      </button>
      {message && <p role="status">{message}</p>}
      {saving && (
        <SaveListDialog
          criteria={criteria}
          data={store.personnel}
          onClose={() => setSaving(false)}
          onSave={async (list, pin) => {
            if (pin && (store.personnel.preferences.blocks?.length ?? 0) >= 20)
              throw new Error('На рабочей поверхности уже 20 блоков.');
            store.personnel.preferences.lists.push(list);
            if (pin)
              store.personnel.preferences.blocks?.push({
                id: crypto.randomUUID(),
                kind: 'saved',
                title: list.name,
                saved_list_id: list.id,
                days: list.days,
                limit: 4,
                wide: false,
                scope: list.scope,
              });
            store.changed();
            setBaseline(JSON.stringify(criteria));
            setMessage('Список сохранён. Условия можно открыть снова в «Моих списках».');
          }}
        />
      )}
    </>
  );
}

export function PersonnelBlocks({ store }: { store: Sandbox }): JSX.Element {
  const [editing, setEditing] = useState<Block | null | undefined>();
  const blocks = store.personnel.preferences.blocks ?? [];
  if (editing !== undefined)
    return (
      <BlockDialog
        key={editing?.id ?? 'new'}
        block={editing}
        data={store.personnel}
        onClose={() => setEditing(undefined)}
        onSave={async (block) => {
          if (!editing && blocks.length >= 20) throw new Error('Допускается не больше 20 блоков.');
          store.personnel.preferences.blocks = editing
            ? blocks.map((item) => (item.id === block.id ? block : item))
            : [...blocks, block];
          store.changed();
        }}
      />
    );
  return (
    <>
      <div className={s.toolbar}>
        <button
          className={s.primary}
          disabled={blocks.length >= 20}
          onClick={() => setEditing(null)}
        >
          Добавить блок
        </button>
        <span>{blocks.length} / 20 блоков</span>
      </div>
      {blocks.map((block, index) => (
        <PersonnelWorkspaceBlock
          key={block.id}
          block={block}
          data={store.personnel}
          dormitory={null}
          configuring
          busy={false}
          first={index === 0}
          last={index === blocks.length - 1}
          onPerson={() => undefined}
          onList={() => undefined}
          onPlanning={() => undefined}
          onEdit={() => setEditing(block)}
          onMove={(direction) => {
            const next = [...blocks];
            [next[index], next[index + direction]] = [next[index + direction], next[index]];
            store.personnel.preferences.blocks = next;
            store.changed();
          }}
          onRemove={() => {
            store.personnel.preferences.blocks = blocks.filter((item) => item.id !== block.id);
            store.changed();
          }}
        />
      ))}
    </>
  );
}

export function EditorArea({
  store,
  scene,
  dorm,
}: {
  store: Sandbox;
  scene: Scene;
  dorm: string;
}): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const publish = useCallback((next: EditorSnapshot | null) => {
    setSnapshot(next);
    if (!next || next.kind === 'none') setForm({});
  }, []);
  const context = useMemo(() => ({ inline: true, publish }), [publish]);
  const source = store.dorm(dorm);
  const table = (params.get('table') ??
    (scene === 'binding'
      ? (source.settings.tabs[0]?.table_key ?? 'archive')
      : 'residents')) as TableKey;
  const requestedRow = params.get('row');
  const rowId =
    requestedRow === 'new'
      ? null
      : requestedRow
        ? Number(requestedRow)
        : scene === 'links'
          ? (source.rows.find((row) => !!row.link)?.id ?? null)
          : scene === 'places'
            ? null
            : source.rows.find((row) => row.name === 'Проживает Итого')!.id;
  const row: ReportRow | null =
    rowId === null ? null : (source.rows.find((item) => item.id === rowId) ?? null);
  const createTableTab =
    (params.has('tab')
      ? source.settings.tabs.find((tab) => tab.id === Number(params.get('tab')))
      : source.settings.tabs.find((tab) => !tab.table_created)) ?? null;
  const ownPreview =
    [
      'structure-templates',
      'create-dormitory',
      'arrival-fields',
      'arrival-display',
      'statistics',
    ].includes(scene) && !['report-row', 'binding'].includes(snapshot?.kind ?? '');
  function notify(message: string): void {
    setNotice(message);
  }
  function closed(): void {
    setOpen(false);
    publish(null);
  }
  function refresh(): void {
    setLoadKey((key) => key + 1);
  }
  function query(key: string, value: string): void {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  }
  function capture(event: FormEvent): void {
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest('form');
    if (element instanceof HTMLFormElement)
      setForm(
        Object.fromEntries(
          [...new FormData(element)].filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      );
  }
  const dashboardData = {
    ...EMPTY_DASHBOARD,
    layout: copy(store.layout),
    widgets: store.layout.blocks.map((block) => ({
      ...store.widget(block.config, RANGE.from, RANGE.to),
      id: block.id,
    })),
  };
  const native = (): ReactNode => {
    if (
      !open &&
      ![
        'dashboard',
        'statistics',
        'report',
        'personnel-blocks',
        'personnel-lists',
        'report-templates',
      ].includes(scene)
    )
      return (
        <div className={s.finished}>
          <h2>Редактор закрыт</h2>
          <p>{notice || 'Сохранённый результат доступен в примере справа.'}</p>
          <button ref={triggerRef} className={s.primary} onClick={() => setOpen(true)}>
            Открыть конструктор снова
          </button>
          {scene.startsWith('arrival-') && (
            <ArrivalCard arrival={store.arrivalSample} settings={store.arrivalSettings} />
          )}
        </div>
      );
    if (scene === 'structure' || scene === 'structure-templates')
      return (
        <DormitorySettingsDialog
          dormitoryId={dorm}
          initialKey={table}
          initialPage={scene === 'structure-templates' ? 'templates' : 'structure'}
          onClose={closed}
          onChanged={() => notify('Структура сохранена в тестовом общежитии.')}
          onOpen={(key) => {
            query('table', key);
            notify('Открыта таблица выбранной вкладки.');
          }}
        />
      );
    if (scene === 'create-dormitory')
      return (
        <CreateDormitoryDialog
          onClose={closed}
          triggerRef={triggerRef}
          onCreated={(created) => {
            notify(
              `Общежитие «${created.name}» создано. Выберите его вверху, чтобы проверить структуру.`,
            );
            closed();
          }}
        />
      );
    if (scene === 'tabs')
      return (
        <ManageCustomTabsDialog
          key={loadKey}
          dormitoryId={dorm}
          onClose={closed}
          onLoaded={() => undefined}
          onChanged={() => notify('Вкладка изменена.')}
          onDeleted={() => notify('Вкладка удалена.')}
          onOpen={(tab) => {
            query('table', tab.table_key);
            notify(`Выбрана вкладка «${tab.name}».`);
          }}
          beforeChange={async () => undefined}
          onStandardChanged={() => notify('Стандартные вкладки обновлены.')}
          onStandardOpen={(section) => query('table', section.key)}
        />
      );
    if (scene === 'create-tab')
      return (
        <CreateCustomTabDialog
          dormitoryId={dorm}
          onClose={closed}
          onCreated={(tab) => {
            notify(`Вкладка «${tab.name}» создана.`);
            closed();
          }}
        />
      );
    if (scene === 'create-table')
      return createTableTab && !createTableTab.table_created ? (
        <CreateTableDialog
          dormitoryId={dorm}
          tab={createTableTab}
          onClose={closed}
          onCreated={(tab: CustomTab) => {
            notify(`Таблица вкладки «${tab.name}» создана.`);
            closed();
          }}
        />
      ) : (
        <>
          <p>Все существующие вкладки уже содержат таблицы.</p>
          <button
            className={s.primary}
            onClick={() => navigate(`${BASE}?builder=create-tab&dorm=${dorm}`)}
          >
            Создать новую вкладку
          </button>
        </>
      );
    if (scene === 'columns')
      return (
        <TableColumnsProvider key={`${table}-${loadKey}`} dormitoryId={dorm} table={table}>
          <ColumnsControls />
          <p className={s.note}>
            Созданный столбец сохраняет тип. Использованные варианты списка можно архивировать.
            Удалённый столбец восстанавливается с данными.
          </p>
        </TableColumnsProvider>
      );
    if (scene === 'report') return <ReportTable dormitoryId={dorm} range={RANGE} />;
    if (scene === 'formula' || scene === 'links' || scene === 'places')
      return (
        <RowDialog
          key={`${rowId}-${loadKey}`}
          dormitoryId={dorm}
          row={row}
          initialLink={
            !row && scene === 'places'
              ? { table_key: 'places', hostel_id: null, metric: 'free_total' }
              : !row && scene === 'links'
                ? source.rows.find((item) => item.link)?.link
                : undefined
          }
          rows={store.report(dorm, RANGE.from, RANGE.to).rows}
          onClose={closed}
          onChanged={() => {
            notify('Строка отчёта сохранена.');
          }}
        />
      );
    if (scene === 'report-templates') return <ReportTemplatesPanel />;
    if (scene === 'binding')
      return (
        <BindingDialog
          key={table}
          dormitoryId={dorm}
          tableKey={table as SourceTable}
          onClose={closed}
          onSaved={() => {
            notify('Связь с персоналом сохранена.');
            closed();
          }}
        />
      );
    if (scene === 'personnel-blocks') return <PersonnelBlocks store={store} />;
    if (scene === 'personnel-lists') return <ListsEditor store={store} />;
    if (scene === 'arrival-fields' || scene === 'arrival-display')
      return (
        <ArrivalSettingsDialog
          settings={store.arrivalSettings}
          initialTab={scene === 'arrival-fields' ? 'fields' : 'display'}
          sample={store.arrivalSample}
          preview={false}
          usedFields={['shifts', 'transport', 'workdate']}
          onClose={closed}
          onSave={(settings) => {
            store.arrivalSample = reconfigureArrival(
              store.arrivalSample,
              store.arrivalSettings,
              settings,
            );
            store.arrivalSettings = settings;
            store.changed();
            notify('Оба раздела настроек плана заездов сохранены.');
            closed();
          }}
        />
      );
    if (scene === 'dashboard')
      return (
        <div className={s.dashboard}>
          <DashboardBlocks
            data={dashboardData}
            range={RANGE}
            loading={false}
            onChange={refresh}
            cards={['residents', 'attendance', 'turnover', 'reports'].map((key, index) => ({
              key,
              name: ['Проживают', 'Выход на работу', 'Текучка', 'Сохранение отчёта'][index],
              content: (
                <div className={s.builtin}>
                  <h3>{['Проживают', 'Выход на работу', 'Текучка', 'Сохранение отчёта'][index]}</h3>
                  <strong>{index === 3 ? '31 октября' : [103, 92, 2][index]}</strong>
                </div>
              ),
            }))}
          />
        </div>
      );
    return (
      <div className={s.statistics}>
        <Routes>
          <Route
            path="statistics/:reportId?"
            element={<Statistics basePath={`${BASE}/statistics`} initialRange={RANGE} />}
          />
          <Route
            path="*"
            element={<Statistics basePath={`${BASE}/statistics`} initialRange={RANGE} />}
          />
        </Routes>
      </div>
    );
  };
  const listCriteria =
    snapshot?.kind === 'personnel-list' ? (snapshot.value as Omit<SavedList, 'id' | 'name'>) : null;
  const people = listCriteria ? filterPeople(store.personnel, listCriteria) : [];
  return (
    <EditorSurfaceContext.Provider value={context}>
      <style>{`.${s.native} .${statisticStyles.editorGrid}{grid-template-columns:minmax(300px,.85fr) minmax(0,1.2fr)!important;gap:24px!important}.${s.native} .${statisticStyles.editorPreview}{position:sticky!important;top:20px!important}@media(max-width:1050px){.${s.native} .${statisticStyles.editorGrid}{grid-template-columns:minmax(0,1fr)!important}.${s.native} .${statisticStyles.editorPreview}{position:static!important}}`}</style>
      {scene === 'structure' && (
        <style>{`.${s.native} .${structureStyles.workspace}{grid-template-columns:minmax(0,1fr)!important}.${s.native} .${structureStyles.sidebar}{max-height:190px;overflow:auto;border-bottom:1px solid var(--color-border);padding-bottom:12px}`}</style>
      )}
      <div className={s.toolbar}>
        {scene === 'create-table' && (
          <label>
            Вкладка для таблицы
            <select
              aria-label="Вкладка для создания таблицы"
              value={createTableTab?.id ?? ''}
              onChange={(event) => query('tab', event.target.value)}
            >
              {source.settings.tabs
                .filter((tab) => !tab.table_created || tab.id === createTableTab?.id)
                .map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    {tab.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {['columns', 'binding', 'structure', 'tabs'].includes(scene) && (
          <label>
            Таблица
            <select
              aria-label="Таблица конструктора"
              value={table}
              onChange={(event) => query('table', event.target.value)}
            >
              {Object.keys(source.settings.tables)
                .filter(
                  (key) => scene !== 'binding' || key === 'archive' || key.startsWith('custom_'),
                )
                .map((key) => (
                  <option key={key} value={key}>
                    {source.settings.tabs.find((tab) => tab.table_key === key)?.name ??
                      source.settings.sections.find((section) => section.key === key)?.name ??
                      key}
                  </option>
                ))}
            </select>
          </label>
        )}
        {['formula', 'links', 'places'].includes(scene) && (
          <label>
            Строка отчёта
            <select
              aria-label="Строка конструктора"
              value={rowId ?? 'new'}
              onChange={(event) => query('row', event.target.value)}
            >
              <option value="new">Добавить новую строку</option>
              {source.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {notice && <span role="status">{notice}</span>}
      </div>
      <div className={ownPreview ? s.wide : s.split}>
        <section
          className={s.native}
          aria-label="Полный конструктор проекта"
          onChangeCapture={capture}
        >
          {native()}
        </section>
        {!ownPreview && (
          <aside className={s.livePreview} aria-label="Живой результат настроек">
            <div className={s.liveLabel}>
              <i />
              Результат изменений<span>Демонстрационные данные</span>
            </div>
            {listCriteria ? (
              <>
                <h2>Найдено сотрудников: {people.length}</h2>
                <div className={s.scroll}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th>ФИО</th>
                        <th>Табельный номер</th>
                        <th>Телефон</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((person) => (
                        <tr key={person.id}>
                          <th>{person.full_name}</th>
                          <td>{person.personnel_number}</td>
                          <td>{person.phone || 'Не заполнен'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!people.length && (
                    <p className={s.note}>
                      Под все выбранные условия никто не подходит. Измените или уберите условие.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <LivePreview
                store={store}
                scene={scene}
                dorm={dorm}
                table={table}
                snapshot={snapshot}
                form={form}
                rowId={rowId}
              />
            )}
          </aside>
        )}
      </div>
      {!open && scene === 'create-dormitory' && (
        <div className={s.newDorms}>
          {store.dorms.map((dorm) => (
            <article key={dorm.info.id}>
              <h3>{dorm.info.name}</h3>
              <p>{dorm.info.client_name}</p>
              <span>{dorm.settings.tabs.length} своих вкладок</span>
            </article>
          ))}
        </div>
      )}
      {scene === 'create-table' && !open && (
        <TablePreview
          store={store}
          dorm={dorm}
          table={
            source.settings.tabs.find((tab) => tab.id === createTableTab?.id)?.table_key ??
            source.settings.tabs[source.settings.tabs.length - 1]?.table_key ??
            'residents'
          }
        />
      )}
    </EditorSurfaceContext.Provider>
  );
}
