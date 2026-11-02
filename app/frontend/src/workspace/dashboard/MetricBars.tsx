import type { CSSProperties } from 'react';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { formatCount } from './data';
import { itemTone } from './summary';
import styles from './Dashboard.module.css';

export function MetricBars({
  items,
  clients = false,
}: {
  items: { id: string; label: string; value: number | null; archived?: boolean }[];
  clients?: boolean;
}): JSX.Element {
  const maximum = Math.max(1, ...items.map((item) => item.value ?? 0));
  return (
    <ul className={styles.metricBars}>
      {items.map((item) => {
        const tone = itemTone(item.id);
        return (
          <li
            key={item.id}
            data-archived={item.archived ? 'true' : 'false'}
            style={{ '--bar-color': tone.color, '--bar-tint': tone.tint } as CSSProperties}
          >
            <span className={styles.barIcon} aria-hidden="true">
              {clients ? item.label.slice(0, 1) : <WorkspaceIcon name="house" />}
            </span>
            <span className={styles.barName}>
              {item.label}
              {item.archived ? ' (Архив)' : ''}
            </span>
            <strong>{formatCount(item.value)}</strong>
            <span className={styles.barTrack} aria-hidden="true" data-unknown={item.value === null}>
              <span style={{ width: `${(Math.max(0, item.value ?? 0) / maximum) * 100}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
