import { useId, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import resident from '../../assets/avatar-rezident.svg';
import manager from '../../assets/avatar-kadrovik.svg';
import commandant from '../../assets/avatar-komendant.svg';
import s from './OverviewDesignPreview.module.css';
import { count, directions, getDorms, periodLabel, scopes, series, snapshot, total } from './data';
import type { Dorm, Metric, Period } from './data';

type Props = { dorms: Dorm[]; period: Period; empty: boolean; onOpen: (dorm: Dorm) => void };
const metrics: { key: Metric; title: string; icon: WorkspaceIconName; color: string }[] = [
  { key: 'residents', title: 'Проживают', icon: 'people', color: '#2d8069' },
  { key: 'attendance', title: 'На работе', icon: 'chart', color: '#427caf' },
  { key: 'turnover', title: 'Текучка', icon: 'door', color: '#9b6544' },
];
const tone = (dorm: Dorm): CSSProperties =>
  ({ '--tone': dorm.color, '--tint': dorm.tint }) as CSSProperties;

function House({
  color = '#2d8069',
  small = false,
}: {
  color?: string;
  small?: boolean;
}): JSX.Element {
  return (
    <svg
      className={small ? s.smallHouse : s.house}
      viewBox="0 0 190 160"
      fill="none"
      aria-hidden="true"
    >
      <ellipse cx="96" cy="149" rx="83" ry="7" fill="#263849" opacity=".06" />
      <path
        d="M37 61 94 23l58 38v84H37Z"
        fill="#fffdf6"
        stroke="#314650"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="m26 64 68-47 69 47-8 9-61-41-60 41Z"
        fill={color}
        stroke="#314650"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M124 36V19h15v28" fill={color} stroke="#314650" strokeWidth="2" />
      <path d="M44 79h100v65H44Z" fill={color} opacity=".09" />
      {[57, 113].map((x) =>
        [76, 105].map((y) => (
          <g key={`${x}-${y}`}>
            <rect
              x={x}
              y={y}
              width="20"
              height="21"
              rx="2"
              fill="#f6d68b"
              stroke="#314650"
              strokeWidth="1.5"
            />
            <path d={`M${x + 10} ${y}v21m-10-11h20`} stroke="#314650" strokeWidth="1.2" />
          </g>
        )),
      )}
      <path d="M86 145v-35a8 8 0 0 1 16 0v35" fill={color} stroke="#314650" strokeWidth="1.5" />
      <circle cx="97" cy="129" r="1.5" fill="#fff" />
      <path
        d="M14 145h163M25 144v-19m0 8c-20-1-12-21-2-13-4-17 15-17 12-3 15-2 12 19-10 16M163 144v-23m0 11c-17-2-13-21-2-17-3-14 14-12 12-1 14 5 8 20-10 18"
        stroke="#456951"
        strokeWidth="2"
        strokeLinecap="round"
        fill="#dcebd9"
      />
      {!small && (
        <>
          <path
            d="M12 38h19m-14-7h19m117 51h17"
            stroke="#b8cfd2"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="155" cy="20" r="9" fill="#f6d68b" />
        </>
      )}
    </svg>
  );
}

function People(): JSX.Element {
  return (
    <div className={s.people} aria-hidden="true">
      {[resident, manager, commandant].map((src) => (
        <img key={src} src={src} alt="" />
      ))}
    </div>
  );
}

function Line({
  values,
  color = '#2d8069',
  label,
  area = false,
}: {
  values: number[];
  color?: string;
  label: string;
  area?: boolean;
}): JSX.Element {
  const id = useId().replace(/:/g, '');
  const max = Math.max(...values, 1) * 1.15;
  const min = area ? 0 : Math.min(...values) * 0.8;
  const coords = values.map((v, i) => [
    8 + (i / Math.max(1, values.length - 1)) * 464,
    144 - ((v - min) / (max - min)) * 126,
  ]);
  const points = coords.map((p) => p.join(',')).join(' ');
  return (
    <svg
      className={s.line}
      viewBox="0 0 480 160"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".23" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area &&
        [36, 87, 144].map((y) => (
          <path
            key={y}
            d={`M0 ${y}h480`}
            stroke="currentColor"
            opacity=".09"
            strokeDasharray="3 5"
          />
        ))}
      {area && <polygon points={`8,150 ${points} 472,150`} fill={`url(#${id})`} />}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {coords.length > 0 && (
        <circle
          cx={coords[coords.length - 1][0]}
          cy={coords[coords.length - 1][1]}
          r="4"
          fill={color}
          stroke="white"
          strokeWidth="2"
        />
      )}
    </svg>
  );
}

