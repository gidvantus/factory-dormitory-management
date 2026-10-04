interface Step {
  title: string;
  text: string;
}

const STEPS: Step[] = [
  {
    title: 'Заводим общежития',
    text: 'Здания, этажи, комнаты и места — по вашей структуре. Можно импортом из таблицы.',
  },
  {
    title: 'Переносим людей',
    text: 'Загружаем список рабочих из Excel или 1С, проверяем дубли и статусы вместе с кадровой службой.',
  },
  {
    title: 'Заселяем',
    text: 'Комендант распределяет людей по свободным местам, ведёт переселения и выселения.',
  },
  {
    title: 'Смотрим отчёты',
    text: 'Заполняемость и история проживания доступны сразу, без выгрузок и ручной сверки.',
  },
];

/** Как это работает: четыре шага внедрения. */
export function StepsSection(): JSX.Element {
  return (
    <section className="section section--alt" id="how">
      <div className="container">
        <div className="section__head reveal">
          <p className="eyebrow">Внедрение</p>
          <h2>Как это работает</h2>
          <p>
            Стартуем с вашими данными: переносим то, что уже есть в таблицах, и запускаем учёт за
            две недели.
          </p>
        </div>

        <ol className="steps">
          {STEPS.map((step) => (
            <li className="step reveal" key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
