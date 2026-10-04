import avatarKomendant from '../../assets/avatar-komendant.svg';
import avatarRukovoditel from '../../assets/avatar-rukovoditel.svg';

interface Review {
  avatar: string;
  quote: string;
  author: string;
  role: string;
}

const REVIEWS: Review[] = [
  {
    avatar: avatarKomendant,
    quote:
      '«Раньше сверка занимала полдня: обзвонишь комендантов, сведёшь таблицы, найдёшь расхождения. Теперь открываю отчёт и вижу, где живёт человек.»',
    author: 'Ирина Петровна',
    role: 'комендант общежития №3',
  },
  {
    avatar: avatarRukovoditel,
    quote:
      '«Кадры и общежитие наконец говорят на одном языке: один человек — одна карточка, одна история проживания. Спорных ситуаций стало заметно меньше.»',
    author: 'Анна Сергеева',
    role: 'руководитель кадровой службы',
  },
];

/** Отзывы: два мнения тех, кто ведёт учёт каждый день. */
export function ReviewsSection(): JSX.Element {
  return (
    <section className="section" id="reviews">
      <div className="container">
        <div className="section__head reveal">
          <p className="eyebrow">Отзывы</p>
          <h2>Что говорят те, кто ведёт учёт каждый день</h2>
        </div>

        <div className="cards cards--2">
          {REVIEWS.map((review) => (
            <figure className="card quote reveal" key={review.author}>
              <blockquote>{review.quote}</blockquote>
              <figcaption>
                <img src={review.avatar} alt="" width="56" height="56" />
                <span>
                  <strong>{review.author}</strong>
                  {review.role}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
