import type { ReactNode } from 'react';

/**
 * Иконки лендинга: контурные, 24×24, рисуются текущим цветом.
 * Все декоративные — смысл несут тексты рядом, поэтому `aria-hidden`.
 */
interface IconProps {
  /** Толщина контура: у галочек списка она больше, у бейджей — меньше. */
  strokeWidth?: number;
}

function Icon({ strokeWidth = 1.9, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function HouseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 21h18" />
      <path d="M5 21V8l7-5 7 5v13" />
      <path d="M10 21v-5h4v5" />
    </Icon>
  );
}

export function HouseWindowIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 21h18" />
      <path d="M5 21V8l7-5 7 5v13" />
      <path d="M10 21v-5h4v5" />
      <path d="M9 11h.01" />
      <path d="M15 11h.01" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </Icon>
  );
}

export function ShieldCheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </Icon>
  );
}

export function ChartLineIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 3v18h18" />
      <path d="M7 16l4-5 3 3 5-7" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 6L9 17l-5-5" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

export function TransferIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </Icon>
  );
}

export function BarsIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 3v18h18" />
      <rect x="6" y="12" width="3.2" height="6" rx="1" />
      <rect x="11" y="8" width="3.2" height="10" rx="1" />
      <rect x="16" y="14" width="3.2" height="4" rx="1" />
    </Icon>
  );
}

export function BadgeIdIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <circle cx="8" cy="11" r="2" />
      <path d="M5.5 16c.4-1.4 1.4-2.2 2.5-2.2s2.1.8 2.5 2.2" />
      <path d="M14 10h5" />
      <path d="M14 14h3" />
    </Icon>
  );
}

export function GridIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="5" rx="2" />
      <rect x="13" y="10" width="8" height="11" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
    </Icon>
  );
}

export function BedIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2 5v15" />
      <path d="M2 11h20v9" />
      <path d="M2 16h20" />
      <path d="M6 11V7h5a3 3 0 0 1 3 3v1" />
    </Icon>
  );
}
