import { ApiError } from '../../api/client';
import type {
  CellValue,
  ColumnInput,
  CustomTab,
  CustomTabOptions,
  Dormitory,
  DormitorySettings,
  ReportLink,
  ReportRow,
  SettingsColumn,
  SettingsInput,
  StructureTemplateDetail,
  ReportTemplateDetail,
  TableKey,
} from '../../api/client';
import type {
  CatalogDormitory,
  DashboardLayout,
  WidgetConfig,
  WidgetResult,
  WidgetSource,
} from '../../api/dashboardBlocks';
import type { StatisticsBlock, StatisticsReport, StatisticsResult } from '../../api/statistics';
import type { Binding, PersonnelData, SourceTable } from '../../api/personnel';
import type { Arrival, Settings } from '../../workspace/personnel/arrivals/data';
import { initialSettings } from '../../workspace/personnel/arrivals/data';
import { defaultTabOptions } from '../../workspace/dormitories/customTabOptions';
import { standardTabs } from '../../workspace/dormitories/tabStructure';
import { calculate } from './formula';

export const RANGE = { from: '2026-10-25', to: '2026-10-31' };
export const TODAY = '2026-11-01';
export const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
export const requiredNames = new Set(['Выход Итого', 'Проживает Итого', 'Текучка Итого']);
export interface RecordRow {
  id: number;
  created_at: string;
  values: Record<string, CellValue>;
}
export interface DemoDorm {
  info: Dormitory;
  settings: DormitorySettings;
  rows: ReportRow[];
  records: Record<string, RecordRow[]>;
  binding: Record<string, Binding>;
  hostels: { id: number; name: string }[];
}
export const fail = (message: string, status = 422): never => {
  throw new ApiError(status, message);
};
export function dates(from: string, to: string): string[] {
  const result: string[] = [];
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day.toISOString().slice(0, 10) <= to && result.length < 366;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    result.push(day.toISOString().slice(0, 10));
  return result;
}
const stamp = '2026-10-25T09:00:00Z';

