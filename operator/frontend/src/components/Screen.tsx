import type { ReactNode } from 'react';

/**
 * Каркас экрана кабинета: шапка с маркой «Домовой» и содержимое.
 *
 * Шапка одна на все экраны — вход, проверка сессии и разделы кабинета, —
 * поэтому она живёт здесь, а не в каждой странице. `nav` занимает место между
 * маркой и правым блоком: он есть только у разделов, а форма входа остаётся
 * без навигации. `right` занимает место подписи «Кабинет оператора»: после
 * входа там логин и «Выйти».
 */
export function Screen({
  children,
  right,
  nav,
}: {
  children: ReactNode;
  right?: ReactNode;
  nav?: ReactNode;
}): JSX.Element {
  return (
    <div className="screen">
      <header className={nav ? 'topbar topbar--nav' : 'topbar'}>
        <span className="brand" aria-label="Домовой — кабинет оператора">
          {/* Марка — инлайновый SVG из макета: внешних картинок и шрифтов нет. */}
          <svg className="brand__mark" viewBox="0 0 40 40" aria-hidden="true">
            <rect width="40" height="40" rx="12" fill="#E8E1D7" />
            <g
              fill="none"
              stroke="#3A362F"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 19 20 9l11 10M12.5 19v12h15V19M17 31v-6h6v6" />
            </g>
          </svg>
          <span className="brand__name">Домовой</span>
        </span>
        {nav}
        {right ?? <p className="topbar__note">Кабинет оператора</p>}
      </header>
      {children}
    </div>
  );
}
