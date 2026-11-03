export const directions = [
  {
    name: 'Живой квартал',
    short: 'Домики и люди',
    note: 'Тёплый обзор с иллюстрациями: за цифрами видны общежития и люди.',
  },
  {
    name: 'Аналитика',
    short: 'Диаграммы и доли',
    note: 'Крупные диаграммы помогают сравнить общежития и увидеть динамику.',
  },
  {
    name: 'Пульт руководителя',
    short: 'Главное на экране',
    note: 'Выразительная панель с контрастной сводкой и компактными показателями.',
  },
  {
    name: 'Лента дня',
    short: 'Сводка как история',
    note: 'Обзор читается сверху вниз: кто проживает, кто работает и где нужен отчёт.',
  },
  {
    name: 'Атлас общежитий',
    short: 'Каждому свой блок',
    note: 'У каждого общежития свой домик, показатели и график. Удобно сравнивать объекты.',
  },
] as const;

export type Period = 'recent' | 'october';
export type Metric = 'residents' | 'attendance' | 'turnover';
export interface Dorm {
  id: string;
  name: string;
  client: string;
  residents: number;
  attendance: number;
  turnover: number;
  color: string;
  tint: string;
  ready: boolean;
}

const base: Dorm[] = [
  {
    id: 'north',
    name: 'Северное',
    client: 'Стройсервис',
    residents: 334,
    attendance: 301,
    turnover: 6,
    color: '#2d8069',
    tint: '#dcefe5',
    ready: true,
  },
  {
    id: 'central',
    name: 'Центральное',
    client: 'Стройсервис',
    residents: 276,
    attendance: 244,
    turnover: 5,
    color: '#427caf',
    tint: '#e0edf8',
    ready: true,
  },
  {
    id: 'park',
    name: 'Парковое',
    client: 'Промресурс',
    residents: 183,
    attendance: 162,
    turnover: 3,
    color: '#9b6544',
    tint: '#fae7d9',
    ready: false,
  },
  {
    id: 'south',
    name: 'Южное',
    client: 'Промресурс',
    residents: 127,
    attendance: 112,
    turnover: 2,
    color: '#7a65ab',
    tint: '#eae3f7',
    ready: true,
  },
];

export function getDorms(period: Period, scope: string): Dorm[] {
  return base
    .map((dorm, i) => ({
      ...dorm,
      residents:
        period === 'october' ? ([318, 264, 176, 122][i] ?? dorm.residents) : dorm.residents,
      attendance:
        period === 'october' ? ([286, 233, 154, 107][i] ?? dorm.attendance) : dorm.attendance,
      turnover: period === 'october' ? ([8, 6, 4, 2][i] ?? dorm.turnover) : dorm.turnover,
    }))
    .filter((dorm) => scope === 'all' || dorm.id === scope);
}

export const scopes = base.map(({ id, name }) => ({ id, name }));
export const count = (value: number): string => new Intl.NumberFormat('ru-RU').format(value);
export const total = (dorms: Dorm[], key: Metric): number =>
  dorms.reduce((sum, dorm) => sum + dorm[key], 0);
export const snapshot = (period: Period): string =>
  period === 'recent' ? '2 ноября 2026' : '31 октября 2026';
export const periodLabel = (period: Period): string =>
  period === 'recent' ? '20 октября — 2 ноября' : '1 — 31 октября';

export function series(dorms: Dorm[], metric: Metric, period: Period): number[] {
  const end = total(dorms, metric);
  const length = period === 'recent' ? 14 : 31;
  return Array.from({ length }, (_, i) => {
    if (i === length - 1) return end;
    const progress = i / (length - 1);
    const factor =
      metric === 'turnover'
        ? 0.8 + Math.sin(i * 1.7) * 0.3
        : 0.77 + progress * 0.21 + Math.sin(i * 0.8) * 0.025;
    return Math.max(0, Math.round(end * factor));
  });
}
