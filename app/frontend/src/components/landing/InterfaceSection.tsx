import type { ReactNode } from 'react';

import { BarsIcon, BedIcon, GridIcon, HouseIcon, TransferIcon, UsersIcon } from './icons';

interface NavItem {
  icon: ReactNode;
  label: string;
}

const NAV: NavItem[] = [
  { icon: <GridIcon />, label: 'Обзор' },
  { icon: <UsersIcon />, label: 'Проживающие' },
  { icon: <HouseIcon />, label: 'Общежития' },
  { icon: <BedIcon />, label: 'Комнаты и места' },
  { icon: <TransferIcon />, label: 'Заселения' },
  { icon: <BarsIcon />, label: 'Отчёты' },
];

interface Resident {
  initials: string;
  tone?: 'mint' | 'peach' | 'lilac';
  name: string;
  room: string;
  department: string;
  since: string;
  status: string;
  statusTone: 'ok' | 'wait' | 'out';
}

const RESIDENTS: Resident[] = [
  {
    initials: 'ИП',
    tone: 'mint',
    name: 'Иванов П. С.',
    room: '214 · место 2',
    department: 'СМУ-4',
    since: '12.03.2026',
    status: 'Проживает',
    statusTone: 'ok',
  },
  {
    initials: 'СА',
    tone: 'peach',
    name: 'Сидоров А. В.',
    room: '214 · место 3',
    department: 'СМУ-4',
    since: '02.04.2026',
    status: 'Проживает',
    statusTone: 'ok',
  },
  {
    initials: 'КМ',
    tone: 'lilac',
    name: 'Кузнецов М. И.',
    room: '108 · место 1',
    department: 'Участок №2',
    since: '18.02.2026',
    status: 'Переселение',
    statusTone: 'wait',
  },
  {
    initials: 'ГА',
    name: 'Гафуров А. Р.',
    room: '307 · место 4',
    department: 'Ремонтный цех',
    since: '05.05.2026',
    status: 'Проживает',
    statusTone: 'ok',
  },
  {
    initials: 'ЕО',
    tone: 'mint',
    name: 'Егоров О. Н.',
    room: '—',
    department: 'Участок №1',
    since: '—',
    status: 'Выселен 20.09',
    statusTone: 'out',
  },
];

/** Интерфейс: макет рабочего места коменданта. */
export function InterfaceSection(): JSX.Element {
  return (
    <section className="section" id="interface">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <p className="eyebrow">Интерфейс</p>
          <h2>Понятный экран вместо семи вкладок</h2>
          <p>
            Рабочее место коменданта: занятость по зданию, свободные места и список проживающих с
            быстрыми действиями.
          </p>
        </div>

        <div className="mockup reveal">
          <div className="mockup__bar">
            <span className="mockup__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="mockup__url">app.domovoy.ru/dormitory/3</span>
          </div>

          <div className="mockup__body">
            <nav className="app-nav" aria-label="Разделы системы (макет)">
              <p className="app-nav__title">Домовой</p>
              <ul>
                {NAV.map((item, index) => (
                  <li key={item.label} aria-current={index === 0 ? 'page' : undefined}>
                    {item.icon}
                    {item.label}
                  </li>
                ))}
              </ul>
            </nav>

            <div className="app-main">
              <div className="app-main__head">
                <h3>Общежитие №3 · ул. Фрунзенская, 12</h3>
                <span className="tag tag--ok">Занятость 92%</span>
              </div>

              <div className="tiles">
                <div className="tile">
                  <p className="tile__value">420</p>
                  <p className="tile__label">мест всего</p>
                </div>
                <div className="tile">
                  <p className="tile__value">388</p>
                  <p className="tile__label">занято</p>
                </div>
                <div className="tile">
                  <p className="tile__value">32</p>
                  <p className="tile__label">свободно</p>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <caption>Проживающие · обновлено сегодня, 08:15</caption>
                  <thead>
                    <tr>
                      <th scope="col">Проживающий</th>
                      <th scope="col">Комната</th>
                      <th scope="col">Подразделение</th>
                      <th scope="col">Заезд</th>
                      <th scope="col">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RESIDENTS.map((resident) => (
                      <tr key={resident.name}>
                        <td className="person">
                          <span data-tone={resident.tone}>{resident.initials}</span>
                          <span>{resident.name}</span>
                        </td>
                        <td>{resident.room}</td>
                        <td>{resident.department}</td>
                        <td>{resident.since}</td>
                        <td>
                          <span className={`tag tag--${resident.statusTone}`}>
                            {resident.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
