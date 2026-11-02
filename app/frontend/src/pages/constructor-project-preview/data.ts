import { builders } from '../constructor-lab/model';
import type { BuilderId, Draft } from '../constructor-lab/model';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';

export type Section = 'overview' | 'dormitories' | 'personnel' | 'statistics';
export const sections: { id: Section; name: string; icon: WorkspaceIconName }[] = [
  { id: 'overview', name: 'Обзор', icon: 'overview' },
  { id: 'dormitories', name: 'Общежития', icon: 'house' },
  { id: 'personnel', name: 'Персонал', icon: 'people' },
  { id: 'statistics', name: 'Статистика', icon: 'chart' },
];

export const projectBuilders = builders.map((builder) => {
  if (builder.id === 'statistics')
    return {
      ...builder,
      fields: [
        ...builder.fields,
        { key: 'scope', label: 'Какие общежития', options: ['Все общежития', 'Только Северный'] },
      ],
      initial: {
        ...builder.initial,
        values: { ...builder.initial.values, scope: 'Все общежития' },
      },
    };
  if (builder.id === 'columns')
    return {
      ...builder,
      initial: {
        ...builder.initial,
        items: [
          { id: 'name', name: 'ФИО', kind: 'Текст', enabled: true },
          { id: 'number', name: 'Табельный номер', kind: 'Текст', enabled: true },
          { id: 'date', name: 'Дата заселения', kind: 'Дата', enabled: true },
          { id: 'phone', name: 'Телефон', kind: 'Текст', enabled: true },
        ],
      },
    };
  return builder;
});

export interface EditorInfo {
  section: Section;
  title: string;
  subtitle: string;
  save: string;
  back: string;
  nameLabel: string;
}

export const editorInfo: Record<BuilderId, EditorInfo> = {
  statistics: {
    section: 'statistics',
    title: 'Настроить блок статистики',
    subtitle: 'Управленческий отчёт',
    save: 'Сохранить блок',
    back: 'Вернуться к отчёту',
    nameLabel: 'Название блока',
  },
  dashboard: {
    section: 'overview',
    title: 'Настроить показатель на обзоре',
    subtitle: 'Обзор организации',
    save: 'Сохранить показатель',
    back: 'Вернуться к обзору',
    nameLabel: 'Название блока',
  },
  structure: {
    section: 'dormitories',
    title: 'Настроить общежитие',
    subtitle: 'Северный / Вкладки и таблицы',
    save: 'Сохранить структуру',
    back: 'Вернуться в общежитие',
    nameLabel: 'Название общежития',
  },
  table: {
    section: 'dormitories',
    title: 'Создать свою вкладку',
    subtitle: 'Северный / Новая таблица',
    save: 'Создать вкладку',
    back: 'Вернуться в общежитие',
    nameLabel: 'Название вкладки',
  },
  columns: {
    section: 'dormitories',
    title: 'Настроить столбцы',
    subtitle: 'Северный / Проживающие',
    save: 'Сохранить столбцы',
    back: 'Вернуться в таблицу',
    nameLabel: 'Название таблицы в примере',
  },
  formula: {
    section: 'dormitories',
    title: 'Настроить строку отчёта',
    subtitle: 'Северный / Общий отчёт',
    save: 'Сохранить строку',
    back: 'Вернуться к общему отчёту',
    nameLabel: 'Название строки',
  },
  link: {
    section: 'dormitories',
    title: 'Связать строку с таблицей',
    subtitle: 'Северный / Общий отчёт',
    save: 'Сохранить связь',
    back: 'Вернуться к общему отчёту',
    nameLabel: 'Название строки отчёта',
  },
  places: {
    section: 'dormitories',
    title: 'Связать строку с размещением',
    subtitle: 'Северный / Общий отчёт',
    save: 'Сохранить связь',
    back: 'Вернуться к общему отчёту',
    nameLabel: 'Название строки отчёта',
  },
  personnel: {
    section: 'dormitories',
    title: 'Связать таблицу с персоналом',
    subtitle: 'Северный / Проживающие',
    save: 'Сохранить сопоставление',
    back: 'Вернуться в таблицу',
    nameLabel: 'Таблица в примере',
  },
  arrivals: {
    section: 'personnel',
    title: 'Настроить поле заезда',
    subtitle: 'План заездов / Поля формы и карточка',
    save: 'Сохранить поле',
    back: 'Вернуться к плану заездов',
    nameLabel: 'Название поля',
  },
  workspace: {
    section: 'personnel',
    title: 'Настроить блок персонала',
    subtitle: 'Персонал / Рабочая поверхность',
    save: 'Сохранить блок',
    back: 'Вернуться к рабочей поверхности',
    nameLabel: 'Название блока',
  },
  filters: {
    section: 'personnel',
    title: 'Сохранить свой список',
    subtitle: 'Персонал / Сотрудники',
    save: 'Сохранить список',
    back: 'Вернуться к сотрудникам',
    nameLabel: 'Название списка',
  },
};

export function getBuilder(id: BuilderId) {
  return projectBuilders.find((builder) => builder.id === id)!;
}

const viewKeys = new Set(['display', 'group', 'format', 'period', 'layout', 'card', 'types']);
export function fieldGroup(key: string): 'data' | 'view' {
  return viewKeys.has(key) ? 'view' : 'data';
}

export function changedSettings(before: Draft, after: Draft): string[] {
  const keys = Object.keys(after.values).filter((key) => before.values[key] !== after.values[key]);
  if (JSON.stringify(before.items) !== JSON.stringify(after.items)) keys.push('items');
  return keys;
}
