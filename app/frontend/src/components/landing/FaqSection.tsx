interface Question {
  question: string;
  answer: string;
}

const QUESTIONS: Question[] = [
  {
    question: 'Можно перенести данные из Excel?',
    answer:
      'Да. Мы принимаем таблицы со списком рабочих и структурой общежитий: комнаты, места, этажи. На старте помогаем привести данные к единому виду и проверяем дубли.',
  },
  {
    question: 'Система работает без интернета?',
    answer:
      'Домовой разворачивается в вашем контуре, во внутренней сети предприятия. Внешний доступ не нужен, данные проживающих не покидают вашу инфраструктуру.',
  },
  {
    question: 'Сколько человек может работать одновременно?',
    answer:
      'Ограничений на число комендантов и кадровиков нет: роли настраиваются, каждый видит свои общежития и разделы. Одновременная работа десятков пользователей — штатный режим.',
  },
  {
    question: 'Ведётся ли история проживания?',
    answer:
      'Да. Сохраняются заселения, переселения и выселения с датами. По карточке человека видно всю цепочку: где жил, когда и по какому основанию выехал.',
  },
  {
    question: 'Что с выгрузками и отчётностью?',
    answer:
      'Любой список и отчёт выгружается в Excel. Заполняемость считается автоматически по зданиям, подразделениям и периодам.',
  },
];

/** Частые вопросы: раскрывающиеся блоки. */
export function FaqSection(): JSX.Element {
  return (
    <section className="section section--alt" id="faq">
      <div className="container">
        <div className="section__head section__head--center reveal">
          <p className="eyebrow">Вопросы</p>
          <h2>Частые вопросы</h2>
        </div>

        <div className="faq reveal">
          {QUESTIONS.map((item, index) => (
            <details key={item.question} open={index === 0}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
