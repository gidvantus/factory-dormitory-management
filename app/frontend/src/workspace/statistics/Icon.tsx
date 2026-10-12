import type { ReactNode } from 'react';
import styles from './Statistics.module.css';
const paths = {
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="m10 5-7 7 7 7M3 12h18" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  edit: <path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14Z" />,
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
  check: <path d="m5 12 4 4L19 6" />,
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 10h18M3 15h18M10 4v16" />
    </>
  ),
  line: <path d="M3 3v18h18M6 16l5-6 4 3 6-8" />,
  bar: <path d="M3 3v18h18M8 16v-5M13 16V7M18 16v-8" />,
  area: <path d="M3 3v18h18M6 17v-4l5-6 4 5 6-3v8Z" />,
  pie: (
    <>
      <path d="M12 3v9h9A9 9 0 0 0 12 3Z" />
      <path d="M8 4a9 9 0 1 0 12 12H8Z" />
    </>
  ),
  number: <path d="M9 3 7 21M17 3l-2 18M4 9h17M3 15h17" />,
  layers: <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" />,
  refresh: <path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 3M4 16l2 3a8 8 0 0 0 13-2" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4M17 3v4M3 11h18" />
    </>
  ),
} satisfies Record<string, ReactNode>;
export function Icon({ name }: { name: keyof typeof paths }): JSX.Element {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
