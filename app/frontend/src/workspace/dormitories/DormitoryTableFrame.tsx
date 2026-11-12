import { useContext } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { DormitoryPaging } from './DormitoryPaging';
import type { DormitoryPagingProps } from './DormitoryPaging';
import { TableLayoutContext } from './tableLayoutContext';
import styles from './DormitoryTableFrame.module.css';

type Props = ComponentPropsWithoutRef<'section'> & {
  heading: ReactNode;
  secondary?: ReactNode;
  primary?: ReactNode;
  filters?: ReactNode;
  paging?: DormitoryPagingProps | false;
};

export function DormitoryTableFrame({
  heading,
  secondary,
  primary,
  filters,
  paging,
  children,
  ...sectionProps
}: Props): JSX.Element {
  const { exchange, period, readOnly } = useContext(TableLayoutContext);
  return (
    <section {...sectionProps}>
      <div className="toolbar">{heading}</div>
      <div className={styles.tools} data-testid="dormitory-table-tools">
        <div className={styles.actions} role="group" aria-label="Действия с таблицей">
          <div className={styles.secondary}>
            {exchange}
            <fieldset className={styles.body} disabled={readOnly}>
              {secondary}
            </fieldset>
          </div>
          <fieldset className={styles.primary} disabled={readOnly}>
            {primary}
          </fieldset>
        </div>
        {(filters || period) && (
          <div className={styles.filters} role="group" aria-label="Фильтры таблицы">
            {filters}
            {period}
          </div>
        )}
      </div>
      {paging && <DormitoryPaging {...paging} />}
      <fieldset className={styles.body} disabled={readOnly}>
        {children}
      </fieldset>
      {paging && <DormitoryPaging {...paging} position="bottom" />}
    </section>
  );
}
