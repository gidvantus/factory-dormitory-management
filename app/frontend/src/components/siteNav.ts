/** Ссылка меню шапки: либо якорь раздела главной, либо внутренний адрес. */
export interface SiteNavLink {
  href: string;
  label: string;
}

/** Разделы главной в том порядке, в котором они идут на странице. */
const SECTIONS = [
  { id: 'roles', label: 'Кому подходит' },
  { id: 'features', label: 'Возможности' },
  { id: 'how', label: 'Как работает' },
  { id: 'interface', label: 'Интерфейс' },
  { id: 'faq', label: 'Вопросы' },
] as const;

/**
 * Меню шапки публичных страниц.
 *
 * На главной якорь ведёт по самой странице, на любом другом адресе — на
 * соответствующий раздел главной (`/#features`). Без базы `/` пункты меню на
 * `/pricing` молча искали бы раздел на странице тарифов, где его нет.
 * «Тарифы» — отдельный адрес, а не якорь: он стоит только там, где пользователь
 * ещё не на прайсе.
 */
export function siteNav({
  onHome,
  withPricing = false,
}: {
  onHome: boolean;
  withPricing?: boolean;
}): SiteNavLink[] {
  const prefix = onHome ? '' : '/';
  const links: SiteNavLink[] = SECTIONS.slice(0, 4).map((section) => ({
    href: `${prefix}#${section.id}`,
    label: section.label,
  }));

  if (withPricing) {
    links.push({ href: '/pricing', label: 'Тарифы' });
  }

  const faq = SECTIONS[4];
  links.push({ href: `${prefix}#${faq.id}`, label: faq.label });

  return links;
}
