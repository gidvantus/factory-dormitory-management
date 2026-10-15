import type { Block, Employee, PersonnelData, SavedList, Source } from '../../api/personnel';
import { addDays, dateLabel, filterPeople, value } from './helpers';

export type BlockCriteria = Omit<SavedList, 'id' | 'name'>;
export type ChartPoint = { label: string; count: number };

export function blockCriteria(
  block: Block,
  dormitory: number | null,
  data: PersonnelData,
): BlockCriteria {
  const list =
    block.kind === 'saved'
      ? data.preferences.lists.find((item) => item.id === block.saved_list_id)
      : undefined;
  return {
    filter:
      block.kind === 'saved'
        ? (list?.filter ?? 'all')
        : block.kind === 'residents' || block.kind === 'contacts'
          ? 'current'
          : 'ending',
    dormitory: dormitory ?? list?.dormitory ?? null,
    days: list?.days ?? block.days,
    query: list?.query ?? '',
    scope: block.scope.length ? block.scope : (list?.scope ?? []),
    ...(list?.column_filters?.length ? { column_filters: list.column_filters } : {}),
  };
}

/** Выбираем ту же текущую запись, которая попала в фильтр, а не прошлую вахту человека. */
export function blockSource(
  person: Employee,
  criteria: BlockCriteria,
  today: string,
): Source | undefined {
  return person.current
    .filter((source) => {
      const end = value(source, 'shift_end');
      return (
        (criteria.dormitory == null || source.dormitory_id === criteria.dormitory) &&
        (!criteria.scope.length || criteria.scope.includes(source.dormitory_id)) &&
        (criteria.filter !== 'ending' || (end >= today && end <= addDays(today, criteria.days)))
      );
    })
    .sort((a, b) => {
      const aEnd = value(a, 'shift_end');
      const bEnd = value(b, 'shift_end');
      return (aEnd || '9999').localeCompare(bEnd || '9999');
    })[0];
}

/** На длинном периоде объединяем соседние даты, сохраняя весь итог в диаграмме. */
export function calendarSeries(events: { date: string; count: number }[]): ChartPoint[] {
  const dates = new Map<string, number>();
  events.forEach(({ date, count }) => dates.set(date, (dates.get(date) ?? 0) + count));
  const ordered = [...dates].sort(([a], [b]) => a.localeCompare(b));
  const includeYear =
    ordered.length > 1 && ordered[0][0].slice(0, 4) !== ordered[ordered.length - 1][0].slice(0, 4);
  const size = Math.max(1, Math.ceil(ordered.length / 5));
  const series: ChartPoint[] = [];
  for (let index = 0; index < ordered.length; index += size) {
    const group = ordered.slice(index, index + size);
    series.push({
      label:
        group.length === 1
          ? dateLabel(group[0][0], includeYear)
          : `${dateLabel(group[0][0], includeYear)} – ${dateLabel(group[group.length - 1][0], includeYear)}`,
      count: group.reduce((total, [, count]) => total + count, 0),
    });
  }
  return series;
}

export function workspaceBlockData(block: Block, data: PersonnelData, dormitory: number | null) {
  const criteria = blockCriteria(block, dormitory, data);
  const allowed = (id: number): boolean =>
    (criteria.dormitory == null || criteria.dormitory === id) &&
    (!criteria.scope.length || criteria.scope.includes(id));
  const list = data.preferences.lists.find((item) => item.id === block.saved_list_id);
  const missingList = block.kind === 'saved' && !list;
  const people = missingList || block.kind === 'plans' ? [] : filterPeople(data, criteria);
  if (criteria.filter === 'ending') {
    people.sort((a, b) =>
      value(blockSource(a, criteria, data.today), 'shift_end').localeCompare(
        value(blockSource(b, criteria, data.today), 'shift_end'),
      ),
    );
  }
  const plans =
    block.kind === 'plans'
      ? data.arrival_plans
          .filter(
            (plan) =>
              allowed(plan.dormitory_id) &&
              plan.date >= data.today &&
              plan.date <= addDays(data.today, block.days),
          )
          .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      : [];
  const dorms =
    block.kind === 'residents'
      ? data.dormitories
          .filter((dorm) => allowed(dorm.id))
          .map((dorm, index) => ({
            ...dorm,
            tone: Math.min(index, 4),
            count: people.filter((person) =>
              person.current.some((source) => source.dormitory_id === dorm.id),
            ).length,
          }))
      : [];
  const events =
    block.kind === 'plans'
      ? plans.map((plan) => ({ date: plan.date, count: plan.count }))
      : block.kind === 'ending'
        ? people.flatMap((person) => {
            const end = value(blockSource(person, criteria, data.today), 'shift_end');
            return end ? [{ date: end, count: 1 }] : [];
          })
        : [];
  return {
    criteria,
    missingList,
    list,
    people,
    plans,
    dorms,
    total:
      block.kind === 'plans' ? plans.reduce((total, plan) => total + plan.count, 0) : people.length,
    series: calendarSeries(events),
    scopeLabel:
      criteria.dormitory != null || criteria.scope.length
        ? data.dormitories
            .filter((dorm) => allowed(dorm.id))
            .map((dorm) => dorm.name)
            .join(' · ') || 'Нет общежитий в выбранной области'
        : 'Все общежития',
  };
}
export type WorkspaceBlockData = ReturnType<typeof workspaceBlockData>;
