import type { ColumnKind } from '../../api/client';

export const columnKinds: Record<ColumnKind, string> = {
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  checkbox: 'Чекбокс',
  select: 'Выпадающий список',
  action: 'Действие',
  hostel: 'Место проживания',
};
