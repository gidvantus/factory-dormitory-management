import { describe, expect, it } from 'vitest';

import {
  DEMO_MONDAY,
  DEMO_TODAY,
  groupLines,
  makeBlock,
  makeDraft,
  nextDispatches,
  previewGroups,
} from './model';

describe('предпросмотр личных уведомлений', () => {
  it('в понедельник объединяет текущие данные и оба выходных, сохраняя подписи дней', () => {
    const groups = previewGroups(makeBlock('arrivals'), DEMO_MONDAY, false);
    expect(groups.map((group) => group.label)).toEqual([
      'За понедельник, 9 ноября',
      'За субботу, 7 ноября',
      'За воскресенье, 8 ноября',
    ]);
    expect(groups.map((group) => group.rows.length)).toEqual([2, 2, 2]);
    expect(new Set(groups.flatMap((group) => group.rows).map((row) => row.date))).toEqual(
      new Set(['2026-11-07', '2026-11-08', '2026-11-09']),
    );
  });

  it('при включённых выходных не добавляет их повторно к понедельнику', () => {
    const groups = previewGroups(makeBlock('arrivals'), DEMO_MONDAY, true);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].rows.every((row) => row.date === DEMO_MONDAY)).toBe(true);
  });

  it('сохраняет условия и выбранное общежитие при переносе данных за выходные', () => {
    const block = makeBlock('arrivals');
    block.scope = 'Северное';
    block.conditions = [{ id: 'condition', field: 'date', operator: 'today', value: '' }];
    const groups = previewGroups(block, DEMO_MONDAY, false);
    expect(groups.map((group) => group.rows.length)).toEqual([1, 1, 1]);
    expect(groups.flatMap((group) => group.rows).every((row) => row.dormitory === 'Северное')).toBe(
      true,
    );
  });

  it('по обычным дням применяет числовые условия до подсчёта суммы', () => {
    const block = makeBlock('places');
    block.format = 'sum';
    block.sumField = 'free';
    block.conditions = [{ id: 'minimum', field: 'free', operator: 'greater', value: '10' }];
    const groups = previewGroups(block, DEMO_TODAY, false);
    expect(groupLines(block, groups[0])).toEqual(['Свободных мест: 12']);
  });
});

describe('расписание макета', () => {
  it('пропускает выходные и ставит ближайшую отправку в понедельник', () => {
    const schedule = makeDraft().schedule;
    expect(nextDispatches(schedule, new Date('2026-11-06T07:00:00Z'))[0]).toEqual({
      day: '2026-11-09',
      time: '09:00',
    });
  });

  it('разрешает субботнюю отправку, когда выходные включены', () => {
    const schedule = { ...makeDraft().schedule, weekends: true };
    expect(nextDispatches(schedule, new Date('2026-11-06T07:00:00Z'))[0]).toEqual({
      day: '2026-11-07',
      time: '09:00',
    });
  });

  it('считает время в выбранном часовом поясе и не повторяет прошедшее', () => {
    const schedule = {
      ...makeDraft().schedule,
      timezone: 'Asia/Yekaterinburg',
      times: ['09:00', '18:00'],
    };
    expect(nextDispatches(schedule, new Date('2026-11-03T05:00:00Z'))[0]).toEqual({
      day: '2026-11-03',
      time: '18:00',
    });
  });

  it('переносит разовую субботнюю отправку на понедельник без дублей', () => {
    const schedule = makeDraft().schedule;
    schedule.frequency = 'once';
    schedule.onceDate = '2026-11-07';
    schedule.times = ['09:00', '18:00'];
    expect(nextDispatches(schedule, new Date('2026-11-06T00:00:00Z'))).toEqual([
      { day: '2026-11-09', time: '09:00' },
    ]);
  });

  it('использует последний день короткого месяца и переносит воскресенье на понедельник', () => {
    const schedule = makeDraft().schedule;
    schedule.frequency = 'monthly';
    schedule.monthDay = 31;
    expect(nextDispatches(schedule, new Date('2027-02-02T00:00:00Z'))[0]).toEqual({
      day: '2027-03-01',
      time: '09:00',
    });
  });

  it('позволяет очистить разовую дату во время редактирования', () => {
    const schedule = makeDraft().schedule;
    schedule.frequency = 'once';
    schedule.onceDate = '';
    expect(nextDispatches(schedule)).toEqual([]);
  });
});
