import type { CustomTab, Dormitory } from '../../api/client';

export const standardTabs = [
  { path: 'report', label: 'Большой отчёт' },
  { path: 'places', label: 'Места' },
  { path: 'residents', label: 'Проживающие' },
  { path: 'movement', label: 'Движение персонала' },
  { path: 'inflow', label: 'Приток' },
  { path: 'outflow', label: 'Отток' },
  { path: 'payments', label: 'Выплаты' },
  { path: 'advance', label: 'На аванс' },
  { path: 'settlement', label: 'На расчёт' },
  { path: 'archive', label: 'Архив' },
];
export function standardParents(dorm: Dormitory | null): Record<string, string | null> {
  return {
    inflow: 'movement',
    outflow: 'movement',
    advance: 'payments',
    settlement: 'payments',
    ...dorm?.section_parents,
  };
}
export function standardChain(key: string, parents: Record<string, string | null>): string[] {
  const chain = [key];
  while (parents[chain[0]] && !chain.includes(parents[chain[0]] as string))
    chain.unshift(parents[chain[0]] as string);
  return chain;
}
export function standardPath(key: string, parents: Record<string, string | null>): string {
  return standardChain(key, parents).join('/');
}
export function customChain(tab: CustomTab, tabs: CustomTab[]): CustomTab[] {
  const chain = [tab];
  let parent = tabs.find((item) => item.id === tab.parent_id);
  while (parent && !chain.some((item) => item.id === parent?.id)) {
    chain.unshift(parent);
    parent = tabs.find((item) => item.id === parent?.parent_id);
  }
  return chain;
}
export function customLabel(tab: CustomTab, tabs: CustomTab[]): string {
  const chain = customChain(tab, tabs);
  const section = standardTabs.find((item) => item.path === chain[0].parent_section);
  return [...(section ? [section.label] : []), ...chain.map((item) => item.name)].join(' → ');
}
