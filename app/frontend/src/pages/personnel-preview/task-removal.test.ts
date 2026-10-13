import { afterEach, expect, it } from 'vitest';
import { blockStorageKey, initialBlocks, readBlocks } from './data';
import { readState, storageKey } from './operations';

afterEach(() => localStorage.clear());

it('удаляет старый блок задач, сохраняя настройку остальных блоков', () => {
  const block = { ...initialBlocks[1], id: 'custom', title: 'Мои проживающие', scope: ['north'] };
  localStorage.setItem(
    blockStorageKey,
    JSON.stringify([{ ...initialBlocks[0], id: 'tasks', kind: 'tasks' }, block]),
  );
  expect(readBlocks()).toEqual([block]);
  localStorage.setItem(blockStorageKey, JSON.stringify([{ ...initialBlocks[0], kind: 'tasks' }]));
  expect(readBlocks()).toEqual([]);
});

it('удаляет сохранённые задачи и их события, сохраняя заметки и планы', () => {
  const state = readState();
  const note = {
    id: 'note-event',
    date: '2026-10-10',
    kind: 'note',
    title: 'Добавлена заметка',
    detail: 'Связались с сотрудником',
    dormitoryId: 'north',
    source: 'Заметки',
  };
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      ...state,
      favorites: ['person-1'],
      tasks: [{ id: 'task-1' }],
      events: { 'person-1': [{ ...note, id: 'task-event', kind: 'task' }, note] },
    }),
  );
  const restored = readState();
  expect(restored).not.toHaveProperty('tasks');
  expect(restored.events['person-1']).toEqual([note]);
  expect(restored.notes).toEqual(state.notes);
  expect(restored.plans).toEqual(state.plans);
  expect(restored.favorites).toEqual(['person-1']);
});
