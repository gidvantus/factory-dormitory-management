import { api } from '../../api/client';
import type {
  ColumnInput,
  CreateDormitoryInput,
  CustomTab,
  CustomTabOptions,
  ReportLink,
  ReportRow,
  SettingsColumn,
  SettingsInput,
  TableKey,
  CellFillSource,
} from '../../api/client';
import { personnelApi } from '../../api/personnel';
import { statisticsApi } from '../../api/statistics';
import type { ReportInput, StatisticsBlock } from '../../api/statistics';
import type { WidgetConfig } from '../../api/dashboardBlocks';
import { defaultTabOptions } from '../../workspace/dormitories/customTabOptions';
import { standardTabs } from '../../workspace/dormitories/tabStructure';
import { personnelFillSource, sourceFields } from '../../workspace/dormitories/cellFill';
import { copy, fail, RANGE, requiredNames, Sandbox } from './store';
import type { DemoDorm } from './store';
import { references } from './formula';

type Handler = (args: unknown[]) => unknown;
const normalized = (text: string): string =>
  text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');

function mappedLink(
  source: DemoDorm,
  target: DemoDorm,
  link: ReportLink | null | undefined,
): ReportLink | null {
  if (!link || link.table_key === 'arrival_plan') return copy(link ?? null);
  if (link.table_key === 'places') {
    const name = source.hostels.find((hostel) => hostel.id === link.hostel_id)?.name;
    return {
      ...link,
      hostel_id:
        link.hostel_id === null
          ? null
          : (target.hostels.find((hostel) => hostel.name === name)?.id ??
            fail('В образце размещения нет нужного хостела.')),
    };
  }
  const tabName = source.settings.tabs.find((tab) => tab.table_key === link.table_key)?.name;
  const table = tabName
    ? target.settings.tabs.find((tab) => tab.name === tabName)?.table_key
    : link.table_key;
  const columns = table ? target.settings.tables[table] : undefined;
  if (!table || !columns)
    return fail('Для связанной строки выберите также вкладку с её источником.');
  const column = (id: number): SettingsColumn => {
    const old = source.settings.tables[link.table_key]?.find((item) => item.id === id);
    return (
      columns.find((item) => item.name === old?.name && item.kind === old?.kind) ??
      fail('В выбранном образце нет столбца, необходимого связанной строке.')
    );
  };
  const next = column(link.column_id);
  const old = source.settings.tables[link.table_key]?.find((item) => item.id === link.column_id);
  const label = old?.options.find((option) => option.id === link.value)?.label;
  return {
    ...link,
    table_key: table,
    column_id: next.id,
    date_column_id: link.date_column_id ? column(link.date_column_id).id : null,
    value:
      old?.kind === 'select' && link.operator === 'equals'
        ? (next.options.find((option) => option.label === label)?.id ??
          fail('В образце нет нужного варианта списка.'))
        : link.value,
  };
}

