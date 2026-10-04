import type { ReactNode } from 'react';

import {
  BadgeIdIcon,
  BarsIcon,
  HouseWindowIcon,
  ShieldCheckIcon,
  TransferIcon,
  UsersIcon,
} from './icons';

interface Feature {
  /** Класс-модификатор пастельного бейджа; без него бейдж мятный. */
  tone?: 'peach' | 'sky' | 'butter' | 'lilac';
  icon: ReactNode;
  title: string;
  text: string;
}

const FEATURES: Feature[] = [
  {
    icon: <UsersIcon />,
    title: 'Реестр проживающих',
    text: 'Единая карточка человека: ФИО, подразделение, должность, контакты, статус проживания и фото.',
  },
  {
    tone: 'peach',
    icon: <TransferIcon />,
    title: 'Заселение и выселение',
    text: 'Операции с историей: кто, куда, когда и на каком основании. Переселение в два клика, без потери данных.',
  },
  {
    tone: 'sky',
    icon: <HouseWindowIcon />,
    title: 'Общежития, комнаты, места',
    text: 'Структура зданий до конкретного места: этаж, комната, койка. Свободные места видны сразу.',
  },
  {
    tone: 'butter',
    icon: <BarsIcon />,
    title: 'Отчёты по занятости',
    text: 'Заполняемость по зданиям, подразделениям и периодам. Отчёт собирается сам и выгружается в Excel.',
  },
  {
    tone: 'lilac',
    icon: <BadgeIdIcon />,
    title: 'Кадровые данные и документы',
    text: 'Связка с кадровым учётом, вложения: договоры, заявления, копии документов — в карточке человека.',
  },
  {
    icon: <ShieldCheckIcon />,
    title: 'Роли и доступы',
    text: 'Комендант видит своё общежитие, кадры — данные людей, руководитель — сводку. Права настраиваются.',
  },
];

/** Возможности: шесть блоков о том, что умеет система. */
export function FeaturesSection(): JSX.Element {
  return (
    <section className="section" id="features">
      <div className="container">
        <div className="section__head reveal">
          <p className="eyebrow">Возможности</p>
          <h2>Всё, что нужно для учёта общежития</h2>
          <p>
            Никаких надстроек и макросов: реестры, заселение и отчётность живут в одной системе и
            обновляются сразу.
          </p>
        </div>

        <div className="cards cards--3">
          {FEATURES.map((feature) => (
            <article className="card card--feature reveal" key={feature.title}>
              <span
                className={feature.tone ? `icon-badge icon-badge--${feature.tone}` : 'icon-badge'}
                aria-hidden="true"
              >
                {feature.icon}
              </span>
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
