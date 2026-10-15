import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { TODAY, dormName, people as demoPeople } from './data';
import type { PersonEvent } from './data';
import {
  OperationsContext,
  readState,
  materializePeople,
  matches,
  MY_NAME,
  storageKey,
} from './operations';
import type { OperationsContextValue, OperationsState } from './operations';
export function PersonnelOperationsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState(readState);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [state]);
  const addEvent = (
    old: OperationsState,
    personId: string,
    title: string,
    detail: string,
    kind: PersonEvent['kind'],
    source: string,
  ): Record<string, PersonEvent[]> => ({
    ...old.events,
    [personId]: [
      {
        id: crypto.randomUUID(),
        date: TODAY,
        kind,
        title,
        detail,
        dormitoryId: demoPeople.find((p) => p.id === personId)!.dormitoryId,
        source,
      },
      ...(old.events[personId] ?? []),
    ],
  });
  const value: OperationsContextValue = {
    state,
    people: materializePeople(state),
    storageError,
    toggleFavorite: (id) =>
      setState((old) => ({
        ...old,
        favorites: old.favorites.includes(id)
          ? old.favorites.filter((p) => p !== id)
          : [...old.favorites, id],
      })),
    savePlan: (plan) =>
      setState((old) => ({
        ...old,
        plans: [...old.plans.filter((p) => p.id !== plan.id), plan],
        events: addEvent(
          old,
          plan.personId,
          plan.kind === 'arrival' ? 'Запланирована следующая вахта' : 'Запланирован выезд',
          `${plan.date}${plan.end ? ` — ${plan.end}` : ''} · ${dormName(plan.dormitoryId)}${plan.comment ? ` · ${plan.comment}` : ''}`,
          'shift',
          'План заездов и выездов',
        ),
      })),
    removePlan: (id) =>
      setState((old) => {
        const plan = old.plans.find((p) => p.id === id);
        if (!plan) return old;
        return {
          ...old,
          plans: old.plans.filter((p) => p.id !== id),
          events: addEvent(
            old,
            plan.personId,
            'План отменён',
            `${plan.date} · ${dormName(plan.dormitoryId)}`,
            'shift',
            'План заездов и выездов',
          ),
        };
      }),
    confirmPlan: (id) =>
      setState((old) => {
        const plan = old.plans.find((p) => p.id === id);
        if (!plan) return old;
        return {
          ...old,
          plans: old.plans.map((p) => (p.id === id ? { ...p, confirmed: !p.confirmed } : p)),
          events: addEvent(
            old,
            plan.personId,
            plan.confirmed ? 'Подтверждение приезда снято' : 'Приезд подтверждён',
            `${plan.date} · ${dormName(plan.dormitoryId)}`,
            'shift',
            'Подготовка следующей вахты',
          ),
        };
      }),
    addNote: (personId, text) =>
      setState((old) => ({
        ...old,
        notes: [
          { id: crypto.randomUUID(), personId, text, date: TODAY, author: MY_NAME },
          ...old.notes,
        ],
        events: addEvent(old, personId, 'Добавлена заметка', text, 'note', `Заметки · ${MY_NAME}`),
      })),
    saveList: (list) =>
      setState((old) => ({ ...old, lists: [...old.lists.filter((l) => l.id !== list.id), list] })),
    removeList: (id) =>
      setState((old) => ({ ...old, lists: old.lists.filter((l) => l.id !== id) })),
    resolveMatch: (id, resolution) =>
      setState((old) => {
        const match = matches.find((m) => m.id === id);
        if (!match || old.resolutions[id]) return old;
        return {
          ...old,
          resolutions: { ...old.resolutions, [id]: resolution },
          events:
            resolution === 'linked'
              ? addEvent(
                  old,
                  match.personId,
                  'Связана архивная запись',
                  `${match.source} · ${match.name} · Т/н ${match.number} · ${match.date}: ${match.reason}. Текущее проживание сохранено.`,
                  'review',
                  'Проверка совпадений',
                )
              : old.events,
        };
      }),
  };
  return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>;
}