function cloneStructure(store: Sandbox, source: DemoDorm, target: DemoDorm, keys?: string[]): void {
  const selected = new Set(
    keys ?? [
      ...source.settings.sections.map((section) => section.key),
      ...source.settings.tabs.map((tab) => tab.table_key),
    ],
  );
  const columnIds = new Map<number, number>();
  const optionIds = new Map<string, string>();
  const tabIds = new Map(source.settings.tabs.map((tab) => [tab.id, store.id()]));
  const tableKey = (key: string): TableKey =>
    key.startsWith('custom_')
      ? `custom_${tabIds.get(Number(key.slice(7))) ?? store.id()}`
      : (key as TableKey);
  target.settings.tables = Object.fromEntries(
    Object.entries(source.settings.tables)
      .filter(([key]) => selected.has(key))
      .map(([key, columns]) => {
        const newKey = tableKey(key);
        return [
          newKey,
          columns.map((column) => {
            const id = store.id();
            columnIds.set(column.id, id);
            return {
              ...copy(column),
              id,
              table_key: newKey,
              used_by: [],
              options: column.options.map((option) => {
                const id = `option-${store.id()}`;
                if (option.id) optionIds.set(option.id, id);
                return { ...option, id };
              }),
            };
          }),
        ];
      }),
  );
  target.settings.tabs = source.settings.tabs
    .filter((tab) => selected.has(tab.table_key))
    .map((tab) => ({
      ...copy(tab),
      id: tabIds.get(tab.id)!,
      table_key: tableKey(tab.table_key) as `custom_${number}`,
      dormitory_id: target.info.id,
      parent_id:
        tab.parent_id && selected.has(`custom_${tab.parent_id}`)
          ? (tabIds.get(tab.parent_id) ?? null)
          : null,
      parent_section:
        tab.parent_section && selected.has(tab.parent_section) ? tab.parent_section : null,
      options: tab.options
        ? {
            ...tab.options,
            date_column_id: tab.options.date_column_id
              ? (columnIds.get(tab.options.date_column_id) ?? null)
              : null,
          }
        : undefined,
      has_data: false,
      delete_block_reason: null,
    }));
  target.settings.sections = source.settings.sections.map((section) => ({
    ...copy(section),
    status: selected.has(section.key) ? section.status : 'hidden',
    has_data: false,
    delete_block_reason:
      section.key === 'report' ? 'Общий отчёт содержит обязательные строки.' : null,
  }));
  target.rows = source.rows.map((row) => {
    let link = copy(row.link);
    if (link && 'column_id' in link)
      link = {
        ...link,
        table_key: tableKey(link.table_key),
        column_id: columnIds.get(link.column_id) ?? link.column_id,
        date_column_id: link.date_column_id ? (columnIds.get(link.date_column_id) ?? null) : null,
        value:
          typeof link.value === 'string' ? (optionIds.get(link.value) ?? link.value) : link.value,
      };
    if (link?.table_key === 'places' && link.hostel_id) {
      const name = source.hostels.find(
        (hostel) => hostel.id === (link && 'hostel_id' in link ? link.hostel_id : null),
      )?.name;
      link = {
        ...link,
        hostel_id: target.hostels.find((hostel) => hostel.name === name)?.id ?? null,
      };
    }
    return { ...copy(row), id: store.id(), values: {}, errors: {}, link };
  });
  target.records = Object.fromEntries(Object.keys(target.settings.tables).map((key) => [key, []]));
  target.binding = {};
}

