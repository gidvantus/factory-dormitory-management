import avatarKadrovik from '../../assets/avatar-kadrovik.svg';
import avatarKomendant from '../../assets/avatar-komendant.svg';
import avatarRukovoditel from '../../assets/avatar-rukovoditel.svg';
import { CheckIcon } from './icons';

interface Role {
  avatar: string;
  title: string;
  subtitle: string;
  tasks: string[];
}

const ROLES: Role[] = [
  {
    avatar: avatarKomendant,
    title: 'Коменданту',
    subtitle: 'Ежедневная работа с общежитием',
    tasks: [
      'Заселить человека в свободное место за минуту',
      'Видеть, кто живёт в комнате и с какого числа',
      'Отметить выезд и освободить место',
    ],
  },
  {
    avatar: avatarKadrovik,
    title: 'Кадровой службе',
    subtitle: 'Данные о людях и документах',
    tasks: [
      'Карточка рабочего с подразделением и статусом',
      'История проживания: где и когда жил человек',
      'Выгрузка списков для проверок и отчётности',
    ],
  },
  {
    avatar: avatarRukovoditel,
    title: 'Руководителю',
    subtitle: 'Заполняемость и расходы',
    tasks: [
      'Заполняемость по каждому зданию и комнате',
      'Сводка по подразделениям и сменам',
      'Где есть резерв мест, а где уже тесно',
    ],
  },
];

/** Кому подходит: три роли и их ежедневные задачи. */
export function RolesSection(): JSX.Element {
  return (
    <section className="section section--alt" id="roles">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <p className="eyebrow">Роли</p>
          <h2>Одна система — три разных рабочих дня</h2>
          <p>
            Комендант заселяет, кадры сверяют, руководитель смотрит заполняемость. Каждый видит
            только то, что нужно его роли.
          </p>
        </div>

        <div className="cards cards--3">
          {ROLES.map((role) => (
            <article className="card card--role reveal" key={role.title}>
              <div className="card--role__head">
                <img src={role.avatar} alt="" width="84" height="84" />
                <div>
                  <h3>{role.title}</h3>
                  <p>{role.subtitle}</p>
                </div>
              </div>
              <div className="card--role__body">
                <ul className="check-list">
                  {role.tasks.map((task) => (
                    <li key={task}>
                      <CheckIcon strokeWidth={2.4} />
                      {task}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
