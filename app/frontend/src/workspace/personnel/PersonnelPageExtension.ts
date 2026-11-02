import type { ReactNode } from 'react';
import type { ListCriteria } from './employeeListFilters';
import type { PersonnelData } from '../../api/personnel';

/** Необязательные дополнительные вкладки; обычный кабинет работает без расширения. */
export type PersonnelPageExtension = {
  onData?: (data: PersonnelData) => void;
  active: boolean;
  actions: ReactNode;
  tabs: ReactNode;
  content: (controls: {
    onPerson: (id: string) => void;
    onList: (criteria: ListCriteria) => void;
  }) => ReactNode;
};