export function installSandboxApis(store: Sandbox): () => void {
  const apiHandlers: Record<string, Handler> = {
    dormitories: () => store.dorms.map((dorm) => dorm.info),
    dormitory: ([id]) => store.dorm(String(id)).info,
    dormitorySettings: ([id]) => store.settings(String(id)),
    saveDormitorySettings: ([id, input]) => store.saveSettings(String(id), input as SettingsInput),
    tableColumns: ([id, key]) => store.settings(String(id)).tables[String(key)] ?? [],
    cellFillSources: ([id]) => {
      const settings = store.settings(String(id));
      return [
        personnelFillSource,
        ...Object.entries(settings.tables).map(([key, columns]) => ({
          key: key as CellFillSource['key'],
          name:
            settings.tabs.find((tab) => tab.table_key === key)?.name ??
            settings.sections.find((section) => section.key === key)?.name ??
            key,
          fields: sourceFields(columns),
        })),
      ];
    },
    createColumn: ([id, key, input]) => {
      const dorm = store.dorm(String(id));
      const table = String(key) as TableKey;
      const columns = dorm.settings.tables[table] ?? [];
      const column = {
        ...store.columnInput(input as ColumnInput),
        table_key: table,
        position: columns.length,
      };
      store.uniqueColumns([...columns, column]);
      dorm.settings.tables[table] = [...columns, column];
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return column;
    },
    updateColumn: ([id, key, columnId, input]) => {
      const dorm = store.dorm(String(id));
      const columns = store.columns(String(id), String(key));
      const old =
        columns.find((column) => column.id === columnId) ?? fail('Столбец не найден', 404);
      const next = store.columnInput(input as ColumnInput, old);
      for (const option of old.options)
        if (
          !next.options.some((item) => item.id === option.id) &&
          (dorm.records[String(key)] ?? []).some((row) => row.values[old.id] === option.id)
        )
          fail('Использованный вариант списка можно архивировать, но нельзя удалить.');
      const result = columns.map((column) => (column.id === columnId ? next : column));
      store.uniqueColumns(result);
      dorm.settings.tables[String(key)] = result;
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return next;
    },
    deleteColumn: ([id, key, columnId]) => {
      const column =
        store.settings(String(id)).tables[String(key)]?.find((item) => item.id === columnId) ??
        fail('Столбец не найден', 404);
      if (column.used_by.length)
        fail(`Столбец используется строками: ${column.used_by.join(', ')}.`, 409);
      store.columns(String(id), String(key)).find((item) => item.id === columnId)!.archived = true;
      store.dorm(String(id)).settings.revision = String(
        Number(store.dorm(String(id)).settings.revision) + 1,
      );
      store.changed();
    },
    restoreColumn: ([id, key, columnId]) => {
      const column =
        store.columns(String(id), String(key)).find((item) => item.id === columnId) ??
        fail('Столбец не найден', 404);
      store.uniqueColumns(
        store
          .columns(String(id), String(key))
          .map((item) => (item.id === column.id ? { ...item, archived: false } : item)),
      );
      column.archived = false;
      store.changed();
      return column;
    },
    saveCustomCell: ([id, key, rowId, columnId, value]) => {
      const record =
        store.dorm(String(id)).records[String(key)]?.find((item) => item.id === rowId) ??
        fail('Запись не найдена', 404);
      record.values[String(columnId)] = value as string | number | boolean | null;
      store.changed();
      return { value };
    },
    standardSections: ([id]) => store.dorm(String(id)).settings.sections,
    changeStandardSection: ([id, key, status]) => {
      const dorm = store.dorm(String(id));
      const section =
        dorm.settings.sections.find((item) => item.key === key) ?? fail('Раздел не найден', 404);
      if (status === 'deleted' && section.delete_block_reason)
        fail(section.delete_block_reason, 409);
      section.status = status as 'active' | 'hidden' | 'deleted';
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return dorm.settings.sections;
    },
    customTabs: ([id]) => store.dorm(String(id)).settings.tabs,
    customTabTemplates: () =>
      store.dorms.flatMap((dorm) =>
        dorm.settings.tabs.map((tab) => ({
          ...tab,
          dormitory_name: dorm.info.name,
          client_name: dorm.info.client_name,
        })),
      ),
    setCustomTabActive: ([id, tabId, active]) => {
      const dorm = store.dorm(String(id));
      const tab =
        dorm.settings.tabs.find((item) => item.id === tabId) ?? fail('Вкладка не найдена', 404);
      tab.is_active = Boolean(active);
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return tab;
    },
    deleteCustomTab: ([id, tabId]) => {
      const dorm = store.dorm(String(id));
      const tab =
        dorm.settings.tabs.find((item) => item.id === tabId) ?? fail('Вкладка не найдена', 404);
      const ids = new Set([tab.id]);
      let size = 0;
      while (ids.size !== size) {
        size = ids.size;
        dorm.settings.tabs
          .filter((item) => item.parent_id && ids.has(item.parent_id))
          .forEach((item) => ids.add(item.id));
      }
      if (dorm.settings.tabs.some((item) => ids.has(item.id) && item.delete_block_reason))
        fail('Вкладка или её подвкладка содержит данные либо используется в отчёте.', 409);
      dorm.settings.tabs = dorm.settings.tabs.filter((item) => !ids.has(item.id));
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
    },
    createCustomTab: (args) => {
      const [id, name, sourceId, subtabs = [], parentId = null, parentSection = null, options] =
        args as [
          string,
          string,
          number | null,
          string[],
          number | null,
          string | null,
          CustomTabOptions | undefined,
        ];
      const dorm = store.dorm(id);
      if (!name.trim()) fail('Укажите название вкладки.');
      if (
        dorm.settings.tabs.some(
          (tab) =>
            tab.parent_id === parentId &&
            (tab.parent_section ?? null) === parentSection &&
            normalized(tab.name) === normalized(name),
        )
      )
        fail('Вкладка с таким названием уже существует.');
      const create = (
        title: string,
        parent: number | null,
        configuration: CustomTabOptions | undefined,
      ): CustomTab => {
        const tabId = store.id();
        const tab: CustomTab = {
          id: tabId,
          table_key: `custom_${tabId}`,
          dormitory_id: dorm.info.id,
          name: title.trim(),
          parent_id: parent,
          parent_section: parent ? null : parentSection,
          is_group: false,
          options: copy(configuration ?? defaultTabOptions),
          table_created: false,
          is_active: true,
          has_data: false,
          delete_block_reason: null,
        };
        dorm.settings.tabs.push(tab);
        if (tab.options?.period_mode !== 'none' && tab.options?.table_format === 'list') {
          const date = {
            ...store.columnInput({ name: 'Дата', kind: 'date', options: [] }),
            table_key: tab.table_key,
          };
          dorm.settings.tables[tab.table_key] = [date];
          tab.options!.date_column_id = date.id;
        }
        return tab;
      };
      const tab = create(name, parentId, options);
      if (sourceId) {
        const sourceDorm =
          store.dorms.find((item) => item.settings.tabs.some((entry) => entry.id === sourceId)) ??
          fail('Образец вкладки не найден', 404);
        const source = sourceDorm.settings.tabs.find((item) => item.id === sourceId)!;
        tab.table_created = source.table_created;
        tab.options = copy(source.options);
        tab.is_group = source.is_group;
        const columns = (sourceDorm.settings.tables[source.table_key] ?? []).map((old) => {
          const next = {
            ...store.columnInput({
              ...old,
              options: old.options.map((option) => ({ ...option, id: null })),
            }),
            table_key: tab.table_key,
          };
          if (tab.options?.date_column_id === old.id) tab.options.date_column_id = next.id;
          return next;
        });
        dorm.settings.tables[tab.table_key] = columns;
        const cloneChildren = (sourceParent: number, targetParent: number): void => {
          for (const child of sourceDorm.settings.tabs.filter(
            (item) => item.parent_id === sourceParent,
          )) {
            const next = create(child.name, targetParent, child.options);
            next.table_created = child.table_created;
            next.is_group = child.is_group;
            dorm.settings.tables[next.table_key] = (
              sourceDorm.settings.tables[child.table_key] ?? []
            ).map((old) => {
              const col = {
                ...store.columnInput({
                  ...old,
                  options: old.options.map((option) => ({ ...option, id: null })),
                }),
                table_key: next.table_key,
              };
              if (next.options?.date_column_id === old.id) next.options.date_column_id = col.id;
              return col;
            });
            cloneChildren(child.id, next.id);
          }
        };
        cloneChildren(source.id, tab.id);
      } else if (subtabs.length) {
        tab.is_group = true;
        for (const child of subtabs) create(child, tab.id, options);
      }
      dorm.records[tab.table_key] = [];
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return tab;
    },
    createCustomTabTable: ([id, tabId, input]) => {
      const dorm = store.dorm(String(id));
      const tab =
        dorm.settings.tabs.find((item) => item.id === tabId) ?? fail('Вкладка не найдена', 404);
      if (tab.table_created) fail('Таблица уже создана.', 409);
      const columns = (input as ColumnInput[]).map((column, position) => ({
        ...store.columnInput(column),
        table_key: tab.table_key,
        position,
      }));
      if (!columns.length) fail('Добавьте хотя бы один столбец.');
      store.uniqueColumns(columns);
      const date = columns.find((column) => column.kind === 'date');
      if (tab.options?.table_format === 'list' && tab.options.period_mode !== 'none') {
        if (!date) {
          const column = {
            ...store.columnInput({ name: 'Дата', kind: 'date', options: [] }),
            table_key: tab.table_key,
          };
          columns.push(column);
          tab.options.date_column_id = column.id;
        } else tab.options.date_column_id = date.id;
      }
      dorm.settings.tables[tab.table_key] = columns;
      dorm.records[tab.table_key] = [];
      tab.table_created = true;
      store.changed();
      return tab;
    },
    tabCatalog: () =>
      standardTabs
        .map((section) => ({
          id: section.path,
          name: section.label,
          variants: [
            {
              id: `standard:0:${section.path}`,
              name: section.label,
              kind: 'standard',
              section_key: section.path,
              tab_id: null,
              dormitory_id: null,
              dormitory_name: 'Стандартная структура',
              client_name: '',
              parent_name: null,
              path: [section.label],
            },
            ...store.dorms.map((dorm) => ({
              id: `standard:${dorm.info.id}:${section.path}`,
              name: section.label,
              kind: 'standard',
              section_key: section.path,
              tab_id: null,
              dormitory_id: dorm.info.id,
              dormitory_name: dorm.info.name,
              client_name: dorm.info.client_name,
              parent_name: null,
              path: [section.label],
            })),
          ],
        }))
        .concat(
          store.dorms.flatMap((dorm) =>
            dorm.settings.tabs.map((tab) => ({
              id: `tab-${tab.id}`,
              name: tab.name,
              variants: [
                {
                  id: `custom:${tab.id}`,
                  name: tab.name,
                  kind: 'custom',
                  section_key: null,
                  tab_id: tab.id,
                  dormitory_id: dorm.info.id,
                  dormitory_name: dorm.info.name,
                  client_name: dorm.info.client_name,
                  parent_name: null,
                  path: [tab.name],
                },
              ],
            })),
          ) as never[],
        ),
    structureTemplates: () => store.structures,
    structureTemplate: ([id]) =>
      store.structures.find((item) => item.id === id) ?? fail('Шаблон структуры не найден', 404),
    saveStructureTemplate: ([id, name]) => {
      const title = String(name).trim();
      if (!title || store.structures.some((item) => normalized(item.name) === normalized(title)))
        fail('Укажите уникальное название шаблона структуры.');
      const template = store.structure(Number(id), title);
      store.structures.push(template);
      store.changed();
      return template;
    },
    deleteStructureTemplate: ([id]) => {
      store.structures = store.structures.filter((item) => item.id !== id);
      store.changed();
    },
    reportTemplates: () => store.templates,
    reportTemplate: ([id]) =>
      store.templates.find((item) => item.id === id) ?? fail('Шаблон отчёта не найден', 404),
    saveReportTemplate: ([id, name]) => {
      const title = String(name).trim();
      if (!title || store.templates.some((item) => normalized(item.name) === normalized(title)))
        fail('Укажите уникальное название шаблона отчёта.');
      const template = store.reportTemplate(Number(id), title);
      store.templates.push(template);
      store.changed();
      return template;
    },
    deleteReportTemplate: ([id]) => {
      store.templates = store.templates.filter((item) => item.id !== id);
      store.changed();
    },
    createDormitory: ([input]) => {
      const value = input as CreateDormitoryInput;
      if (!value.name.trim() || !value.client_name.trim())
        fail('Укажите название общежития и клиента.');
      const dorm = store.seedDorm(store.id(), value.name.trim());
      dorm.info.client_name = value.client_name.trim();
      const template = value.structure_template_id
        ? (store.structures.find((item) => item.id === value.structure_template_id) ??
          fail('Шаблон не найден', 404))
        : null;
      if (template) {
        const source = copy(store.dorms[0]);
        source.settings.tables = copy(template.snapshot.columns) as Record<
          string,
          SettingsColumn[]
        >;
        source.settings.sections = standardTabs.map((section) => ({
          key: section.path,
          name: section.label,
          parent_key: template.snapshot.parents[section.path] ?? null,
          status: template.snapshot.sections[section.path] ?? 'hidden',
          has_data: false,
          delete_block_reason: null,
        }));
        source.settings.tabs = template.snapshot.tabs.map((tab) => ({
          id: Number(tab.key.slice(7)),
          dormitory_id: source.info.id,
          table_key: tab.key as `custom_${number}`,
          name: tab.name,
          parent_id: tab.parent?.startsWith('custom_') ? Number(tab.parent.slice(7)) : null,
          parent_section: tab.parent?.startsWith('custom_') ? null : tab.parent,
          is_active: tab.is_active,
          table_created: !!source.settings.tables[tab.key]?.length,
          has_data: false,
          delete_block_reason: null,
          options: copy(
            (tab as typeof tab & { options?: CustomTabOptions }).options ?? defaultTabOptions,
          ),
        }));
        source.rows = template.snapshot.rows.map((row, index) => ({
          ...row,
          id: index + 1,
          position: index,
          values: {},
          errors: {},
        }));
        cloneStructure(store, source, dorm, value.structure_template_keys);
      } else {
        const sources = value.tabs ?? [];
        if (value.tabs === undefined) cloneStructure(store, store.dorms[0], dorm);
        else {
          const source = copy(store.dorms[0]);
          source.settings.tables = {};
          source.settings.tabs = [];
          source.settings.sections.forEach((section) => {
            section.status = 'hidden';
          });
          let reportSource: DemoDorm | undefined;
          const keys: string[] = [];
          for (const choice of sources) {
            if (choice.source_id.startsWith('custom:')) {
              const id = Number(choice.source_id.slice(7));
              const original =
                store.dorms.find((item) => item.settings.tabs.some((tab) => tab.id === id)) ??
                fail('Образец вкладки не найден.', 404);
              const tab = copy(original.settings.tabs.find((item) => item.id === id)!);
              if (
                source.settings.tabs.some((item) => normalized(item.name) === normalized(tab.name))
              )
                fail('Выберите один образец для каждого названия вкладки.');
              source.settings.tabs.push(tab);
              source.settings.tables[tab.table_key] = copy(
                original.settings.tables[tab.table_key] ?? [],
              );
              keys.push(tab.table_key);
            } else {
              const [, id, key] = choice.source_id.split(':');
              const original = store.dorm(Number(id) || 1);
              const section =
                original.settings.sections.find((item) => item.key === key) ??
                fail('Образец раздела не найден.', 404);
              const at = source.settings.sections.findIndex((item) => item.key === key);
              source.settings.sections[at] = { ...copy(section), status: 'active' };
              if (original.settings.tables[key])
                source.settings.tables[key] = copy(original.settings.tables[key]);
              if (key === 'report') reportSource = original;
              if (key === 'places') source.hostels = copy(original.hostels);
              keys.push(key);
            }
          }
          source.settings.tabs.forEach((tab) => {
            if (!source.settings.tabs.some((parent) => parent.id === tab.parent_id))
              tab.parent_id = null;
            if (tab.parent_section && !keys.includes(tab.parent_section)) tab.parent_section = null;
          });
          source.rows = reportSource
            ? copy(reportSource.rows)
            : copy(source.rows.filter((row) => !row.link));
          if (reportSource)
            source.rows.forEach((row) => {
              row.link = mappedLink(reportSource!, source, row.link);
            });
          cloneStructure(store, source, dorm, keys);
        }
      }
      if (value.template_id) {
        const reportTemplate =
          store.templates.find((item) => item.id === value.template_id) ??
          fail('Шаблон отчёта не найден', 404);
        const original =
          store.dorms.find((item) =>
            item.rows.some((row) => reportTemplate.rows.some((entry) => entry.name === row.name)),
          ) ?? store.dorms[0];
        dorm.rows = reportTemplate.rows.map((entry) => {
          const row = original.rows.find((item) => item.name === entry.name);
          return {
            id: store.id(),
            name: entry.name,
            position: entry.position,
            formula: entry.formula,
            link: entry.linked ? mappedLink(original, dorm, row?.link ?? null) : null,
            values: {},
            errors: {},
          };
        });
      }
      dorm.settings.rules = dorm.rows;
      for (const key of Object.keys(dorm.records)) dorm.records[key] = [];
      store.dorms.push(dorm);
      store.personnel.dormitories.push({
        id: dorm.info.id,
        name: dorm.info.name,
        client_name: dorm.info.client_name,
        is_archived: false,
      });
      store.changed();
      return dorm.info;
    },
    report: ([id, from, to]) => store.report(String(id), String(from), String(to)),
    reportHostels: ([id]) => store.dorm(String(id)).hostels,
    outflowFields: ([id]) => {
      const columns = store.columns(String(id), 'outflow');
      const reason = columns.find((item) => item.kind === 'select' && !item.archived) ?? null;
      return {
        reason_column: reason,
        departure_column: columns.find((item) => item.kind === 'date' && !item.archived) ?? null,
        reasons:
          reason?.options
            .filter((option) => !option.archived)
            .map((option) => ({ value: option.id!, label: option.label })) ?? [],
      };
    },
    createReportRow: ([id, name, formula, link]) => {
      const dorm = store.dorm(String(id));
      const row: ReportRow = {
        id: store.id(),
        name: String(name).trim(),
        formula: formula ? String(formula).trim() : null,
        link: (link as ReportLink | null) ?? null,
        position: dorm.rows.length,
        values: {},
        errors: {},
      };
      store.validateRows([...dorm.rows, row]);
      dorm.rows.push(row);
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return row;
    },
    updateReportRow: ([id, rowId, name, formula, link]) => {
      const dorm = store.dorm(String(id));
      const row = dorm.rows.find((item) => item.id === rowId) ?? fail('Строка не найдена', 404);
      if (requiredNames.has(row.name) && (name !== row.name || !formula))
        fail('Обязательная строка должна сохранять название и формульный тип.', 409);
      const next = dorm.rows.map((item) =>
        item.id === rowId
          ? {
              ...item,
              name: String(name).trim(),
              formula: formula ? String(formula).trim() : null,
              link: link === undefined ? item.link : (link as ReportLink | null),
              values: formula || link ? {} : item.values,
            }
          : { ...item, formula: item.formula?.split(`[${row.name}]`).join(`[${name}]`) ?? null },
      );
      store.validateRows(next);
      dorm.rows = next;
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
      return next.find((item) => item.id === rowId);
    },
    deleteReportRow: ([id, rowId]) => {
      const dorm = store.dorm(String(id));
      const row = dorm.rows.find((item) => item.id === rowId) ?? fail('Строка не найдена', 404);
      if (requiredNames.has(row.name)) fail('Обязательную строку нельзя удалить.', 409);
      const dependencies = dorm.rows.filter(
        (item) => item.formula && references(item.formula).includes(row.name),
      );
      if (dependencies.length)
        fail(
          `На строку ссылаются формулы: ${dependencies.map((item) => item.name).join(', ')}.`,
          409,
        );
      dorm.rows = dorm.rows.filter((item) => item.id !== rowId);
      dorm.settings.revision = String(Number(dorm.settings.revision) + 1);
      store.changed();
    },
    moveReportRow: ([id, rowId, direction]) => {
      const dorm = store.dorm(String(id));
      const at = dorm.rows.findIndex((item) => item.id === rowId);
      const next = at + (direction === 'up' ? -1 : 1);
      if (at >= 0 && next >= 0 && next < dorm.rows.length)
        [dorm.rows[at], dorm.rows[next]] = [dorm.rows[next], dorm.rows[at]];
      dorm.rows.forEach((row, position) => {
        row.position = position;
      });
      store.changed();
      return dorm.rows.find((item) => item.id === rowId);
    },
    saveReportCell: ([id, rowId, date, value]) => {
      const row =
        store.dorm(String(id)).rows.find((item) => item.id === rowId) ??
        fail('Строка не найдена', 404);
      if (row.formula || row.link) fail('Вычисляемую строку нельзя заполнять вручную.');
      row.values[String(date)] = String(value);
      store.changed();
    },
    dashboardSources: () => store.catalog(),
    dashboardLayout: () => store.layout,
    saveDashboardLayout: ([input]) => {
      const patch = input as Pick<typeof store.layout, 'revision' | 'order' | 'hidden'>;
      if (patch.revision !== store.layout.revision) fail('Расположение блоков изменилось.', 409);
      store.layout = { ...store.layout, ...copy(patch), revision: store.layout.revision + 1 };
      store.changed();
      return store.layout;
    },
    saveDashboardBlock: ([revision, config, id]) => {
      if (revision !== store.layout.revision) fail('Блоки изменились. Обновите страницу.', 409);
      const block = { id: Number(id ?? store.id()), config: copy(config as WidgetConfig) };
      store.layout.blocks = id
        ? store.layout.blocks.map((item) => (item.id === id ? block : item))
        : [...store.layout.blocks, block];
      if (!id) store.layout.order.push(`custom:${block.id}`);
      store.layout.revision++;
      store.changed();
      return store.layout;
    },
    deleteDashboardBlock: ([id, revision]) => {
      if (revision !== store.layout.revision) fail('Блоки изменились.', 409);
      store.layout.blocks = store.layout.blocks.filter((item) => item.id !== id);
      store.layout.order = store.layout.order.filter((key) => key !== `custom:${id}`);
      store.layout.revision++;
      store.changed();
      return store.layout;
    },
    previewDashboardBlock: ([config, from, to]) =>
      store.widget(config as WidgetConfig, String(from), String(to)),
    dashboardData: ([from, to]) => ({
      revision: store.layout.revision,
      results: store.layout.blocks.map((block) => ({
        ...store.widget(block.config, String(from), String(to)),
        id: block.id,
      })),
    }),
  };
  const statisticsHandlers: Record<string, Handler> = {
    sources: () => store.catalog(),
    reports: () => store.reports,
    report: ([id]) =>
      store.reports.find((item) => item.id === Number(id)) ?? fail('Отчёт не найден', 404),
    create: ([input]) => {
      const value = input as ReportInput;
      if (!value.name.trim()) fail('Укажите название отчёта.');
      const report = {
        ...copy(value),
        id: store.id(),
        revision: 1,
        created_by_id: 1,
        created_by_name: 'Демо-владелец',
        can_manage: true,
        created_at: `${RANGE.from}T09:00:00Z`,
        updated_at: `${RANGE.to}T09:00:00Z`,
      };
      store.reports.push(report);
      store.changed();
      return report;
    },
    save: ([id, input]) => {
      const index = store.reports.findIndex((report) => report.id === id);
      if (index < 0) fail('Отчёт не найден', 404);
      const value = input as ReportInput & { revision: number };
      if (value.revision !== store.reports[index].revision)
        fail('Отчёт изменён другим пользователем. Обновите данные.', 409);
      if (!value.name.trim()) fail('Укажите название отчёта.');
      if (value.blocks.length > 40) fail('В отчёте может быть не больше 40 блоков.');
      store.reports[index] = {
        ...store.reports[index],
        ...copy(value),
        revision: value.revision + 1,
      };
      store.changed();
      return store.reports[index];
    },
    remove: ([id, revision]) => {
      const report = store.reports.find((item) => item.id === id) ?? fail('Отчёт не найден', 404);
      if (revision !== report.revision) fail('Отчёт изменился.', 409);
      store.reports = store.reports.filter((item) => item.id !== id);
      store.changed();
    },
    preview: ([block, range]) => {
      const dates = range as typeof RANGE;
      return store.statistics(block as StatisticsBlock, dates.from, dates.to);
    },
    data: ([id, range, dormitory]) => {
      const report =
        store.reports.find((item) => item.id === Number(id)) ?? fail('Отчёт не найден', 404);
      const value = range as typeof RANGE;
      return {
        revision: report.revision,
        from_date: value.from,
        to_date: value.to,
        through_date: value.to,
        results: report.blocks.map((block) =>
          store.statistics(
            dormitory === 'all'
              ? block
              : {
                  ...block,
                  query: { ...block.query, all_dormitories: false },
                  selected_dormitory_ids: [Number(dormitory)],
                },
            value.from,
            value.to,
          ),
        ),
      };
    },
  };
  const personnelHandlers: Record<string, Handler> = {
    binding: ([id, table]) => ({
      columns: store
        .columns(String(id), String(table))
        .filter((column) => !column.archived && column.kind !== 'action'),
      fields: store.dorm(String(id)).binding[String(table)]?.fields ?? {},
    }),
    saveBinding: ([id, table, fields]) => {
      const columns = store.columns(String(id), String(table)).filter((column) => !column.archived);
      const mapping = fields as Record<string, number>;
      for (const [role, columnId] of Object.entries(mapping)) {
        const col = columns.find((item) => item.id === columnId) ?? fail('Столбец не найден');
        if (
          role.startsWith('shift_')
            ? col.kind !== 'date'
            : role === 'personnel_number'
              ? !['text', 'number'].includes(col.kind)
              : col.kind !== 'text'
        )
          fail('Тип столбца не подходит для выбранного назначения.');
      }
      store.dorm(String(id)).binding[String(table)] = { columns, fields: copy(mapping) };
      store.changed();
      return store.dorm(String(id)).binding[String(table)];
    },
    workspace: () => store.personnel,
    preferences: ([input]) => {
      store.personnel.preferences = copy(input as typeof store.personnel.preferences);
      store.personnel.preferences.revision++;
      store.changed();
      return store.personnel.preferences;
    },
  };
  const restore: (() => void)[] = [];
  for (const [name, target, handlers] of [
    ['api', api, apiHandlers],
    ['statisticsApi', statisticsApi, statisticsHandlers],
    ['personnelApi', personnelApi, personnelHandlers],
  ] as const) {
    const object = target as unknown as Record<string, unknown>;
    for (const [method, original] of Object.entries(object)) {
      if (typeof original !== 'function') continue;
      object[method] = async (...args: unknown[]): Promise<unknown> => {
        store.calls.push(`${name}.${method}`);
        const handler = handlers[method];
        if (!handler) {
          store.unsupported.add(`${name}.${method}`);
          return fail(
            `Действие «${method}» недоступно в изолированном стенде. Рабочий сервер не вызывается.`,
            501,
          );
        }
        return copy(await handler(args));
      };
      restore.push(() => {
        object[method] = original;
      });
    }
  }
  return () => {
    for (const revert of restore.reverse()) revert();
  };
}
