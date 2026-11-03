/**
 * Состояние учётной записи: точка и слово.
 *
 * Подпись только «Активирован» / «Не активирован»: `is_active` значит «кабинет
 * активирован», а не «заблокирован», и второго прочтения у флага быть не должно.
 * Залитая точка — активирован, контурная — нет: цвет поддерживает слово, а не
 * заменяет его.
 */
export function ActivationFlag({ active }: { active: boolean }): JSX.Element {
  return (
    <span className={active ? 'flag' : 'flag flag--off'}>
      <span className="flag__dot" aria-hidden="true" />
      {active ? 'Активирован' : 'Не активирован'}
    </span>
  );
}
