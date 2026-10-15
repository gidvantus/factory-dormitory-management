import type { BlockKind } from '../../api/personnel';

export function PersonnelBlockIcon({
  name,
}: {
  name: BlockKind | 'plus' | 'settings' | 'arrow' | 'up' | 'down' | 'remove';
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'plans' && (
        <>
          <rect x="4" y="5" width="16" height="16" rx="3" />
          <path d="M8 3v4m8-4v4M4 10h16m-12 4h2m4 0h2m-8 3h2" />
        </>
      )}
      {name === 'residents' && (
        <>
          <path d="m3 10 9-7 9 7M5 9v12h14V9M10 21v-7h4v7M8 10h1m6 0h1" />
        </>
      )}
      {name === 'ending' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 6v6l4 2" />
        </>
      )}
      {name === 'contacts' && (
        <>
          <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a14 14 0 0 1-7-7l2-2-2-5Z" />
          <path d="M15 3a6 6 0 0 1 6 6m-6-2a2 2 0 0 1 2 2" />
        </>
      )}
      {name === 'saved' && (
        <>
          <path d="M6 3h12v18l-6-4-6 4V3Z" />
          <path d="M9 8h6m-6 4h4" />
        </>
      )}
      {name === 'plus' && <path d="M12 5v14M5 12h14" />}
      {name === 'arrow' && <path d="M4 12h16m-6-6 6 6-6 6" />}
      {name === 'settings' && (
        <>
          <path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6" />
        </>
      )}
      {name === 'up' && <path d="M12 20V4m-6 6 6-6 6 6" />}
      {name === 'down' && <path d="M12 4v16m-6-6 6 6 6-6" />}
      {name === 'remove' && <path d="m6 6 12 12M6 18 18 6" />}
    </svg>
  );
}
