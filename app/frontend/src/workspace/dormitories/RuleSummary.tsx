import type { DormitorySettings, ReportRow } from '../../api/client';
import { columnKinds } from './columnKinds';

const metrics: Record<string, string> = {
  residents_m: 'Проживает М',
  residents_f: 'Проживает Ж',
  residents_total: 'Проживает всего',
  paid_m: 'Оплачено М',
  paid_f: 'Оплачено Ж',
  paid_total: 'Оплачено всего',
  free_m: 'Свободно М',
  free_f: 'Свободно Ж',
  free_total: 'Свободно всего',
};

export function RuleSummary({
  row,
  settings,
}: {
  row: Pick<ReportRow, 'link' | 'formula'>;
  settings: DormitorySettings;
}): JSX.Element {
  const link = row.link;
  if (!link)
    return <p>{row.formula ? `Формула: ${row.formula}` : 'Заполняется вручную по дням'}</p>;
  if (link.table_key === 'arrival_plan')
    return <p>Брать количество приезжающих из «Плана заездов» этого общежития за дату отчёта.</p>;
  if (link.table_key === 'places')
    return (
      <p>
        Брать «{metrics[link.metric]}» за дату отчёта ·{' '}
        {link.hostel_id ? 'выбранный хостел' : 'все хостелы'}.
      </p>
    );
  const columns = settings.tables[link.table_key] ?? [];
  const column = columns.find((item) => item.id === link.column_id);
  const date = columns.find((item) => item.id === link.date_column_id);
  const name =
    settings.tabs.find((item) => item.table_key === link.table_key)?.name ??
    settings.sections.find((item) => item.key === link.table_key)?.name ??
    'Таблица';
  const value =
    column?.kind === 'select'
      ? (column.options.find((item) => item.id === link.value)?.label ?? 'Вариант списка')
      : typeof link.value === 'boolean'
        ? link.value
          ? 'Да'
          : 'Нет'
        : String(link.value ?? '');
  return (
    <p>
      Считать записи из «{name}», где «{column?.name ?? 'Столбец'}»{' '}
      {link.operator === 'not_empty' ? 'заполнен' : `= «${value}»`}. Группировать по{' '}
      {date ? `«${date.name}»` : 'дате создания записи'}.
      {column && <small> {columnKinds[column.kind]}</small>}
    </p>
  );
}
