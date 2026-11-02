import { describe, expect, it } from 'vitest';
import {
  cellValue,
  columnError,
  configureColumn,
  initialDemo,
  selectRecord,
  updateSource,
} from './model';
import type { Demo } from './model';

function date(demo: Demo): string {
  return cellValue(demo, demo.rows[0], demo.columns[1]);
}

describe('Заполнение ячеек из выбранной записи', () => {
  it('различает людей с одинаковыми ФИО по ID и очищает связь без выбранного человека', () => {
    const initial = initialDemo();
    const secondIvanov = selectRecord(initial, 'row-1', 'person', 'resident-4');
    expect(date(initial)).toBe('2026-09-14');
    expect(date(secondIvanov)).toBe('2026-10-27');
    expect(date(selectRecord(secondIvanov, 'row-1', 'person', ''))).toBe('');
  });

  it('обновляет живую связь и оставляет пустое значение пустым', () => {
    const changed = updateSource(
      initialDemo(),
      'residents',
      'resident-1',
      'check_in',
      '2026-09-20',
    );
    expect(date(changed)).toBe('2026-09-20');
    expect(date(updateSource(changed, 'residents', 'resident-1', 'check_in', ''))).toBe('');
  });

  it('фиксирует копию, обновляет её при выборе другого человека и сохраняет её при переименовании', () => {
    const snapshot = configureColumn(initialDemo(), 'checkin', { update: 'copy' });
    const changed = updateSource(snapshot, 'residents', 'resident-1', 'check_in', '2026-09-20');
    expect(date(changed)).toBe('2026-09-14');
    expect(date(configureColumn(changed, 'checkin', { name: 'Заселение' }))).toBe('2026-09-14');
    const otherPerson = selectRecord(changed, 'row-1', 'person', 'resident-4');
    expect(date(otherPerson)).toBe('2026-10-27');
    expect(date(selectRecord(otherPerson, 'row-1', 'person', ''))).toBe('');
    expect(date(configureColumn(changed, 'checkin', { update: 'live' }))).toBe('2026-09-20');
  });

  it('блокирует несовместимый тип, неверный столбец выбора и повторяющееся название', () => {
    const initial = initialDemo();
    for (const patch of [
      { fieldId: 'room' },
      { sourceId: 'employees' },
      { matchColumnId: 'start' },
      { name: '  ФИО ' },
    ]) {
      const invalid = configureColumn(initial, 'checkin', patch);
      expect(columnError(invalid, invalid.columns[1])).not.toBe('');
      expect(date(invalid)).toBe('');
    }
  });

  it('сбрасывает прежнюю выбранную запись и копии при смене таблицы выбора', () => {
    const initial = configureColumn(initialDemo(), 'checkin', { update: 'copy' });
    const changed = configureColumn(initial, 'person', { sourceId: 'employees' });
    expect(changed.rows[0].selected.person).toBeUndefined();
    expect(changed.rows[0].copies.checkin).toBeUndefined();
    expect(date(changed)).toBe('');
    const mapped = configureColumn(changed, 'checkin', {
      sourceId: 'employees',
      fieldId: 'shift_start',
    });
    expect(date(selectRecord(mapped, 'row-1', 'person', 'employee-1'))).toBe('2026-09-14');
  });

  it('сохраняет ручные значения при временном переключении на связь', () => {
    const initial = initialDemo();
    const linked = configureColumn(initial, 'start', { mode: 'lookup', fieldId: 'check_in' });
    expect(cellValue(linked, linked.rows[0], linked.columns[2])).toBe('2026-09-14');
    const manual = configureColumn(linked, 'start', { mode: 'manual' });
    expect(cellValue(manual, manual.rows[0], manual.columns[2])).toBe('2026-11-09');
  });
});
