interface Occupancy {
  name: string;
  /** Значение в процентах: ширина заливки и подпись справа. */
  percent: number;
  tone?: 'peach' | 'sky' | 'butter';
}

const OCCUPANCY: Occupancy[] = [
  { name: 'Общежитие №1', percent: 84 },
  { name: 'Общежитие №2', percent: 96, tone: 'peach' },
  { name: 'Общежитие №3', percent: 92, tone: 'sky' },
  { name: 'Общежитие №4', percent: 71, tone: 'butter' },
  { name: 'Общежитие №5', percent: 88 },
];

const CHART_LABEL = `Заполняемость общежитий: ${OCCUPANCY.map(
  (item) => `${item.name.replace('Общежитие ', '')} — ${item.percent}%`,
).join(', ')}`;

/** Отчётность: текстовый блок и диаграмма заполняемости. */
export function ReportsSection(): JSX.Element {
  return (
    <section className="section section--alt" id="reports">
      <div className="container report">
        <div className="reveal">
          <p className="eyebrow">Отчётность</p>
          <h2>Отчёты, которые не нужно собирать вручную</h2>
          <p className="hero__lead">
            Заполняемость пересчитывается при каждом заселении. Руководитель открывает отчёт и видит
            картину по зданиям, подразделениям и периодам — без писем «пришлите актуальный список».
          </p>
          <p className="note">
            Пример данных для демонстрации. В системе отчёты строятся по вашим общежитиям.
          </p>
        </div>

        <div className="chart reveal" role="img" aria-label={CHART_LABEL}>
          {OCCUPANCY.map((item) => (
            <div className="chart__row" key={item.name}>
              <span className="chart__name">{item.name}</span>
              <span className="chart__track">
                <span
                  className="chart__fill"
                  data-tone={item.tone}
                  style={{ width: `${item.percent}%` }}
                />
              </span>
              <span className="chart__value">{item.percent}%</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
