import type { ReactNode } from 'react';

import styles from './Workspace.module.css';

const icons = {
  overview: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="5" rx="2" />
      <rect x="13" y="10" width="8" height="11" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
    </>
  ),
  people: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    </>
  ),
  house: <path d="M3 21h18M5 21V8l7-5 7 5v13M10 21v-5h4v5M9 11h.01M15 11h.01" />,
  bed: <path d="M2 5v15M2 11h20v9M2 16h20M6 11V7h5a3 3 0 0 1 3 3v1" />,
  door: <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />,
  chart: (
    <>
      <path d="M3 3v18h18" />
      <rect x="6" y="12" width="3.2" height="6" rx="1" />
      <rect x="11" y="8" width="3.2" height="10" rx="1" />
      <rect x="16" y="14" width="3.2" height="4" rx="1" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
} satisfies Record<string, ReactNode>;

export type WorkspaceIconName = keyof typeof icons;

export function WorkspaceIcon({ name }: { name: WorkspaceIconName }): JSX.Element {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}