function Empty(): JSX.Element {
  return (
    <div className={s.empty}>
      <WorkspaceIcon name="chart" />
      <strong>Здесь появится ваша статистика</strong>
      <span>Заполните общий отчёт общежития, чтобы увидеть показатели.</span>
    </div>
  );
}

function Ring({ dorms, empty }: Pick<Props, 'dorms' | 'empty'>): JSX.Element {
  let offset = 0;
  const sum = total(dorms, 'residents');
  return (
    <div className={s.ringWrap}>
      <svg
        viewBox="0 0 160 160"
        className={s.ring}
        role="img"
        aria-label={
          empty
            ? 'Нет данных о проживающих'
            : dorms.map((d) => `${d.name}: ${count(d.residents)} человек`).join('; ')
        }
      >
        <circle cx="80" cy="80" r="62" stroke="#edece5" strokeWidth="17" fill="none" />
        {!empty &&
          dorms.map((d) => {
            const size = (d.residents / Math.max(1, sum)) * 100;
            const start = offset;
            offset += size;
            return (
              <circle
                key={d.id}
                cx="80"
                cy="80"
                r="62"
                fill="none"
                stroke={d.color}
                strokeWidth="17"
                pathLength="100"
                strokeDasharray={`${Math.max(0, size - 1.3)} ${100 - Math.max(0, size - 1.3)}`}
                strokeDashoffset={-start}
                transform="rotate(-90 80 80)"
              />
            );
          })}
        <text x="80" y="79" textAnchor="middle" className={s.ringValue}>
          {empty ? '—' : count(sum)}
        </text>
        <text x="80" y="98" textAnchor="middle" className={s.ringLabel}>
          проживают
        </text>
      </svg>
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`${s.panel} ${className}`}>
      <div className={s.panelHead}>
        <div>
          <h4>{title}</h4>
          {hint && <p>{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Summary({
  dorms,
  period,
  empty,
  illustrated = false,
}: Props & { illustrated?: boolean }): JSX.Element {
  return (
    <div className={s.summary}>
      {metrics.map((m) => (
        <article key={m.key} className={s.metric} data-metric={m.key}>
          <div>
            <span className={s.metricLabel}>{m.title}</span>
            <strong>
              {empty ? '—' : count(total(dorms, m.key))}
              <small>чел.</small>
            </strong>
            <span className={s.metricHint}>На {snapshot(period).replace(' 2026', '')}</span>
          </div>
          {illustrated && m.key === 'residents' ? (
            <People />
          ) : (
            <div className={s.metricVisual}>
              <WorkspaceIcon name={m.icon} />
              {!empty && (
                <Line
                  values={series(dorms, m.key, period)}
                  color={m.color}
                  label={`Динамика: ${m.title.toLowerCase()}`}
                />
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function Trend({ dorms, period, empty, large = false }: Props & { large?: boolean }): JSX.Element {
  const [metric, setMetric] = useState<Metric>('residents');
  const selected = metrics.find((m) => m.key === metric)!;
  return (
    <Panel
      title="Динамика показателей"
      hint={`${periodLabel(period)} 2026`}
      className={large ? s.largeTrend : ''}
    >
      <div className={s.chartToolbar}>
        <div className={s.chartTabs} aria-label="Показатель графика">
          {metrics.map((m) => (
            <button
              key={m.key}
              type="button"
              aria-pressed={metric === m.key}
              onClick={() => setMetric(m.key)}
              style={{ '--tone': m.color } as CSSProperties}
            >
              <i />
              {m.title}
            </button>
          ))}
        </div>
        <span>человек</span>
      </div>
      {empty ? (
        <Empty />
      ) : (
        <>
          <div className={s.trendPlot}>
            <div className={s.axisY}>
              <span>{count(Math.ceil(total(dorms, metric) * 1.15))}</span>
              <span>{count(Math.round(total(dorms, metric) / 2))}</span>
              <span>0</span>
            </div>
            <Line
              values={series(dorms, metric, period)}
              color={selected.color}
              area
              label={`${selected.title}, ${periodLabel(period)}. По дням: ${series(dorms, metric, period).join(', ')} человек.`}
            />
          </div>
          <div className={s.axisX}>
            {(period === 'recent'
              ? ['20 окт.', '23 окт.', '26 окт.', '29 окт.', '2 нояб.']
              : ['1 окт.', '8 окт.', '16 окт.', '23 окт.', '31 окт.']
            ).map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function Breakdown({
  dorms,
  empty,
  onOpen,
  metric = 'residents',
  title = 'По общежитиям',
}: Props & { metric?: Metric; title?: string }): JSX.Element {
  return (
    <Panel title={title} hint="На дату среза, человек">
      <div className={s.breakdown}>
        {dorms.map((dorm) => (
          <button
            key={dorm.id}
            type="button"
            className={s.breakRow}
            style={tone(dorm)}
            onClick={() => onOpen(dorm)}
            aria-label={`${dorm.name}: ${empty ? 'нет данных' : count(dorm[metric])}, открыть подробности`}
          >
            <span className={s.rowIcon}>
              <WorkspaceIcon name="house" />
            </span>
            <span className={s.rowBody}>
              <span>
                <b>{dorm.name}</b>
                <strong>{empty ? '—' : count(dorm[metric])}</strong>
              </span>
              <span className={s.track}>
                <span
                  style={{
                    width: empty
                      ? '0%'
                      : `${(dorm[metric] / Math.max(...dorms.map((d) => d[metric]), 1)) * 100}%`,
                  }}
                />
              </span>
            </span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function Reports({ dorms }: Pick<Props, 'dorms'>): JSX.Element {
  const ready = dorms.filter((d) => d.ready).length;
  return (
    <Panel title="Отчёты сегодня" hint="2 ноября 2026">
      <div className={s.reportProgress}>
        <span>
          <strong>{ready}</strong> из {dorms.length} готовы
        </span>
        <div className={s.reportSegments}>
          {dorms.map((d) => (
            <i key={d.id} data-ready={d.ready} />
          ))}
        </div>
      </div>
      <ul className={s.reports}>
        {dorms.map((d) => (
          <li key={d.id}>
            <span>{d.name}</span>
            <span className={s.reportStatus} data-ready={d.ready}>
              {d.ready ? '✓ Готов' : '◷ Ожидается'}
            </span>
          </li>
        ))}
      </ul>
      <p className={s.footnote}>Готовность отмечается в общежитии. Пример статусов.</p>
    </Panel>
  );
}

function Clients({ dorms, empty }: Pick<Props, 'dorms' | 'empty'>): JSX.Element {
  const names = [...new Set(dorms.map((d) => d.client))];
  return (
    <Panel title="Выход по клиентам" hint="На дату среза, человек">
      <div className={s.clients}>
        {names.map((name, i) => {
          const value = total(
            dorms.filter((d) => d.client === name),
            'attendance',
          );
          return (
            <div key={name}>
              <span className={s.clientAvatar}>{name.slice(0, 1)}</span>
              <div>
                <strong>{name}</strong>
                <span className={s.track}>
                  <span
                    style={{
                      width: empty
                        ? '0%'
                        : `${(value / Math.max(1, total(dorms, 'attendance'))) * 100}%`,
                      background: i === 0 ? '#427caf' : '#7a65ab',
                    }}
                  />
                </span>
              </div>
              <b>{empty ? '—' : count(value)}</b>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Village(props: Props): JSX.Element {
  return (
    <>
      <div className={s.villageHero}>
        <div>
          <span className={s.smallLabel}>Все дома под присмотром</span>
          <h3>
            Большая картина.
            <br />С заботой о каждом.
          </h3>
          <p>
            {props.empty
              ? 'Соберите первый обзор ваших общежитий.'
              : `${count(total(props.dorms, 'residents'))} человек проживают в ${props.dorms.length === 1 ? 'вашем общежитии' : `${props.dorms.length} общежитиях`}. Все важные показатели рядом.`}
          </p>
        </div>
        <div className={s.villageArt} aria-hidden="true">
          <House color="#427caf" small />
          <House />
          <House color="#9b6544" small />
          <span className={s.villageGround} />
        </div>
      </div>
      <Summary {...props} illustrated />
      <div className={s.twoColumn}>
        <Trend {...props} />
        <Breakdown {...props} />
      </div>
      <div className={s.twoColumn}>
        <Clients {...props} />
        <Reports dorms={props.dorms} />
      </div>
    </>
  );
}

function Analytics(props: Props): JSX.Element {
  return (
    <>
      <Summary {...props} />
      <div className={s.analyticsGrid}>
        <Panel title="Кто где живёт" hint="Распределение проживающих">
          <Ring {...props} />
          <div className={s.legend}>
            {props.dorms.map((d) => (
              <span key={d.id}>
                <i style={{ background: d.color }} />
                {d.name}
                <b>
                  {props.empty
                    ? '—'
                    : `${Math.round((d.residents / total(props.dorms, 'residents')) * 100)}%`}
                </b>
              </span>
            ))}
          </div>
        </Panel>
        <Trend {...props} large />
      </div>
      <div className={s.threeColumn}>
        <Breakdown {...props} metric="attendance" title="Выход на работу" />
        <Breakdown {...props} metric="turnover" title="Текучка по общежитиям" />
        <Reports dorms={props.dorms} />
      </div>
      <Clients {...props} />
    </>
  );
}

function Command(props: Props): JSX.Element {
  return (
    <>
      <div className={s.commandHero}>
        <div className={s.commandIntro}>
          <span>Сводка на {snapshot(props.period)}</span>
          <h3>
            Общежития
            <br />в одном ритме
          </h3>
          <div className={s.commandCount}>
            <strong>{props.empty ? '—' : count(total(props.dorms, 'residents'))}</strong>
            <span>
              человек
              <br />
              проживают сейчас
            </span>
          </div>
          <People />
        </div>
        <div className={s.commandCells}>
          {metrics.slice(1).map((m) => (
            <div key={m.key}>
              <WorkspaceIcon name={m.icon} />
              <span>{m.title}</span>
              <strong>
                {props.empty ? '—' : count(total(props.dorms, m.key))}
                <small> чел.</small>
              </strong>
              {!props.empty && (
                <Line
                  values={series(props.dorms, m.key, props.period)}
                  color={m.key === 'attendance' ? '#a7d8ee' : '#f5c99f'}
                  label={`Динамика: ${m.title}`}
                />
              )}
            </div>
          ))}
          <div>
            <WorkspaceIcon name="document" />
            <span>Отчёты сегодня</span>
            <strong>
              {props.dorms.filter((d) => d.ready).length}
              <small> / {props.dorms.length}</small>
            </strong>
            <span className={s.commandReport}>общежитий отметили готовность</span>
          </div>
        </div>
      </div>
      <Trend {...props} />
      <div className={s.threeColumn}>
        <Breakdown {...props} />
        <Clients {...props} />
        <Reports dorms={props.dorms} />
      </div>
    </>
  );
}

function Daily(props: Props): JSX.Element {
  const chapters = [
    {
      label: 'Проживание',
      icon: 'house' as const,
      title: 'У каждого есть свой дом',
      node: (
        <>
          <div className={s.storySummary}>
            <strong>{props.empty ? '—' : count(total(props.dorms, 'residents'))}</strong>
            <span>
              человек проживают
              <br />
              на дату среза
            </span>
            <People />
          </div>
          <div className={s.twoColumn}>
            <Breakdown {...props} />
            <Trend {...props} />
          </div>
        </>
      ),
    },
    {
      label: 'Рабочий день',
      icon: 'chart' as const,
      title: 'Команда вышла на работу',
      node: (
        <>
          <div className={s.storySummary}>
            <strong>{props.empty ? '—' : count(total(props.dorms, 'attendance'))}</strong>
            <span>
              человек на работе
              <br />
              на дату среза
            </span>
            <span className={s.storyTurnover}>
              Текучка <b>{props.empty ? '—' : count(total(props.dorms, 'turnover'))}</b> чел.
            </span>
          </div>
          <Clients {...props} />
        </>
      ),
    },
    {
      label: 'Отчётность',
      icon: 'document' as const,
      title: 'Осталось собрать картину дня',
      node: <Reports dorms={props.dorms} />,
    },
  ];
  return (
    <div className={s.story}>
      {chapters.map((chapter) => (
        <section key={chapter.label} className={s.chapter}>
          <div className={s.chapterMarker}>
            <WorkspaceIcon name={chapter.icon} />
          </div>
          <div className={s.chapterContent}>
            <span className={s.smallLabel}>{chapter.label}</span>
            <h3>{chapter.title}</h3>
            {chapter.node}
          </div>
        </section>
      ))}
    </div>
  );
}

function Atlas(props: Props): JSX.Element {
  return (
    <>
      <div className={s.atlasIntro}>
        <div>
          <h3>У каждого дома своя история</h3>
          <p>Численность, выход и текучка — рядом с общежитием.</p>
        </div>
        <span>
          <WorkspaceIcon name="building" />
          {props.dorms.length} {props.dorms.length === 1 ? 'общежитие' : 'общежития'}
        </span>
      </div>
      <Summary {...props} />
      <div className={s.atlasGrid}>
        {props.dorms.map((d) => (
          <article className={s.atlasCard} key={d.id} style={tone(d)}>
            <div className={s.atlasRoof}>
              <span>{d.client}</span>
              <span className={s.reportStatus} data-ready={d.ready}>
                {d.ready ? '✓ Отчёт готов' : '◷ Ждём отчёт'}
              </span>
              <House color={d.color} />
              <h4>{d.name}</h4>
            </div>
            <div className={s.atlasBody}>
              <div className={s.atlasMetrics}>
                {metrics.map((m) => (
                  <div key={m.key}>
                    <span>{m.title}</span>
                    <strong>{props.empty ? '—' : count(d[m.key])}</strong>
                  </div>
                ))}
              </div>
              <div className={s.atlasChart}>
                <span>Проживающие за период</span>
                {props.empty ? (
                  <span>Нет данных</span>
                ) : (
                  <Line
                    values={series([d], 'residents', props.period)}
                    color={d.color}
                    label={`${d.name}: динамика проживающих`}
                  />
                )}
              </div>
              <button type="button" onClick={() => props.onOpen(d)}>
                Подробнее об общежитии <WorkspaceIcon name="chevron" />
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className={s.twoColumn}>
        <Trend {...props} />
        <Clients {...props} />
      </div>
    </>
  );
}

const variants = [Village, Analytics, Command, Daily, Atlas];
const nav: { name: string; icon: WorkspaceIconName }[] = [
  { name: 'Обзор', icon: 'overview' },
  { name: 'Общежития', icon: 'house' },
  { name: 'Персонал', icon: 'people' },
  { name: 'Статистика', icon: 'chart' },
  { name: 'Документы', icon: 'document' },
];

function readFavorite(): number | null {
  try {
    const value = Number(localStorage.getItem('domovoy-overview-favorite'));
    return value >= 1 && value <= 5 ? value : null;
  } catch {
    return null;
  }
}

export function OverviewDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const raw = params.get('variant');
  const all = raw === 'all';
  const active = Number.isInteger(Number(raw)) ? Math.min(5, Math.max(1, Number(raw) || 1)) : 1;
  const [period, setPeriod] = useState<Period>('recent');
  const [scope, setScope] = useState('all');
  const [empty, setEmpty] = useState(false);
  const [detail, setDetail] = useState<Dorm | null>(null);
  const [favorite, setFavorite] = useState(readFavorite);
  const [notice, setNotice] = useState('');
  const dorms = getDorms(period, scope);
  const props: Props = { dorms, period, empty, onOpen: setDetail };
  const select = (value: string): void => {
    const next = new URLSearchParams(params);
    next.set('variant', value);
    setParams(next, { replace: true });
  };
  const mark = (value: number): void => {
    const next = favorite === value ? null : value;
    setFavorite(next);
    try {
      if (next) localStorage.setItem('domovoy-overview-favorite', String(next));
      else localStorage.removeItem('domovoy-overview-favorite');
    } catch {
      /* Выбор остаётся доступен на время просмотра. */
    }
    setNotice(next ? `Отмечен вариант ${next}: ${directions[next - 1].name}` : 'Отметка снята');
  };

  return (
    <div className={s.lab}>
      <header className={s.labHeader}>
        <div>
          <Link to="/" className={s.labBrand}>
            <WorkspaceIcon name="house" />
            Домовой
          </Link>
          <span className={s.labTag}>Примерочная дизайна</span>
        </div>
        <Link to="/cabinet">
          Открыть кабинет <WorkspaceIcon name="chevron" />
        </Link>
      </header>
      <main className={s.labMain}>
        <div className={s.labIntro}>
          <div>
            <h1>Пять взглядов на «Обзор»</h1>
            <p>Одинаковые данные. Разный характер. Найдите свой способ видеть главное.</p>
          </div>
          <span className={s.demoBadge}>
            <i />
            Демонстрационные данные
          </span>
        </div>
        <nav className={s.directionPicker} aria-label="Варианты дизайна обзора">
          {directions.map((d, i) => (
            <button
              type="button"
              key={d.name}
              aria-pressed={!all && active === i + 1}
              onClick={() => select(String(i + 1))}
            >
              <span className={s.directionNumber}>{i + 1}</span>
              <span>
                <strong>{d.name}</strong>
                <small>{d.short}</small>
              </span>
              {favorite === i + 1 && <span aria-label="Отмеченный вариант">★</span>}
            </button>
          ))}
        </nav>
        <div className={s.compareBar}>
          <button type="button" aria-pressed={all} onClick={() => select(all ? '1' : 'all')}>
            <WorkspaceIcon name="overview" />
            {all ? 'Показывать по одному' : 'Все пять на одной странице'}
          </button>
          <label>
            <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} />
            Посмотреть без данных
          </label>
          {favorite !== null && (
            <span className={s.favoriteNote} role="status">
              Ваш выбор: {directions[favorite - 1].name}
            </span>
          )}
        </div>
        <div className={s.frame}>
          <aside className={s.sidebar}>
            <div className={s.sidebarBrand}>
              <span>
                <WorkspaceIcon name="house" />
              </span>
              <strong>Домовой</strong>
            </div>
            <p>
              Учёт проживания
              <br />и работы персонала
            </p>
            <nav aria-label="Разделы макета">
              {nav.map((n) => (
                <span key={n.name} aria-current={n.name === 'Обзор' ? 'page' : undefined}>
                  <WorkspaceIcon name={n.icon} />
                  {n.name}
                </span>
              ))}
            </nav>
            <div className={s.sidebarBottom}>
              <People />
              <strong>Всё начинается с людей</strong>
              <span>Каждый дом — часть общей картины</span>
            </div>
          </aside>
          <div className={s.workspace}>
            <div className={s.breadcrumb}>
              <span>
                Рабочее пространство <WorkspaceIcon name="chevron" />
                <strong>Обзор</strong>
              </span>
              <span className={s.previewBadge}>Тестовая страница</span>
            </div>
            <div className={s.content}>
              <div className={s.pageHeading}>
                <div>
                  <h2>Обзор</h2>
                  <p>Проживание и работа по всем общежитиям</p>
                </div>
                <span>
                  <WorkspaceIcon name="house" />
                  {scope === 'all' ? 'Все общежития' : scopes.find((d) => d.id === scope)?.name}
                </span>
              </div>
              <div className={s.tariff}>
                <WorkspaceIcon name="document" />
                <strong>Тариф «Стандарт»</strong>
                <span>Пример действующего тарифа организации</span>
                <span className={s.tariffStatus}>Активен</span>
              </div>
              <div className={s.filters}>
                <label>
                  Период
                  <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                    <option value="recent">Последние 14 дней</option>
                    <option value="october">Октябрь 2026</option>
                  </select>
                </label>
                <label>
                  Общежитие
                  <select value={scope} onChange={(e) => setScope(e.target.value)}>
                    <option value="all">Все общежития</option>
                    {scopes.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span>
                  Срез на {snapshot(period)}
                  <small>Показатели за день, без суммирования за период</small>
                </span>
              </div>
              <div className={s.variants}>
                {(all ? [1, 2, 3, 4, 5] : [active]).map((value) => {
                  const Variant = variants[value - 1];
                  const direction = directions[value - 1];
                  return (
                    <section
                      key={value}
                      className={s.variant}
                      data-variant={value}
                      aria-labelledby={`direction-${value}`}
                    >
                      <div className={s.variantIntro}>
                        <div>
                          <span className={s.variantNumber}>{value} / 5</span>
                          <h3 id={`direction-${value}`}>{direction.name}</h3>
                          <p>{direction.note}</p>
                        </div>
                        <button
                          type="button"
                          className={s.favoriteButton}
                          aria-pressed={favorite === value}
                          onClick={() => mark(value)}
                        >
                          {favorite === value ? '★ Вариант отмечен' : '☆ Мне нравится'}
                        </button>
                      </div>
                      <div className={s.variantCanvas}>
                        <Variant {...props} />
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <footer className={s.labFooter}>
          <span>Макеты для выбора оформления. Все цифры и статусы — примеры.</span>
          <Link to="/preview/personnel-workspace">Посмотреть варианты «Персонала»</Link>
        </footer>
        <p className={s.srOnly} role="status">
          {notice}
        </p>
      </main>
      {detail && (
        <Modal
          testId="overview-preview-detail"
          title={`Общежитие «${detail.name}»`}
          onClose={() => setDetail(null)}
        >
          <div className={s.detail}>
            <House color={detail.color} />
            <p>{detail.client} · Демонстрационные данные</p>
            <dl>
              {metrics.map((m) => (
                <div key={m.key}>
                  <dt>{m.title}</dt>
                  <dd>{empty ? '—' : `${count(detail[m.key])} чел.`}</dd>
                </div>
              ))}
            </dl>
            <p>Срез на {snapshot(period)}</p>
            {!empty && (
              <Line
                values={series([detail], 'residents', period)}
                color={detail.color}
                area
                label={`Динамика проживающих: ${detail.name}`}
              />
            )}
            <button className="btn btn--primary" type="button" onClick={() => setDetail(null)}>
              Вернуться к обзору
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
