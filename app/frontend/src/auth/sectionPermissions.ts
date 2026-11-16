import type { ExchangePermissions } from './exchangePermissions';

export const sections = [
  { path: '/cabinet', key: 'overview_enabled', label: 'Обзор' },
  { path: '/cabinet/dormitories', key: 'dormitories_enabled', label: 'Общежития' },
  { path: '/cabinet/personnel', key: 'personnel_enabled', label: 'Персонал' },
  { path: '/cabinet/statistics', key: 'statistics_enabled', label: 'Статистика' },
  { path: '/cabinet/documents', key: 'documents_enabled', label: 'Документы' },
  { path: '/cabinet/shop', key: 'shop_enabled', label: 'Магазин улучшений' },
  { path: '/cabinet/organization', key: 'organization_enabled', label: 'Организация' },
  { path: '/cabinet/organization/members', key: 'members_enabled', label: 'Сотрудники' },
  { path: '/cabinet/profile', key: 'profile_enabled', label: 'Личные данные' },
] as const;

export function hasSectionAccess(
  permissions: ExchangePermissions | undefined,
  key: (typeof sections)[number]['key'],
  role?: string | null,
): boolean {
  return role === 'owner' || permissions?.[key] !== false;
}

export function sectionForPath(path: string): (typeof sections)[number] | undefined {
  return [...sections]
    .sort((a, b) => b.path.length - a.path.length)
    .find(
      (section) =>
        path === section.path ||
        (section.key !== 'overview_enabled' && path.startsWith(section.path + '/')),
    );
}
