import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import { personnelApi } from '../../api/personnel';
import { statisticsApi } from '../../api/statistics';
import type { WidgetConfig } from '../../api/dashboardBlocks';
import { installSandboxApis } from './api';
import { calculate } from './formula';
import { copy, RANGE, Sandbox } from './store';

let store: Sandbox;
let restore: () => void;
beforeEach(() => {
  store = new Sandbox();
  restore = installSandboxApis(store);
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

describe('Полные действия конструкторов на изолированных данных', () => {
  it.each([
    ['=([А]+[Б])*2+[В]-[Г]/2', 26],
    ['=2+3*4', 14],
    ['=-(2+3)*-4', 20],
    ['=1e2+0.5', 100.5],
    ['=([А]+[Б]+[В])/(2+3)', 3.2],
  ])('составная формула %s', (formula, expected) => {
    expect(calculate(formula, (name) => ({ А: 10, Б: 4, В: 2, Г: 8 })[name as 'А'])).toBe(expected);
  });
  it('проверяет синтаксис, ссылки, циклы и ошибки отдельных дат', async () => {
    const rows = store.dorm(1).rows;
    await api.updateReportRow(
      '1',
      105,
      'Проживает Итого',
      '=([Проживает М]+[Проживает Ж])*2+[Прибыло]-[Выбыло]',
    );
    expect(
      (await api.report('1', RANGE.from, RANGE.to)).rows.find((row) => row.id === 105)?.values[
        RANGE.to
      ],
    ).toBe('217');
    await expect(
      api.updateReportRow('1', 105, 'Проживает Итого', '=[Неизвестная строка]+1'),
    ).rejects.toThrow('не найдена');
    await expect(
      api.updateReportRow('1', 105, 'Проживает Итого', '=[Выход Итого]+1'),
    ).rejects.toThrow('циклическую');
    await expect(api.updateReportRow('1', 105, 'Проживает Итого', '=1+*2')).rejects.toBeInstanceOf(
      ApiError,
    );
    await api.createReportRow('1', 'Проверка деления', '=1/([Выбыло]-[Выбыло])');
    const report = await api.report('1', RANGE.from, RANGE.to);
    expect(report.rows.find((row) => row.name === 'Проверка деления')?.errors[RANGE.to]).toBe(
      'Деление на ноль',
    );
    expect(rows[0].values[RANGE.from]).toBe('73');
  });
  it('переименовывает ссылки, перемещает и защищает зависимые строки', async () => {
    const row = await api.createReportRow('1', 'Мой ручной показатель', null);
    await api.createReportRow('1', 'Связанная формула', '=[Мой ручной показатель]*2+1');
    await api.saveReportCell('1', row.id, RANGE.to, '8');
    await api.updateReportRow('1', row.id, 'Ручной показатель', null);
    expect(store.dorm(1).rows.find((item) => item.name === 'Связанная формула')?.formula).toBe(
      '=[Ручной показатель]*2+1',
    );
    await expect(api.deleteReportRow('1', row.id)).rejects.toThrow('ссылаются');
    await api.moveReportRow('1', row.id, 'up');
    expect(store.dorm(1).rows.at(-1)?.id).not.toBe(row.id);
    expect(
      (await api.report('1', RANGE.from, RANGE.to)).rows.find(
        (item) => item.name === 'Связанная формула',
      )?.values[RANGE.to],
    ).toBe('17');
    await expect(api.deleteReportRow('1', 105)).rejects.toThrow('Обязательную');
  });
  it('сохраняет значения удалённого столбца, тип и использованные варианты', async () => {
    const column = await api.createColumn('1', 'residents', {
      name: 'Документы получены',
      kind: 'checkbox',
      options: [],
    });
    await api.saveCustomCell('1', 'residents', 1, column.id, true);
    await api.deleteColumn('1', 'residents', column.id);
    expect(
      (await api.tableColumns('1', 'residents')).find((item) => item.id === column.id)?.archived,
    ).toBe(true);
    await api.restoreColumn('1', 'residents', column.id);
    expect(store.dorm(1).records.residents[0].values[column.id]).toBe(true);
    await expect(
      api.updateColumn('1', 'residents', column.id, {
        name: column.name,
        kind: 'number',
        options: [],
      }),
    ).rejects.toThrow('Тип');
    const status = store.columns(1, 'residents').find((item) => item.kind === 'select')!;
    await expect(
      api.updateColumn('1', 'residents', status.id, {
        ...status,
        options: status.options.slice(1),
      }),
    ).rejects.toThrow('архивировать');
    await api.updateColumn('1', 'residents', status.id, {
      ...status,
      options: status.options.map((item, index) => ({ ...item, archived: index === 0 })),
    });
    expect(
      store.columns(1, 'residents').find((item) => item.id === status.id)?.options[0].archived,
    ).toBe(true);
    const linked = store.columns(1, 'inflow')[5];
    await expect(api.deleteColumn('1', 'inflow', linked.id)).rejects.toThrow('используется');
  });
  it('создаёт подвкладки, список, календарь и копию без записей', async () => {
    const options = {
      table_format: 'list' as const,
      period_mode: 'month' as const,
      date_column_id: null,
      add_row: true,
      clear_list: true,
      row_actions: true,
      show_dates: false,
    };
    const group = await api.createCustomTab(
      '1',
      'Моя группа',
      null,
      ['Первая', 'Вторая'],
      null,
      null,
      options,
    );
    const children = (await api.customTabs('1')).filter((tab) => tab.parent_id === group.id);
    expect(children.map((tab) => tab.name)).toEqual(['Первая', 'Вторая']);
    const tab = children[0];
    await api.createCustomTabTable('1', tab.id, [
      { name: 'Показатель', kind: 'number', options: [] },
    ]);
    expect(
      (await api.tableColumns('1', tab.table_key)).some((column) => column.kind === 'date'),
    ).toBe(true);
    const source = store.dorm(2).settings.tabs[0];
    const created = await api.createCustomTab('1', 'Копия документов', source.id);
    const copied = await api.tableColumns('1', created.table_key);
    expect(copied.map((column) => column.name)).toEqual(
      store.columns(2, source.table_key).map((column) => column.name),
    );
    expect(
      copied.every(
        (column) => !store.columns(2, source.table_key).some((old) => old.id === column.id),
      ),
    ).toBe(true);
    expect(store.dorm(1).records[created.table_key]).toEqual([]);
  });
  it('сохраняет всю структуру атомарно и проверяет версию', async () => {
    const current = await api.dormitorySettings('1');
    const tab = current.tabs[0];
    const input = {
      revision: current.revision,
      tables: [],
      tabs: current.tabs.map((item) => ({
        key: item.table_key,
        name: item.id === tab.id ? 'Документы сотрудников' : item.name,
        parent_key: item.parent_section ?? null,
        is_active: item.id !== tab.id,
        options: item.options,
      })),
      sections: { archive: 'hidden' as const },
      deleted: [],
    };
    const next = await api.saveDormitorySettings('1', input);
    expect(next.tabs[0].name).toBe('Документы сотрудников');
    expect(next.tabs[0].is_active).toBe(false);
    expect(next.sections.find((item) => item.key === 'archive')?.status).toBe('hidden');
    await expect(api.saveDormitorySettings('1', input)).rejects.toThrow('изменилась');
  });
  it('собирает одно общежитие из вкладок разных образцов без потери настроек', async () => {
    const original = store.dorm(2);
    original.settings.tables.residents[0].name = 'Имя во втором образце';
    const tab = store.dorm(3).settings.tabs[0];
    const created = await api.createDormitory({
      name: 'Смешанная структура',
      client_name: 'Клиент',
      tabs: [{ source_id: 'standard:2:residents' }, { source_id: `custom:${tab.id}` }],
    });
    const dorm = store.dorm(created.id);
    expect(dorm.settings.tables.residents[0].name).toBe('Имя во втором образце');
    expect(dorm.settings.tabs.map((item) => item.name)).toContain(tab.name);
    expect(dorm.settings.tabs[0].options?.table_format).toBe(tab.options?.table_format);
    expect(Object.values(dorm.records).every((items) => items.length === 0)).toBe(true);
    const template = await api.saveStructureTemplate('3', 'Структура с настройками');
    const fromTemplate = await api.createDormitory({
      name: 'Из шаблона',
      client_name: 'Клиент',
      structure_template_id: template.id,
    });
    expect(store.dorm(fromTemplate.id).settings.tabs[0].options?.period_mode).toBe(
      tab.options?.period_mode,
    );
  });
  it('создаёт и применяет структуры и шаблоны отчёта с новыми ID', async () => {
    const template = await api.saveStructureTemplate('1', 'Структура для проверки');
    const detail = await api.structureTemplate(template.id);
    const created = await api.createDormitory({
      name: 'Новое тестовое общежитие',
      client_name: 'Тестовый клиент',
      structure_template_id: template.id,
      structure_template_keys: [
        ...Object.keys(detail.snapshot.sections),
        ...detail.snapshot.tabs.map((tab) => tab.key),
      ],
    });
    const settings = await api.dormitorySettings(String(created.id));
    expect(settings.tabs.map((tab) => tab.name)).toEqual(
      store.dorm(1).settings.tabs.map((tab) => tab.name),
    );
    const sourceIds = new Set(
      Object.values(store.dorm(1).settings.tables)
        .flat()
        .map((column) => column.id),
    );
    expect(
      Object.values(settings.tables)
        .flat()
        .every((column) => !sourceIds.has(column.id)),
    ).toBe(true);
    expect(
      Object.values(store.dorm(created.id).records).every((records) => records.length === 0),
    ).toBe(true);
    const report = await api.saveReportTemplate('1', 'Отчёт для проверки');
    expect(
      (await api.reportTemplate(report.id)).rows.some((row) => row.formula?.includes('+')),
    ).toBe(true);
    await api.deleteReportTemplate(report.id);
    expect((await api.reportTemplates()).some((item) => item.id === report.id)).toBe(false);
    await api.deleteStructureTemplate(template.id);
    expect((await api.structureTemplates()).some((item) => item.id === template.id)).toBe(false);
  });
  it('считает все источники, операции, фильтр, дату и группировку', async () => {
    const columns = store.columns(1, 'residents');
    const source = {
      kind: 'table' as const,
      dormitory_id: 1,
      table_key: 'residents' as const,
      value_column_id: columns[4].id,
      date_column_id: columns[3].id,
      group_column_id: columns[5].id,
      filter: null,
    };
    const query: WidgetConfig = {
      name: 'Таблица',
      display: 'number',
      source_kind: 'table',
      operation: 'count',
      period: 'range',
      grouping: 'dormitory',
      all_dormitories: false,
      excluded_dormitory_ids: [],
      sources: [source],
    };
    expect((await api.previewDashboardBlock(query, RANGE.from, RANGE.to)).value).toBe(5);
    expect(
      (await api.previewDashboardBlock({ ...query, operation: 'sum' }, RANGE.from, RANGE.to)).value,
    ).toBe(15000);
    const grouped = await api.previewDashboardBlock(
      { ...query, grouping: 'value' },
      RANGE.from,
      RANGE.to,
    );
    expect(grouped.items.map((item) => [item.label, item.value])).toEqual([
      ['Оформлен', 3],
      ['Ожидает', 2],
    ]);
    const filtered = {
      ...query,
      sources: [
        {
          ...source,
          filter: {
            column_id: columns[5].id,
            operator: 'equals' as const,
            value: columns[5].options[0].id,
          },
        },
      ],
    };
    expect((await api.previewDashboardBlock(filtered, RANGE.from, RANGE.to)).value).toBe(3);
    const layout = store.layout.blocks[0].config;
    expect((await api.previewDashboardBlock(layout, RANGE.from, RANGE.to)).value).toBeGreaterThan(
      0,
    );
    const places = {
      ...layout,
      all_dormitories: false,
      source_kind: 'places' as const,
      sources: [
        { kind: 'places' as const, dormitory_id: 1, hostel_id: null, metric: 'free_f' as const },
      ],
    };
    expect((await api.previewDashboardBlock(places, RANGE.from, RANGE.to)).value).toBe(15);
    const arrivals = {
      ...layout,
      all_dormitories: false,
      source_kind: 'arrival_plan' as const,
      period: 'range' as const,
      sources: [{ kind: 'arrival_plan' as const, dormitory_id: 1 }],
    };
    expect((await api.previewDashboardBlock(arrivals, '2026-11-01', '2026-11-07')).value).toBe(5);
  });
  it('сохраняет расположение, скрывает, восстанавливает и удаляет блоки', async () => {
    const added = await api.saveDashboardBlock(
      store.layout.revision,
      store.layout.blocks[0].config,
    );
    const id = added.blocks.at(-1)!.id;
    await api.saveDashboardLayout({
      revision: added.revision,
      order: [...added.order].reverse(),
      hidden: [`custom:${id}`],
    });
    expect(store.layout.hidden).toContain(`custom:${id}`);
    await api.saveDashboardLayout({
      revision: store.layout.revision,
      order: store.layout.order,
      hidden: [],
    });
    await api.deleteDashboardBlock(id, store.layout.revision);
    expect(store.layout.blocks.some((block) => block.id === id)).toBe(false);
  });
  it('сохраняет отчёт, доступ, любые блоки и четыре итога', async () => {
    const report = copy(store.reports[0]);
    const block = report.blocks[0];
    for (const aggregation of ['sum', 'average', 'last', 'max'] as const) {
      const result = await statisticsApi.preview({ ...block, aggregation }, RANGE);
      expect(result.items).toHaveLength(3);
      expect(result.errors).toEqual([]);
      expect(result.value).not.toBeNull();
    }
    const created = await statisticsApi.create({
      name: 'Личный отчёт',
      description: 'Проверка',
      visibility: 'personal',
      blocks: [block, { ...block, id: 'second', display: 'table', aggregation: 'average' }],
    });
    const saved = await statisticsApi.save(created.id, {
      ...created,
      name: 'Общий отчёт для проверки',
      visibility: 'shared',
      blocks: [...created.blocks].reverse(),
    });
    expect(saved.visibility).toBe('shared');
    expect(saved.blocks[0].id).toBe('second');
    await statisticsApi.remove(saved.id, saved.revision);
    expect((await statisticsApi.reports()).some((item) => item.id === saved.id)).toBe(false);
  });
  it('сопоставляет все шесть назначений столбцов с персоналом', async () => {
    const table = store.dorm(1).settings.tabs[0].table_key;
    const columns = store.columns(1, table);
    const fields = {
      full_name: columns[0].id,
      personnel_number: columns[1].id,
      phone: columns[2].id,
      shift_start: columns[7].id,
      shift_end: columns[8].id,
      reason: columns[0].id,
    };
    await personnelApi.saveBinding('1', table, fields);
    expect((await personnelApi.binding('1', table)).fields).toEqual(fields);
  });
  it('не отправляет ни сохранение, ни неизвестное действие на рабочий сервер', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await api.createReportRow('1', 'Локальная строка', '=1+2*3');
    await expect(api.updateDormitory('1', { name: 'Не отправлять' })).rejects.toThrow(
      'Рабочий сервер не вызывается',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(store.unsupported.has('api.updateDormitory')).toBe(true);
  });
});