export class Sandbox {
  revision = 0;
  sequence = 10000;
  private listeners = new Set<() => void>();
  readonly calls: string[] = [];
  readonly unsupported = new Set<string>();
  dorms: DemoDorm[] = [];
  structures: StructureTemplateDetail[] = [];
  templates: ReportTemplateDetail[] = [];
  layout: DashboardLayout = {
    revision: 0,
    order: ['residents', 'attendance', 'turnover', 'reports'],
    hidden: [],
    blocks: [],
  };
  reports: StatisticsReport[] = [];
  arrivalSettings: Settings = initialSettings();
  arrivalSample: Arrival = {
    id: 'sample-arrival',
    dorm: 'Северный',
    date: '2026-11-02',
    count: '5',
    values: { transfer: true, transport: 'Автобус', comment: '' },
    people: [
      'Алексей Иванов',
      'Анна Петрова',
      'Игорь Соколов',
      'Елена Орлова',
      'Павел Морозов',
    ].map((name, index) => ({
      id: `person-${index}`,
      name,
      values: { shifts: String(15 + index * 5), workdate: '2026-11-03' },
    })),
  };
  personnel: PersonnelData;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): number => this.revision;
  changed(): void {
    if (this.personnel)
      this.personnel.source_columns = this.dorms.flatMap((dorm) =>
        Object.entries(dorm.settings.tables).flatMap(([table, columns]) =>
          columns
            .filter((column) => !column.archived && !['action', 'hostel'].includes(column.kind))
            .map((column) => ({
              ...column,
              kind: column.kind as 'text' | 'number' | 'date' | 'select' | 'checkbox',
              table_key: table as SourceTable,
              dormitory_id: dorm.info.id,
              source_name:
                dorm.settings.tabs.find((tab) => tab.table_key === table)?.name ??
                dorm.settings.sections.find((section) => section.key === table)?.name ??
                table,
              options: column.options.map((option) => ({ ...option, id: option.id! })),
            })),
        ),
      );
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  id(): number {
    return ++this.sequence;
  }
  constructor() {
    this.dorms = ['Северный', 'Заводской', 'Речной'].map((name, index) =>
      this.seedDorm(index + 1, name),
    );
    this.structures = [this.structure(1, 'Рабочая структура общежития')];
    this.templates = [this.reportTemplate(1, 'Общий отчёт с формулами и связями')];
    const query: WidgetConfig = {
      name: 'Проживают',
      display: 'chart',
      chart_mode: 'dormitories',
      source_kind: 'report',
      operation: 'sum',
      period: 'range',
      grouping: 'dormitory',
      all_dormitories: true,
      excluded_dormitory_ids: [],
      sources: [{ kind: 'report', dormitory_id: 1, row_id: 105 }],
    };
    this.layout.blocks = [
      {
        id: 1,
        config: {
          ...query,
          name: 'Проживают сейчас',
          display: 'number',
          period: 'snapshot',
          sources: this.dorms.map((dorm) => ({
            kind: 'report',
            dormitory_id: dorm.info.id,
            row_id: dorm.rows.find((row) => row.name === 'Проживает Итого')!.id,
          })),
        },
      },
    ];
    this.layout.order.push('custom:1');
    this.reports = [
      {
        id: 1,
        name: 'Управленческий отчёт',
        description: 'Численность, выход и движение персонала',
        visibility: 'shared',
        revision: 1,
        created_by_id: 1,
        created_by_name: 'Демо-владелец',
        can_manage: true,
        created_at: stamp,
        updated_at: stamp,
        blocks: [
          {
            id: 'block-1',
            name: 'Проживают по общежитиям',
            display: 'bar',
            aggregation: 'last',
            breakdown: 'dormitory',
            selected_dormitory_ids: [1, 2, 3],
            query,
          },
        ],
      },
    ];
    this.personnel = {
      today: TODAY,
      dormitories: this.dorms.map((dorm) => ({
        id: dorm.info.id,
        name: dorm.info.name,
        client_name: dorm.info.client_name,
        is_archived: false,
      })),
      plans: [],
      employees: this.arrivalSample.people.map((person, index) => {
        const dorm = this.dorms[index % 3];
        const source = {
          table_key: 'residents' as const,
          row_id: index + 1,
          dormitory_id: dorm.info.id,
          source_name: 'Проживающие',
          values: {
            full_name: person.name,
            personnel_number: `00${index + 1}`,
            phone: index === 1 ? '' : `+7 (900) 000-00-0${index + 1}`,
            hostel_name: 'Корпус А',
            shift_start: '2026-10-01',
            shift_end: `2026-11-${String(index * 3 + 2).padStart(2, '0')}`,
            custom_values: Object.fromEntries(
              dorm.settings.tables.residents.map((column) => [
                column.id,
                column.kind === 'number'
                  ? (index + 1) * 1000
                  : column.kind === 'checkbox'
                    ? index % 2 === 0
                    : column.kind === 'date'
                      ? '2026-11-02'
                      : column.kind === 'select'
                        ? column.options[index % 2].id
                        : person.name,
              ]),
            ),
          },
        };
        return {
          id: `employee-${index}`,
          member_ids: [`employee-${index}`],
          full_name: person.name,
          personnel_number: `00${index + 1}`,
          phone: String(source.values.phone),
          identity_status: 'confirmed' as const,
          current: [source],
          sources: [source],
          history_dormitory_ids: [dorm.info.id],
          variants: {},
        };
      }),
      arrival_plans: [
        {
          id: 'plan-1',
          dormitory_id: 1,
          date: '2026-11-02',
          count: 5,
          names: this.arrivalSample.people.map((person) => person.name),
          revision: 1,
        },
      ],
      source_columns: this.dorms.flatMap((dorm) =>
        dorm.settings.tables.residents
          .filter((column) => !['action', 'hostel'].includes(column.kind))
          .map((column) => ({
            ...column,
            kind: column.kind as 'text' | 'number' | 'date' | 'select' | 'checkbox',
            dormitory_id: dorm.info.id,
            table_key: 'residents' as const,
            source_name: 'Проживающие',
            options: column.options.map((option) => ({ ...option, id: option.id! })),
          })),
      ),
      preferences: {
        revision: 1,
        blocks: [
          {
            id: 'personnel-block-1',
            kind: 'ending',
            title: 'Завершают вахту',
            scope: [],
            days: 7,
            limit: 4,
            wide: false,
            saved_list_id: null,
          },
        ],
        lists: [
          {
            id: 'saved-1',
            name: 'Завершают вахту за 7 дней',
            filter: 'ending',
            dormitory: null,
            days: 7,
            query: '',
            scope: [],
            column_filters: [],
          },
        ],
      },
    };
  }
  seedDorm(id: number, name: string): DemoDorm {
    const tables: Record<string, SettingsColumn[]> = {};
    const records: Record<string, RecordRow[]> = {};
    for (const table of [
      'residents',
      'inflow',
      'outflow',
      'advance',
      'settlement',
      'archive',
      `custom_${id * 100 + 1}`,
    ] as TableKey[]) {
      const specs: [string, ColumnInput['kind'], string | null][] = [
        ['ФИО', 'text', 'full_name'],
        ['Табельный номер', 'text', 'personnel_number'],
        ['Телефон', 'text', 'phone'],
        ['Дата события', 'date', null],
        ['Сумма', 'number', null],
        ['Статус', 'select', null],
        ['Проверен', 'checkbox', null],
        ['Начало вахты', 'date', null],
        ['Окончание вахты', 'date', null],
      ];
      tables[table] = specs.map(([title, kind, builtin_key], position) => ({
        id: this.id(),
        table_key: table,
        builtin_key: table === 'archive' || table.startsWith('custom_') ? null : builtin_key,
        name: title,
        kind,
        position,
        options:
          kind === 'select'
            ? [
                { id: `ready-${id}-${table}`, label: 'Оформлен', archived: false },
                { id: `waiting-${id}-${table}`, label: 'Ожидает', archived: false },
                { id: `old-${id}-${table}`, label: 'Прежний статус', archived: true },
              ]
            : [],
        archived: false,
        used_by: [],
      }));
      records[table] = Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        created_at: `${dates(RANGE.from, RANGE.to)[index]}T09:00:00Z`,
        values: Object.fromEntries(
          tables[table].map((column) => [
            column.id,
            column.kind === 'date'
              ? index === 5
                ? null
                : dates(RANGE.from, RANGE.to)[index]
              : column.kind === 'number'
                ? (index + 1) * 1000
                : column.kind === 'select'
                  ? column.options[index % 2].id
                  : column.kind === 'checkbox'
                    ? index % 2 === 0
                    : column.builtin_key === 'full_name'
                      ? [
                          'Иванов Алексей',
                          'Петрова Анна',
                          'Соколов Игорь',
                          'Орлова Елена',
                          'Морозов Павел',
                          'Белов Никита',
                        ][index]
                      : column.builtin_key === 'phone'
                        ? index === 2
                          ? ''
                          : '+7 (900) 000-00-00'
                        : String(index + 1),
          ]),
        ),
      }));
    }
    const row = (
      n: number,
      name: string,
      formula: string | null,
      values: number[] = [],
      link?: ReportLink,
    ): ReportRow => ({
      id: id * 100 + n,
      name,
      position: n - 1,
      formula,
      link: link ?? null,
      values: Object.fromEntries(
        dates(RANGE.from, RANGE.to).map((date, index) => [date, String(values[index] ?? 0)]),
      ),
      errors: {},
    });
    const rows = [
      row(
        1,
        'Проживает М',
        null,
        [80, 82, 84, 85, 86, 88, 90].map((value) => value - id * 7),
      ),
      row(2, 'Проживает Ж', null, [20, 21, 21, 22, 23, 24, 25]),
      row(3, 'Прибыло', null, [2, 3, 1, 4, 2, 5, 3]),
      row(4, 'Выбыло', null, [1, 0, 2, 1, 0, 1, 2]),
      row(5, 'Проживает Итого', '=[Проживает М]+[Проживает Ж]+[Прибыло]-[Выбыло]'),
      row(6, 'Выход Итого', '=[Проживает Итого]*0.9'),
      row(7, 'Текучка Итого', '=([Выбыло]/[Проживает Итого])*100'),
      row(8, 'Оформлено', null, [], {
        table_key: 'inflow',
        column_id: tables.inflow[5].id,
        operator: 'equals',
        value: tables.inflow[5].options[0].id,
        date_column_id: tables.inflow[3].id,
      }),
    ];
    const tab: CustomTab = {
      id: id * 100 + 1,
      dormitory_id: id,
      name: 'Документы',
      parent_id: null,
      parent_section: null,
      table_key: `custom_${id * 100 + 1}`,
      options: {
        ...defaultTabOptions,
        period_mode: 'month',
        date_column_id: tables[`custom_${id * 100 + 1}`][3].id,
      },
      table_created: true,
      is_active: true,
      has_data: true,
      delete_block_reason: 'В таблице есть записи. Сначала очистите список.',
    };
    return {
      info: {
        id,
        name,
        client_name: 'Демонстрационный клиент',
        is_archived: false,
        created_at: stamp,
      },
      settings: {
        revision: '1',
        tables,
        tabs: [
          tab,
          {
            ...tab,
            id: id * 100 + 2,
            table_key: `custom_${id * 100 + 2}`,
            name: 'Новая вкладка',
            options: { ...defaultTabOptions },
            table_created: false,
            has_data: false,
            delete_block_reason: null,
          },
        ],
        sections: standardTabs.map((section) => ({
          key: section.path,
          name: section.label,
          parent_key:
            (
              {
                inflow: 'movement',
                outflow: 'movement',
                advance: 'payments',
                settlement: 'payments',
              } as Record<string, string>
            )[section.path] ?? null,
          status: 'active',
          has_data: !!records[section.path]?.length,
          delete_block_reason:
            section.path === 'report'
              ? 'Общий отчёт содержит обязательные строки.'
              : records[section.path]?.length
                ? 'Раздел содержит записи.'
                : null,
        })),
        rules: rows,
      },
      rows,
      records,
      binding: {
        residents: {
          columns: tables.residents,
          fields: {
            full_name: tables.residents[0].id,
            personnel_number: tables.residents[1].id,
            phone: tables.residents[2].id,
          },
        },
      },
      hostels: [
        { id: id * 10 + 1, name: 'Корпус А' },
        { id: id * 10 + 2, name: 'Корпус Б' },
      ],
    };
  }
  dorm(id: number | string): DemoDorm {
    return (
      this.dorms.find((item) => item.info.id === Number(id)) ?? fail('Общежитие не найдено', 404)
    );
  }
  columns(id: number | string, table: string): SettingsColumn[] {
    return this.dorm(id).settings.tables[table] ?? [];
  }
  columnInput(input: ColumnInput, old?: SettingsColumn): SettingsColumn {
    const name = input.name.trim();
    if (!name) fail('Укажите название столбца.');
    if (old && input.kind !== old.kind) fail('Тип созданного столбца нельзя изменить.');
    const options =
      input.kind === 'select'
        ? input.options.map((option) => ({
            ...option,
            id: option.id ?? `option-${this.id()}`,
            label: option.label.trim(),
          }))
        : [];
    if (
      input.kind === 'select' &&
      (!options.some((option) => !option.archived) || options.some((option) => !option.label))
    )
      fail('Заполните варианты списка. Хотя бы один вариант должен быть доступен.');
    if (
      new Set(options.map((option) => option.label.toLocaleLowerCase('ru'))).size !== options.length
    )
      fail('Варианты списка не должны повторяться.');
    return {
      id: old?.id ?? this.id(),
      table_key: old?.table_key ?? 'residents',
      builtin_key: old?.builtin_key ?? null,
      position: old?.position ?? 0,
      archived: old?.archived ?? false,
      used_by: old?.used_by ?? [],
      kind: input.kind,
      name,
      options,
    };
  }
  settings(id: number | string): DormitorySettings {
    const dorm = this.dorm(id);
    dorm.settings.rules = dorm.rows;
    for (const columns of Object.values(dorm.settings.tables))
      for (const column of columns)
        column.used_by = dorm.rows
          .filter(
            (row) =>
              row.link &&
              'column_id' in row.link &&
              (row.link.column_id === column.id || row.link.date_column_id === column.id),
          )
          .map((row) => row.name);
    return copy(dorm.settings);
  }
  saveSettings(id: string, input: SettingsInput): DormitorySettings {
    const dorm = this.dorm(id);
    if (input.revision !== dorm.settings.revision)
      fail('Структура изменилась. Обновите настройки.', 409);
    const next = copy(dorm.settings);
    for (const table of input.tables) {
      const previous = next.tables[table.key] ?? [];
      const columns = table.columns.map((column, position) => ({
        ...this.columnInput(
          column,
          previous.find((old) => old.id === column.id),
        ),
        table_key: table.key as TableKey,
        position,
        archived: column.archived,
      }));
      this.uniqueColumns(columns);
      for (const column of columns)
        if (column.archived && column.used_by.length)
          fail(`Столбец используется строками: ${column.used_by.join(', ')}.`);
      next.tables[table.key] = columns;
    }
    for (const inputTab of input.tabs) {
      const tab = next.tabs.find((item) => item.table_key === inputTab.key);
      if (!tab) continue;
      if (!inputTab.name.trim()) fail('Укажите название вкладки.');
      const parent = next.tabs.find((item) => item.table_key === inputTab.parent_key);
      tab.name = inputTab.name.trim();
      tab.is_active = inputTab.is_active;
      tab.parent_id = parent?.id ?? null;
      tab.parent_section = inputTab.parent_key?.startsWith('custom_') ? null : inputTab.parent_key;
      if (tab.parent_id === tab.id) fail('Вкладка не может быть вложена в себя.');
      let ancestor = parent;
      const visited = new Set([tab.id]);
      while (ancestor) {
        if (visited.has(ancestor.id)) fail('Вложенность вкладок не должна образовывать цикл.');
        visited.add(ancestor.id);
        ancestor = next.tabs.find((item) => item.id === ancestor?.parent_id);
      }
      if (inputTab.options) tab.options = copy(inputTab.options);
      if (inputTab.date_column_name && tab.options)
        tab.options.date_column_id =
          next.tables[tab.table_key]?.find(
            (column) => column.name === inputTab.date_column_name && !column.archived,
          )?.id ?? null;
      this.validateOptions(tab.options, next.tables[tab.table_key] ?? []);
    }
    for (const [key, status] of Object.entries(input.sections)) {
      const section = next.sections.find((item) => item.key === key);
      if (section) section.status = status;
    }
    for (const key of input.deleted) {
      const section = next.sections.find((item) => item.key === key);
      const tab = next.tabs.find((item) => item.table_key === key);
      if (section?.delete_block_reason || tab?.delete_block_reason)
        fail(section?.delete_block_reason ?? tab!.delete_block_reason!);
      if (section) section.status = 'deleted';
      if (tab) next.tabs = next.tabs.filter((item) => item.id !== tab.id);
    }
    next.revision = String(Number(next.revision) + 1);
    dorm.settings = next;
    this.changed();
    return this.settings(id);
  }
  uniqueColumns(columns: SettingsColumn[]): void {
    const names = columns
      .filter((item) => !item.archived)
      .map((item) => item.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru'));
    if (new Set(names).size !== names.length) fail('Названия столбцов не должны повторяться.');
  }
  validateOptions(options: CustomTabOptions | undefined, columns: SettingsColumn[]): void {
    if (options?.table_format === 'calendar' && options.period_mode === 'none')
      fail('Выберите период для таблицы с датами в столбцах.');
    if (
      options?.table_format === 'list' &&
      options.period_mode !== 'none' &&
      !columns.some(
        (item) => item.id === options.date_column_id && item.kind === 'date' && !item.archived,
      )
    )
      fail('Выберите действующий столбец типа «Дата» для фильтрации.');
  }
  validateRows(rows: ReportRow[]): void {
    const names = rows.map((row) => row.name.trim());
    if (names.some((name) => !name)) fail('Укажите название строки.');
    if (new Set(names).size !== names.length) fail('Название строки уже используется.');
    const visit = (name: string, path = new Set<string>()): void => {
      const row = rows.find((item) => item.name === name);
      if (!row) fail(`Строка «${name}» не найдена.`);
      if (path.has(name)) fail('Формулы содержат циклическую ссылку.');
      if (row!.formula) {
        const next = new Set([...path, name]);
        try {
          calculate(
            row!.formula,
            (reference) => {
              visit(reference, next);
              return 1;
            },
            true,
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          fail(error instanceof Error ? error.message : 'Проверьте формулу.');
        }
      }
    };
    for (const row of rows) if (row.formula) visit(row.name);
  }
  rowValue(id: number | string, row: ReportRow, date: string, path = new Set<number>()): number {
    if (path.has(row.id)) throw new Error('Циклическая ссылка');
    const dorm = this.dorm(id);
    if (row.link) return this.linkValue(id, row.link, date);
    if (!row.formula) return Number(row.values[date] || 0);
    return calculate(row.formula, (name) => {
      const source = dorm.rows.find((item) => item.name === name);
      if (!source) throw new Error(`Строка «${name}» не найдена`);
      return this.rowValue(id, source, date, new Set([...path, row.id]));
    });
  }
  report(id: string, from: string, to: string) {
    const dorm = this.dorm(id);
    return {
      from_date: from,
      to_date: to,
      rows: dorm.rows.map((row) => {
        const result = copy(row);
        for (const date of dates(from, to)) {
          try {
            result.values[date] = String(Number(this.rowValue(id, row, date).toPrecision(15)));
            delete result.errors[date];
          } catch (error) {
            delete result.values[date];
            result.errors[date] = error instanceof Error ? error.message : 'Ошибка расчёта';
          }
        }
        return result;
      }),
    };
  }
  placeValue(id: number | string, metric: string, hostel: number | null, date: string): number {
    const dorm = this.dorm(id);
    if (hostel && !dorm.hostels.some((item) => item.id === hostel))
      throw new Error('Хостел не найден');
    const hosts = hostel ? [hostel] : dorm.hostels.map((item) => item.id);
    return hosts.reduce((sum, host) => {
      const n = Math.max(0, dates(RANGE.from, date).length - 1);
      const residentsM = 35 + Number(id) + n;
      const residentsF = 12 + (host % 2);
      const paidM = 50;
      const paidF = 20;
      return (
        sum +
        (
          {
            residents_m: residentsM,
            residents_f: residentsF,
            residents_total: residentsM + residentsF,
            paid_m: paidM,
            paid_f: paidF,
            paid_total: paidM + paidF,
            free_m: paidM - residentsM,
            free_f: paidF - residentsF,
            free_total: paidM + paidF - residentsM - residentsF,
          } as Record<string, number>
        )[metric]
      );
    }, 0);
  }
  linkValue(id: number | string, link: ReportLink, date: string): number {
    if (link.table_key === 'places') return this.placeValue(id, link.metric, link.hostel_id, date);
    if (link.table_key === 'arrival_plan')
      return this.personnel.arrival_plans
        .filter((plan) => plan.dormitory_id === Number(id) && plan.date === date)
        .reduce((sum, plan) => sum + plan.count, 0);
    const tableLink = link as Extract<ReportLink, { column_id: number }>;
    const columns = this.columns(id, tableLink.table_key);
    if (!columns.some((column) => column.id === tableLink.column_id && !column.archived))
      throw new Error('Столбец связи не найден');
    return (this.dorm(id).records[link.table_key] ?? []).filter((record) => {
      const value = record.values[tableLink.column_id];
      const matching =
        tableLink.operator === 'not_empty'
          ? value !== null && value !== '' && value !== undefined
          : String(value) === String(tableLink.value);
      const day = tableLink.date_column_id
        ? record.values[tableLink.date_column_id]
        : record.created_at.slice(0, 10);
      return matching && day === date;
    }).length;
  }
  structure(id: number, name: string): StructureTemplateDetail {
    const dorm = this.dorm(id);
    return {
      id: this.id(),
      name,
      tab_count: dorm.settings.sections.length + dorm.settings.tabs.length,
      created_at: stamp,
      snapshot: {
        sections: Object.fromEntries(
          dorm.settings.sections.map((section) => [section.key, section.status]),
        ),
        parents: Object.fromEntries(
          dorm.settings.sections.map((section) => [section.key, section.parent_key]),
        ),
        tabs: dorm.settings.tabs.map((tab) => ({
          key: tab.table_key,
          name: tab.name,
          parent: tab.parent_id ? `custom_${tab.parent_id}` : (tab.parent_section ?? null),
          is_active: tab.is_active,
          options: copy(tab.options),
        })),
        columns: copy(dorm.settings.tables),
        rows: dorm.rows.map(({ name, formula, link }) => ({ name, formula, link })),
      },
    };
  }
  reportTemplate(id: number, name: string): ReportTemplateDetail {
    const dorm = this.dorm(id);
    return {
      id: this.id(),
      name,
      row_count: dorm.rows.length,
      created_at: stamp,
      rows: dorm.rows.map((row) => ({
        name: row.name,
        position: row.position,
        formula: row.formula,
        linked: !!row.link,
      })),
    };
  }
  catalog(): CatalogDormitory[] {
    return this.dorms.map((dorm) => ({
      id: dorm.info.id,
      name: dorm.info.name,
      is_archived: dorm.info.is_archived,
      sources: [
        {
          key: 'report',
          name: 'Общий отчёт',
          kind: 'report',
          rows: dorm.rows.map(({ id, name }) => ({ id, name })),
          columns: [],
          hostels: [],
        },
        {
          key: 'places',
          name: 'Размещение персонала',
          kind: 'places',
          rows: [],
          columns: [],
          hostels: dorm.hostels,
        },
        {
          key: 'arrival_plan',
          name: 'План заездов',
          kind: 'arrival_plan',
          rows: [],
          columns: [],
          hostels: [],
        },
        ...Object.entries(dorm.settings.tables)
          .filter(
            ([key]) =>
              !dorm.settings.sections.some((item) => item.key === key && item.status === 'deleted'),
          )
          .map(([key, columns]) => ({
            key,
            name:
              dorm.settings.tabs.find((tab) => tab.table_key === key)?.name ??
              standardTabs.find((tab) => tab.path === key)?.label ??
              key,
            kind: 'table' as const,
            rows: [],
            columns: columns.filter((column) => !column.archived),
            hostels: [],
          })),
      ],
    }));
  }
  counterpart(source: WidgetSource, dorm: DemoDorm): WidgetSource {
    if (source.dormitory_id === dorm.info.id) return source;
    const original = this.dorm(source.dormitory_id);
    if (source.kind === 'arrival_plan') return { ...source, dormitory_id: dorm.info.id };
    if (source.kind === 'report') {
      const name = original.rows.find((row) => row.id === source.row_id)?.name;
      return {
        ...source,
        dormitory_id: dorm.info.id,
        row_id: dorm.rows.find((row) => row.name === name)?.id ?? -1,
      };
    }
    if (source.kind === 'places') {
      const name = original.hostels.find((item) => item.id === source.hostel_id)?.name;
      return {
        ...source,
        dormitory_id: dorm.info.id,
        hostel_id:
          source.hostel_id === null
            ? null
            : (dorm.hostels.find((item) => item.name === name)?.id ?? -1),
      };
    }
    const sourceTab = original.settings.tabs.find((tab) => tab.table_key === source.table_key);
    const table = sourceTab
      ? (dorm.settings.tabs.find((tab) => tab.name === sourceTab.name)?.table_key ??
        source.table_key)
      : source.table_key;
    const find = (id: number | null): number | null => {
      if (id === null) return null;
      const col = original.settings.tables[source.table_key]?.find((item) => item.id === id);
      return (
        dorm.settings.tables[table]?.find(
          (item) => item.name === col?.name && item.kind === col?.kind,
        )?.id ?? -1
      );
    };
    const filter = source.filter
      ? { ...source.filter, column_id: find(source.filter.column_id)!, value: source.filter.value }
      : null;
    if (filter && source.filter) {
      const sourceCol = original.settings.tables[source.table_key]?.find(
        (item) => item.id === source.filter!.column_id,
      );
      if (sourceCol?.kind === 'select') {
        const label = sourceCol.options.find((option) => option.id === source.filter!.value)?.label;
        filter.value =
          dorm.settings.tables[table]
            ?.find((col) => col.id === filter.column_id)
            ?.options.find((option) => option.label === label)?.id ?? '__missing__';
      }
    }
    return {
      ...source,
      dormitory_id: dorm.info.id,
      table_key: table,
      value_column_id: find(source.value_column_id),
      date_column_id: find(source.date_column_id),
      group_column_id: find(source.group_column_id),
      filter,
    };
  }
  widget(
    config: WidgetConfig,
    from: string,
    to: string,
    aggregation?: StatisticsBlock['aggregation'],
    selected?: number[],
  ): WidgetResult {
    const days = dates(from, to);
    const errors: string[] = [];
    const dorms = this.dorms.filter((dorm) =>
      config.all_dormitories
        ? !config.excluded_dormitory_ids.includes(dorm.info.id)
        : (selected?.includes(dorm.info.id) ??
          config.sources.some((source) => source.dormitory_id === dorm.info.id)),
    );
    const series = dorms.map((dorm) => {
      const source =
        config.sources.find((item) => item.dormitory_id === dorm.info.id) ??
        (config.all_dormitories && config.sources[0]
          ? this.counterpart(config.sources[0], dorm)
          : null);
      const daily = days.map((date) => {
        if (!source) return { date, value: null };
        try {
          let value: number;
          if (source.kind === 'report') {
            const row = dorm.rows.find((item) => item.id === source.row_id);
            if (!row) throw new Error('Строка отчёта не найдена');
            value = this.rowValue(dorm.info.id, row, date);
          } else if (source.kind === 'places')
            value = this.placeValue(dorm.info.id, source.metric, source.hostel_id, date);
          else if (source.kind === 'arrival_plan')
            value = this.personnel.arrival_plans
              .filter((plan) => plan.dormitory_id === dorm.info.id && plan.date === date)
              .reduce((sum, plan) => sum + plan.count, 0);
          else {
            const columns = dorm.settings.tables[source.table_key];
            if (!columns) throw new Error('Таблица не найдена');
            if (
              [source.date_column_id, source.value_column_id, source.filter?.column_id].some(
                (id) =>
                  id != null && !columns.some((column) => column.id === id && !column.archived),
              )
            )
              throw new Error('Столбец источника недоступен');
            const records = (dorm.records[source.table_key] ?? []).filter((record) => {
              if (source.filter) {
                const current = record.values[source.filter.column_id];
                if (
                  source.filter.operator === 'not_empty'
                    ? current == null || current === ''
                    : String(current) !== String(source.filter.value)
                )
                  return false;
              }
              if (!source.date_column_id) return true;
              const event = String(record.values[source.date_column_id] ?? '');
              return !!event && (config.period === 'snapshot' ? event <= date : event === date);
            });
            value =
              config.operation === 'count'
                ? records.length
                : records.reduce(
                    (sum, record) => sum + Number(record.values[source.value_column_id!] ?? 0),
                    0,
                  );
          }
          return { date, value: date > TODAY && source.kind !== 'arrival_plan' ? null : value };
        } catch (error) {
          const message = `${dorm.info.name}: ${error instanceof Error ? error.message : 'Ошибка источника'}`;
          if (!errors.includes(message)) errors.push(message);
          return { date, value: null };
        }
      });
      return {
        dormitory_id: dorm.info.id,
        label: dorm.info.name,
        is_archived: dorm.info.is_archived,
        daily,
      };
    });
    const agg = (values: (number | null)[]): number | null => {
      if (!values.length || values.some((value) => value === null)) return null;
      const numbers = values as number[];
      const mode = aggregation ?? (config.period === 'snapshot' ? 'last' : 'sum');
      return mode === 'last'
        ? numbers[numbers.length - 1]
        : mode === 'max'
          ? Math.max(...numbers)
          : numbers.reduce((sum, value) => sum + value, 0) /
            (mode === 'average' ? numbers.length : 1);
    };
    const items = series.map((item) => ({
      label: item.label,
      value: agg(item.daily.map((day) => day.value)),
      is_archived: item.is_archived,
    }));
    const daily = days.map((date, index) => ({
      date,
      value: series.some((item) => item.daily[index].value === null)
        ? null
        : series.reduce((sum, item) => sum + item.daily[index].value!, 0),
    }));
    if (config.source_kind === 'table' && config.grouping === 'value') {
      const groups = new Map<string, number>();
      for (const dorm of dorms) {
        const src =
          config.sources.find((item) => item.dormitory_id === dorm.info.id) ??
          (config.sources[0] ? this.counterpart(config.sources[0], dorm) : null);
        if (src?.kind !== 'table' || !src.group_column_id) continue;
        const column = dorm.settings.tables[src.table_key]?.find(
          (item) => item.id === src.group_column_id,
        );
        for (const record of dorm.records[src.table_key] ?? []) {
          const day = src.date_column_id ? String(record.values[src.date_column_id] ?? '') : '';
          if (
            src.date_column_id &&
            (!day || (config.period === 'snapshot' ? day > to : day < from || day > to))
          )
            continue;
          if (src.filter) {
            const current = record.values[src.filter.column_id];
            if (
              src.filter.operator === 'not_empty'
                ? current == null || current === ''
                : String(current) !== String(src.filter.value)
            )
              continue;
          }
          const raw = record.values[src.group_column_id];
          const label =
            column?.kind === 'select'
              ? (column.options.find((option) => option.id === raw)?.label ?? 'Не заполнено')
              : String(raw ?? 'Не заполнено');
          groups.set(
            label,
            (groups.get(label) ?? 0) +
              (config.operation === 'count' ? 1 : Number(record.values[src.value_column_id!] ?? 0)),
          );
        }
      }
      items.splice(
        0,
        items.length,
        ...[...groups].map(([label, value]) => ({ label, value, is_archived: false })),
      );
    }
    return {
      id: 0,
      value: items.some((item) => item.value === null)
        ? null
        : items.reduce((sum, item) => sum + item.value!, 0),
      items,
      errors,
      daily,
      series,
    };
  }
  statistics(block: StatisticsBlock, from: string, to: string): StatisticsResult {
    const result = this.widget(
      block.query,
      from,
      to,
      block.aggregation,
      block.selected_dormitory_ids,
    );
    return {
      ...result,
      id: block.id,
      items: result.items.map((item, index) => ({
        ...item,
        dormitory_id: result.series?.[index]?.dormitory_id ?? 0,
      })),
    };
  }
}
