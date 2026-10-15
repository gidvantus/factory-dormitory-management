import type { Block, BlockKind } from '../../api/personnel';
import { blockNames, defaultBlocks } from '../../workspace/personnel/helpers';

// Только демонстрационные данные. Настройки и сотрудники организации не запрашиваются.
export const designs = [
  {
    name: 'Иллюстрации',
    note: 'Небольшие сюжетные рисунки, мягкие цветные шапки и знакомые карточки. У каждого типа блока — свой характер.',
  },
  {
    name: 'Инфографика',
    note: 'Крупные показатели, распределение по общежитиям и календарная диаграмма. Больше информации считывается с первого взгляда.',
  },
  {
    name: 'Лента',
    note: 'Открытые горизонтальные секции: показатель слева, содержимое справа. Меньше рамок, удобнее длинная рабочая поверхность.',
  },
  {
    name: 'Папки',
    note: 'Цветные вкладки, бумажные карточки и аккуратные строки. Рабочая поверхность похожа на разложенные по темам папки.',
  },
  {
    name: 'Фокус',
    note: 'Первый блок — крупный акцент, остальные — компактные модули. Переставьте блоки, чтобы выбрать, что важнее сегодня.',
  },
] as const;
export const dorms = [
  { id: 1, name: 'Северное', count: 58 },
  { id: 2, name: 'Центральное', count: 42 },
  { id: 3, name: 'Парковое', count: 24 },
];
const people = [
  {
    id: 1,
    name: 'Александр Волков',
    dorm: 1,
    end: 0,
    phone: '+7 (900) 000-00-01',
  },
  {
    id: 2,
    name: 'Михаил Соколов',
    dorm: 2,
    end: 1,
    phone: '+7 (900) 000-00-02',
  },
  { id: 3, name: 'Сергей Козлов', dorm: 1, end: 3, phone: null },
  {
    id: 4,
    name: 'Анна Морозова',
    dorm: 3,
    end: 4,
    phone: '+7 (900) 000-00-04',
  },
  {
    id: 5,
    name: 'Дмитрий Орлов',
    dorm: 2,
    end: 5,
    phone: '+7 (900) 000-00-05',
  },
  {
    id: 6,
    name: 'Елена Белова',
    dorm: 3,
    end: 9,
    phone: '+7 (900) 000-00-06',
  },
  {
    id: 7,
    name: 'Иван Лебедев',
    dorm: 1,
    end: 12,
    phone: '+7 (900) 000-00-07',
  },
  { id: 8, name: 'Ольга Новикова', dorm: 2, end: 20, phone: null },
];
const arrivals = [
  { id: 1, dorm: 1, day: 0, count: 6, names: 'А. Смирнов, П. Кузнецов и ещё 4' },
  { id: 2, dorm: 2, day: 2, count: 8, names: 'В. Петров, Н. Васильев и ещё 6' },
  { id: 3, dorm: 3, day: 5, count: 4, names: 'Р. Фёдоров, А. Попов и ещё 2' },
];
export type Row = {
  id: number;
  title: string;
  detail: string;
  value: string;
  number?: number;
  day?: number;
};
export type Snapshot = { total: number; label: string; rows: Row[]; allRows: Row[] };
export const kinds: BlockKind[] = ['plans', 'residents', 'ending', 'contacts', 'saved'];
export { blockNames };
export const scopeName = (scope: number[]): string =>
  scope.length
    ? dorms
        .filter((d) => scope.includes(d.id))
        .map((d) => d.name)
        .join(', ')
    : 'Все общежития';
export function newBlock(kind: BlockKind): Block {
  return {
    id: crypto.randomUUID(),
    kind,
    title: blockNames[kind],
    scope: [],
    days: kind === 'plans' ? 7 : 5,
    limit: 4,
    wide: false,
    saved_list_id: kind === 'saved' ? 'crew' : null,
  };
}
export function preset(expanded = false): Block[] {
  const blocks = defaultBlocks.map((block) => ({ ...block, scope: [...block.scope] }));
  return expanded
    ? [
        ...blocks,
        { ...newBlock('saved'), title: 'Бригада № 2' },
        { ...newBlock('plans'), title: 'Заезды в Северное', scope: [1], wide: true },
        { ...newBlock('ending'), title: 'Вахты · Центральное', scope: [2] },
        { ...newBlock('contacts'), title: 'Контакты · Парковое', scope: [3] },
      ]
    : blocks;
}
export function snapshot(block: Block, dorm: number, empty: boolean): Snapshot {
  const allowed = (id: number): boolean =>
    (!dorm || dorm === id) && (!block.scope.length || block.scope.includes(id));
  const labels: Record<BlockKind, string> = {
    residents: 'проживают сейчас',
    plans: 'человек ожидается',
    ending: 'завершают вахту',
    contacts: 'сотрудников в списке',
    saved: 'в сохранённом списке',
  };
  if (empty) return { total: 0, label: labels[block.kind], rows: [], allRows: [] };
  let rows: Row[];
  let total: number;
  if (block.kind === 'residents') {
    rows = dorms
      .filter((d) => allowed(d.id))
      .map((d) => ({
        id: d.id,
        title: d.name,
        detail: 'Проживают сейчас',
        value: String(d.count),
        number: d.count,
      }));
    total = rows.reduce((sum, row) => sum + (row.number ?? 0), 0);
  } else if (block.kind === 'plans') {
    rows = arrivals
      .filter((a) => allowed(a.dorm) && a.day <= block.days)
      .map((a) => ({
        id: a.id,
        title: dorms.find((d) => d.id === a.dorm)!.name,
        detail: a.names,
        value: `${a.count} чел.`,
        number: a.count,
        day: a.day,
      }));
    total = rows.reduce((sum, row) => sum + (row.number ?? 0), 0);
  } else {
    const selected = people.filter(
      (p) =>
        allowed(p.dorm) &&
        (block.kind !== 'ending' || p.end <= block.days) &&
        (block.kind !== 'saved' || (block.saved_list_id === 'crew' && [1, 3, 7].includes(p.id))),
    );
    rows = selected.map((p) => ({
      id: p.id,
      title: p.name,
      detail: `${dorms.find((d) => d.id === p.dorm)!.name} · № 00${p.id}`,
      value:
        block.kind === 'ending'
          ? p.end
            ? `Через ${p.end} дн.`
            : 'Сегодня'
          : block.kind === 'contacts'
            ? (p.phone ?? 'Телефон не указан')
            : 'В бригаде № 2',
      day: block.kind === 'ending' ? p.end : undefined,
    }));
    total = rows.length;
  }
  return { total, label: labels[block.kind], rows: rows.slice(0, block.limit), allRows: rows };
}
