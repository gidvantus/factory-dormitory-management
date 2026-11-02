import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  aggregate,
  applyPreset,
  builders,
  chartData,
  demoDays,
  employeeMatches,
  formulaData,
  summary,
  validate,
  variants,
  visibleFields,
} from './model';
import type { Builder, BuilderId, Draft, Field, Item, VariantId } from './model';
import s from './ConstructorLab.module.css';

type Zone = 'name' | 'content' | 'view';
const number = (value: number): string =>
  Number.isFinite(value)
    ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)
    : 'Ошибка';

function Glyph({ name }: { name: string }): JSX.Element {
  const paths: Record<string, ReactNode> = {
    house: (
      <>
        <path d="m3 10 9-7 9 7M5 9v12h14V9M10 21v-7h4v7" />
        <path d="M9 9h.01M15 9h.01" />
      </>
    ),
    steps: (
      <>
        <rect x="3" y="4" width="5" height="5" rx="1" />
        <rect x="10" y="10" width="5" height="5" rx="1" />
        <rect x="17" y="16" width="4" height="5" rx="1" />
        <path d="M10 6h9v7M5 12v7h9" />
      </>
    ),
    split: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M11 4v16M6 8h2M6 12h2M14 16l2-5 3 2" />
      </>
    ),
    templates: (
      <>
        <rect x="3" y="4" width="8" height="7" rx="1" />
        <rect x="14" y="4" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="8" height="6" rx="1" />
        <path d="m15 17 2 2 4-5" />
      </>
    ),
    sentence: (
      <>
        <path d="M3 6h18M3 12h5M15 12h6M3 18h13" />
        <rect x="9" y="9" width="5" height="6" rx="1" />
      </>
    ),
    canvas: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 8h7M7 12h4m3 1 6 3-3 1-1 3z" />
      </>
    ),
    structure: (
      <>
        <rect x="8" y="3" width="8" height="5" rx="1" />
        <path d="M12 8v5M5 16v-3h14v3" />
        <rect x="2" y="16" width="6" height="5" rx="1" />
        <rect x="16" y="16" width="6" height="5" rx="1" />
      </>
    ),
    table: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18M3 15h18M10 4v16" />
      </>
    ),
    columns: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M15 4v16M3 9h18" />
      </>
    ),
    formula: (
      <>
        <path d="M16 4h-3l-3 16H7M6 10h11M17 15l5 5m0-5-5 5" />
      </>
    ),
    link: (
      <>
        <path
          d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 4 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
          transform="translate(2 0)"
        />
      </>
    ),
    places: (
      <>
        <path d="M3 6v15M21 12v9M3 16h18M3 10h6v6M9 12h10a2 2 0 0 1 2 2" />
      </>
    ),
    personnel: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15h5m-5 5h5m-3 5h3" />
      </>
    ),
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="8" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="3" y="15" width="7" height="6" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
      </>
    ),
    statistics: (
      <>
        <path d="M3 3v18h18M7 16v-4m5 4V6m5 10V9" />
      </>
    ),
    arrivals: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4m10-4v4M3 10h18m-11 6 2 2 4-4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    undo: (
      <>
        <path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12h-3" />
      </>
    ),
    edit: (
      <>
        <path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14z" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.table}
    </svg>
  );
}

export function Control({
  field,
  draft,
  onChange,
  compact = false,
}: {
  field: Field;
  draft: Draft;
  onChange: (key: string, value: string | boolean) => void;
  compact?: boolean;
}): JSX.Element {
  const id = useId();
  const hint = field.hint ? `${id}-hint` : undefined;
  return (
    <div className={`${s.field} ${compact ? s.compactField : ''}`}>
      {field.type === 'toggle' ? (
        <label className={s.toggle} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(draft.values[field.key])}
            onChange={(event) => onChange(field.key, event.target.checked)}
            aria-describedby={hint}
          />
          <span>{field.label}</span>
        </label>
      ) : (
        <>
          <label htmlFor={id}>{field.label}</label>
          {field.type === 'text' ? (
            <input
              id={id}
              value={String(draft.values[field.key] ?? '')}
              maxLength={120}
              onChange={(event) => onChange(field.key, event.target.value)}
              aria-describedby={hint}
            />
          ) : (
            <select
              id={id}
              value={String(draft.values[field.key])}
              onChange={(event) => onChange(field.key, event.target.value)}
              aria-describedby={hint}
            >
              {field.options?.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          )}
        </>
      )}
      {field.hint && <small id={hint}>{field.hint}</small>}
    </div>
  );
}

export function ItemEditor({
  builder,
  draft,
  onChange,
}: {
  builder: Builder;
  draft: Draft;
  onChange: (draft: Draft) => void;
}): JSX.Element {
  const calendar = builder.id === 'table' && draft.values.format === 'Дни в столбцах';
  function update(id: string, patch: Partial<Item>): void {
    onChange({
      ...draft,
      items: draft.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  }
  function move(index: number, offset: number): void {
    const next = [...draft.items];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange({ ...draft, items: next });
  }
  return (
    <section className={s.collection} aria-label={builder.collection}>
      <div className={s.collectionHeading}>
        <h3>{builder.collection}</h3>
        <span>{draft.items.filter((item) => item.enabled).length} видно</span>
      </div>
      <div className={s.items}>
        {draft.items.map((item, index) => (
          <div key={item.id} className={s.item} data-hidden={!item.enabled}>
            <input
              type="checkbox"
              checked={item.enabled}
              aria-label={`Показывать «${item.name || 'Новый элемент'}»`}
              onChange={(event) => update(item.id, { enabled: event.target.checked })}
            />
            <div className={s.itemFields}>
              <input
                value={item.name}
                aria-label={`Название элемента ${index + 1}`}
                maxLength={120}
                onChange={(event) => update(item.id, { name: event.target.value })}
              />
              {builder.id !== 'structure' && !calendar && (
                <select
                  aria-label={`Тип элемента ${index + 1}`}
                  value={item.kind}
                  onChange={(event) => update(item.id, { kind: event.target.value })}
                >
                  {['Текст', 'Число', 'Дата', 'Чекбокс', 'Список'].map((kind) => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
              )}
            </div>
            <div className={s.move}>
              <button
                type="button"
                className="btn btn--quiet"
                aria-label={`Поднять «${item.name}»`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                aria-label={`Опустить «${item.name}»`}
                disabled={index === draft.items.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={s.addButton}
        onClick={() =>
          onChange({
            ...draft,
            items: [
              ...draft.items,
              {
                id: `new-${Date.now()}-${draft.items.length}`,
                name:
                  builder.id === 'structure'
                    ? 'Новая вкладка'
                    : calendar
                      ? 'Новый показатель'
                      : 'Новый столбец',
                kind: calendar ? 'Число' : 'Текст',
                enabled: true,
              },
            ],
          })
        }
      >
        +{' '}
        {builder.id === 'structure'
          ? 'Добавить вкладку'
          : calendar
            ? 'Добавить показатель'
            : 'Добавить столбец'}
      </button>
      <p className={s.muted}>Стрелки меняют порядок. Снимите отметку, чтобы скрыть элемент.</p>
      {builder.id !== 'structure' && !calendar && (
        <p className={s.muted}>
          Пример создания структуры. В рабочей таблице тип уже созданного столбца фиксирован.
        </p>
      )}
    </section>
  );
}

function SampleCell({
  kind,
  name,
  index,
}: {
  kind: string;
  name: string;
  index: number;
}): JSX.Element {
  const content =
    kind === 'Чекбокс' ? (
      <span className={s.sampleCheck} aria-label="Отмечено">
        ✓
      </span>
    ) : kind === 'Дата' ? (
      `${29 + index}.10.2026`
    ) : kind === 'Число' ? (
      number(1200 + index * 300)
    ) : kind === 'Список' ? (
      <span className={s.pill}>Выдано</span>
    ) : /фио|имя/i.test(name) ? (
      ['Иванов Алексей', 'Петрова Анна', 'Соколов Игорь'][index]
    ) : /телефон/i.test(name) ? (
      '+7 (900) 000-00-00'
    ) : /комплект/i.test(name) ? (
      'Зимний комплект'
    ) : /табельный/i.test(name) ? (
      `00${index + 1}`
    ) : (
      ['Пример значения', 'Ещё одна запись', 'Третья запись'][index]
    );
  return <td>{content}</td>;
}

function SampleTable({
  draft,
  calendar = false,
  showTypes = false,
}: {
  draft: Draft;
  calendar?: boolean;
  showTypes?: boolean;
}): JSX.Element {
  const active = draft.items.filter((item) => item.enabled);
  return (
    <div className={s.tableScroll}>
      <table className={s.sampleTable}>
        <thead>
          <tr>
            {calendar ? (
              <>
                <th scope="col">Показатель</th>
                {demoDays.slice(-3).map((day) => (
                  <th scope="col" key={day}>
                    {day}
                  </th>
                ))}
              </>
            ) : (
              active.map((item) => (
                <th scope="col" key={item.id}>
                  {item.name || 'Без названия'}
                  {showTypes && <small>{item.kind}</small>}
                </th>
              ))
            )}
          </tr>
        </thead>
        <tbody>
          {calendar
            ? active.map((item, index) => (
                <tr key={item.id}>
                  <th scope="row">{item.name}</th>
                  {[2, 4, 3].map((value, day) => (
                    <td key={day}>{value + index}</td>
                  ))}
                </tr>
              ))
            : [0, 1, 2].map((row) => (
                <tr key={row}>
                  {active.map((item) => (
                    <SampleCell key={item.id} kind={item.kind} name={item.name} index={row} />
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {!active.length && (
        <p className={s.empty}>Все элементы скрыты. Включите хотя бы один в настройках.</p>
      )}
    </div>
  );
}

function Chart({ draft }: { draft: Draft }): JSX.Element {
  const data = chartData(draft);
  const max = Math.max(1, ...data.map((row) => row.value));
  const display = String(draft.values.display);
  const total = data.reduce((sum, row) => sum + row.value, 0);
  const dateGroup = draft.values.group === 'Дни' || display === 'График';
  const value = dateGroup
    ? aggregate(
        data.map((row) => row.value),
        String(draft.values.aggregate ?? draft.values.period),
      )
    : total;
  if (display === 'Число')
    return (
      <div className={s.metric}>
        <strong>{number(value)}</strong>
        <span>{draft.values.source === 'Свободные места' ? 'свободных мест' : 'человек'}</span>
        <small>{String(draft.values.aggregate ?? draft.values.period)}</small>
      </div>
    );
  if (display === 'Таблица' || display === 'Список')
    return (
      <div className={s.tableScroll}>
        <table className={s.sampleTable}>
          <thead>
            <tr>
              <th>{dateGroup ? 'Дата' : 'Общежитие'}</th>
              <th>{String(draft.values.source)}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{number(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (display === 'Круговая') {
    let angle = 0;
    const colors = ['#3d806b', '#89afcd', '#d8b95f'];
    const gradient = data
      .map((row, index) => {
        const start = angle;
        angle += total ? (row.value / total) * 360 : 0;
        return `${colors[index % colors.length]} ${start}deg ${angle}deg`;
      })
      .join(',');
    return (
      <div className={s.pieLayout}>
        <div
          className={s.pie}
          style={{ background: total ? `conic-gradient(${gradient})` : '#e5e8e5' }}
          role="img"
          aria-label={data.map((row) => `${row.label}: ${number(row.value)}`).join(', ')}
        >
          <span>
            {number(total)}
            <small>всего</small>
          </span>
        </div>
        <ul className={s.legend}>
          {data.map((row, index) => (
            <li key={row.label}>
              <i style={{ background: colors[index % colors.length] }} />
              <span>{row.label}</span>
              <strong>{number(row.value)}</strong>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (display === 'Линия' || display === 'График' || display === 'Области') {
    const points = data
      .map(
        (row, index) =>
          `${30 + (index * 400) / Math.max(1, data.length - 1)},${160 - (row.value / max) * 125}`,
      )
      .join(' ');
    return (
      <div className={s.lineChart}>
        <svg
          viewBox="0 0 460 200"
          role="img"
          aria-label={data.map((row) => `${row.label}: ${number(row.value)}`).join(', ')}
        >
          <path d="M25 40h410M25 100h410M25 160h410" stroke="#e5e8e5" fill="none" />
          {display === 'Области' && <polygon points={`30,160 ${points} 430,160`} fill="#dceee4" />}
          <polyline points={points} fill="none" stroke="#2f7d62" strokeWidth="3" />
          {data.map((row, index) => (
            <g key={row.label}>
              <circle
                cx={30 + (index * 400) / Math.max(1, data.length - 1)}
                cy={160 - (row.value / max) * 125}
                r="4"
                fill="#2f7d62"
              />
              <text
                x={30 + (index * 400) / Math.max(1, data.length - 1)}
                y={145 - (row.value / max) * 125}
                textAnchor="middle"
              >
                {number(row.value)}
              </text>
              <text
                x={30 + (index * 400) / Math.max(1, data.length - 1)}
                y="190"
                textAnchor="middle"
              >
                {row.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    );
  }
  return (
    <div
      className={s.barChart}
      role="img"
      aria-label={data.map((row) => `${row.label}: ${number(row.value)}`).join(', ')}
    >
      {data.map((row, index) => (
        <div className={s.barColumn} key={row.label}>
          <strong>{number(row.value)}</strong>
          <div className={s.barTrack}>
            <i data-color={index % 3} style={{ height: `${(row.value / max) * 100}%` }} />
          </div>
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

const linkedRows = [
  { name: 'Иванов Алексей', status: 'Оформлен', date: '31 окт.' },
  { name: 'Петрова Анна', status: 'Ожидает', date: '31 окт.' },
  { name: 'Соколов Игорь', status: 'Оформлен', date: '' },
];

function ArrivalSample({ draft }: { draft: Draft }): JSX.Element {
  const v = draft.values;
  const label = String(v.name || 'Новое поле');
  const sample = (index = 0): ReactNode =>
    v.type === 'Чекбокс'
      ? '☑ Да'
      : v.type === 'Дата'
        ? '01.11.2026'
        : v.type === 'Число'
          ? String(20 + index * 5)
          : v.type === 'Список'
            ? 'Первый вариант'
            : label.includes('Телефон')
              ? '+7 (900) 000-00-00'
              : 'Пример значения';
  return (
    <div className={s.arrivalLayout}>
      <section className={s.arrivalForm}>
        <h4>Форма заезда</h4>
        <div className={s.samplePair}>
          <span>
            Общежитие<strong>Северный</strong>
          </span>
          <span>
            Дата заезда<strong>1 ноября 2026</strong>
          </span>
        </div>
        <p className={s.sampleLabel}>Приезжают 2 человека</p>
        {['Иванов Алексей', 'Петрова Анна'].map((name, index) => (
          <div className={s.personRow} key={name}>
            <span>{name}</span>
            {v.scope === 'Отдельно для каждого человека' && (
              <div>
                <small>
                  {label}
                  {v.required ? ' *' : ''}
                </small>
                <span className={s.sampleInput}>{sample(index)}</span>
              </div>
            )}
          </div>
        ))}
        {v.scope === 'Одно на весь заезд' && (
          <div className={s.arrivalShared}>
            <small>
              {label}
              {v.required ? ' *' : ''}
            </small>
            <span className={s.sampleInput}>{sample()}</span>
          </div>
        )}
      </section>
      <section className={s.arrivalCard}>
        <h4>Карточка заезда</h4>
        <strong>Северный</strong>
        <span>1 ноября · 2 человека</span>
        {v.card ? (
          <div>
            <small>{label}</small>
            <p>
              {v.scope === 'Отдельно для каждого человека'
                ? `Иванов: ${sample(0)} · Петрова: ${sample(1)}`
                : sample()}
            </p>
          </div>
        ) : (
          <p className={s.muted}>Дополнительное поле скрыто в карточке.</p>
        )}
        {v.empty && (
          <div>
            <small>Комментарий</small>
            <p>Не заполнено</p>
          </div>
        )}
      </section>
    </div>
  );
}

export function Output({ builder, draft }: { builder: Builder; draft: Draft }): JSX.Element {
  const v = draft.values;
  switch (builder.id) {
    case 'workspace': {
      const people = employeeMatches(draft, true);
      const plans = [
        { dorm: 'Северный', days: 1, count: 3 },
        { dorm: 'Заводской', days: 3, count: 2 },
        { dorm: 'Речной', days: 9, count: 4 },
      ].filter(
        (plan) =>
          plan.days <= Number(v.days) &&
          (v.scope !== 'Только Северный' || plan.dorm === 'Северный'),
      );
      const rows =
        v.kind === 'План заездов'
          ? plans.map((plan) => ({
              name: plan.dorm,
              detail: `${plan.days} ноября`,
              value: `${plan.count} чел.`,
            }))
          : v.kind === 'Проживающие'
            ? ['Северный', 'Заводской', 'Речной']
                .filter((dorm) => people.some((person) => person.dorm === dorm))
                .map((dorm) => ({
                  name: dorm,
                  detail: 'Проживают сейчас',
                  value: `${people.filter((person) => person.dorm === dorm).length} чел.`,
                }))
            : people.map((person) => ({
                name: person.name,
                detail: person.dorm,
                value:
                  v.kind === 'Контакты' ? person.phone || 'Не указан' : `Через ${person.days} дн.`,
              }));
      return (
        <>
          <p className={s.resultNote}>Так блок займёт место на вашей рабочей поверхности.</p>
          <div className={s.workspaceSample} data-wide={Boolean(v.wide)}>
            <div className={s.personnelCard}>
              <div className={s.personnelCardHeading}>
                <strong>{String(v.name)}</strong>
                <span>{rows.length}</span>
              </div>
              {rows.slice(0, Number(v.limit)).map((row) => (
                <div className={s.personnelSampleRow} key={row.name}>
                  <div>
                    <strong>{row.name}</strong>
                    <small>{row.detail}</small>
                  </div>
                  <span>{row.value}</span>
                </div>
              ))}
              {!rows.length && (
                <p className={s.empty}>
                  По этим условиям записей нет. Измените общежитие или период.
                </p>
              )}
              <small className={s.muted}>
                Показано {Math.min(rows.length, Number(v.limit))} из {rows.length}
              </small>
            </div>
            {!v.wide && (
              <div className={s.neighborCard} aria-hidden="true">
                <span>Соседний блок</span>
                <i />
                <i />
                <i />
              </div>
            )}
          </div>
        </>
      );
    }
    case 'filters': {
      const people = employeeMatches(draft);
      return (
        <>
          <div className={s.flow}>
            <span>{String(v.status)}</span>
            <Glyph name="arrow" />
            <span>
              {String(v.column)}: {String(v.condition).toLocaleLowerCase('ru')}
            </span>
            <Glyph name="arrow" />
            <span>Найдено: {people.length}</span>
          </div>
          <div className={s.tableScroll}>
            <table className={s.sampleTable}>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Общежитие</th>
                  <th>Телефон</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.name}>
                    <th scope="row">{person.name}</th>
                    <td>{person.dorm}</td>
                    <td>{person.phone || 'Не заполнен'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!people.length && (
            <p className={s.empty}>
              Никто не подходит под все условия. Измените поле, значение или общежитие.
            </p>
          )}
          <p className={s.resultNote}>
            Сохраняются условия отбора. Состав списка обновляется вместе с данными сотрудников.
          </p>
          {v.pin && (
            <div className={s.pinnedList}>
              <Glyph name="personnel" />
              <span>
                На рабочей поверхности: <strong>{String(v.name)}</strong>
              </span>
            </div>
          )}
        </>
      );
    }
    case 'structure': {
      const active = draft.items.filter((item) => item.enabled);
      return (
        <div className={s.structurePreview}>
          <div className={s.tree}>
            <strong>
              <Glyph name="house" /> {String(v.name)}
            </strong>
            {active.map((item, index) => (
              <div key={item.id}>
                {v.layout === 'По рабочим задачам' && (index === 0 || item.name === 'На аванс') && (
                  <small>{index === 0 ? 'Проживание и движение' : 'Выплаты'}</small>
                )}
                <span className={index === 0 ? s.activeTree : ''}>
                  <Glyph name="table" />
                  {item.name}
                </span>
              </div>
            ))}
            {v.archived && (
              <span>
                <Glyph name="table" />
                Архив
              </span>
            )}
          </div>
          <div className={s.treeDetail}>
            <span className={s.pill}>Выбранный раздел</span>
            <h4>{active[0]?.name || 'Нет разделов'}</h4>
            <p>Записи и настройки этого раздела.</p>
            <div className={s.skeletonTable} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      );
    }
    case 'table':
      return (
        <>
          <div className={s.sampleToolbar}>
            <span>
              {String(v.period)}
              {v.period !== 'За всё время' ? ' · Октябрь 2026' : ''}
            </span>
            <div>
              {v.addRow && <span className={s.sampleAction}>+ Добавить строку</span>}
              {v.clear && <span className={s.sampleAction}>Очистить список</span>}
            </div>
          </div>
          <SampleTable draft={draft} calendar={v.format === 'Дни в столбцах'} />
          <p className={s.resultNote}>
            {v.format === 'Дни в столбцах'
              ? 'Значения по дням вводятся вручную.'
              : v.period === 'За всё время'
                ? 'Все записи без фильтра по датам.'
                : 'Период отбирает записи по столбцу типа «Дата».'}
          </p>
        </>
      );
    case 'columns':
      return <SampleTable draft={draft} showTypes={Boolean(v.types)} />;
    case 'formula': {
      const result = formulaData(draft);
      return (
        <>
          {v.mode === 'Формулой' && (
            <div className={s.formula}>
              <span>Формула</span>
              <code>{result.expression}</code>
            </div>
          )}
          <div className={s.tableScroll}>
            <table className={s.sampleTable}>
              <thead>
                <tr>
                  <th>Строка отчёта</th>
                  {demoDays.slice(-3).map((day) => (
                    <th key={day}>{day}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {v.mode === 'Формулой' &&
                  [
                    ['Проживает', 120, 122, 124],
                    ['Прибыло', 2, 4, 6],
                    ['Выбыло', 1, 2, 0],
                  ].map((row) => (
                    <tr key={String(row[0])}>
                      <th scope="row">{row[0]}</th>
                      {row.slice(1).map((value, index) => (
                        <td key={index}>{value}</td>
                      ))}
                    </tr>
                  ))}
                <tr className={s.totalRow}>
                  <th scope="row">{String(v.name || 'Новая строка')}</th>
                  {result.values.map((value, index) => (
                    <td key={index}>
                      {v.mode === 'Вручную по дням' ? (
                        <input
                          type="number"
                          aria-label={`Значение за ${demoDays[index + 4]}`}
                          placeholder="Введите"
                        />
                      ) : (
                        number(value)
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className={s.resultNote}>
            {v.mode === 'Формулой'
              ? result.values.some((value) => !Number.isFinite(value))
                ? 'Деление на ноль: выберите другую строку или другое действие.'
                : 'Видно, из каких значений получается итог для каждого дня.'
              : 'Попробуйте ввести значение в ячейку. Ручной ввод очищается при переключении варианта или конструктора.'}
          </p>
        </>
      );
    }
    case 'link': {
      const counted = linkedRows.filter(
        (row) =>
          (v.condition === 'Статус заполнен' || row.status === v.status) &&
          (v.date === 'Дате создания записи' || row.date),
      );
      return (
        <>
          <div className={s.flow}>
            <span>{String(v.source)}</span>
            <Glyph name="arrow" />
            <span>{v.condition === 'Статус заполнен' ? 'Есть статус' : String(v.status)}</span>
            <Glyph name="arrow" />
            <span>{String(v.date)}</span>
          </div>
          <div className={s.tableScroll}>
            <table className={s.sampleTable}>
              <thead>
                <tr>
                  <th>Запись из «{String(v.source)}»</th>
                  <th>Статус</th>
                  <th>В расчёте за 31 окт.</th>
                </tr>
              </thead>
              <tbody>
                {linkedRows.map((row) => {
                  const included = counted.includes(row);
                  return (
                    <tr key={row.name}>
                      <th scope="row">{row.name}</th>
                      <td>{row.status}</td>
                      <td>
                        <span className={included ? s.included : s.excluded}>
                          {included
                            ? '+1'
                            : !row.date && v.date === 'Дате события'
                              ? 'Нет даты события'
                              : 'Другой статус'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={s.inlineTotal}>
            <span>Итого за 31 октября</span>
            <strong>{counted.length}</strong>
          </div>
          <p className={s.resultNote}>В примере дата создания всех трёх записей — 31 октября.</p>
        </>
      );
    }
    case 'places': {
      const rows = [
        { name: 'Север', paidM: 70, paidF: 30, liveM: 61, liveF: 23 },
        { name: 'Восток', paidM: 42, paidF: 18, liveM: 37, liveF: 13 },
      ].filter((row) => v.hostel === 'Все хостелы' || v.hostel === row.name);
      const paid = rows.reduce(
        (sum, row) =>
          sum +
          (v.gender === 'Только М'
            ? row.paidM
            : v.gender === 'Только Ж'
              ? row.paidF
              : row.paidM + row.paidF),
        0,
      );
      const live = rows.reduce(
        (sum, row) =>
          sum +
          (v.gender === 'Только М'
            ? row.liveM
            : v.gender === 'Только Ж'
              ? row.liveF
              : row.liveM + row.liveF),
        0,
      );
      return (
        <>
          <div className={s.sourceBadge}>
            <Glyph name="places" />
            Размещение персонала / {String(v.hostel)}
          </div>
          <div className={s.placeMath}>
            <div>
              <small>Оплачено мест</small>
              <strong>{paid}</strong>
            </div>
            <span>−</span>
            <div>
              <small>Проживает</small>
              <strong>{live}</strong>
            </div>
            <span>=</span>
            <div data-result>
              <small>Свободно</small>
              <strong>{paid - live}</strong>
            </div>
          </div>
          <div className={s.inlineTotal}>
            <span>В строку «{String(v.name)}» за 31 октября</span>
            <strong>
              {v.metric === 'Проживает' ? live : v.metric === 'Оплачено мест' ? paid : paid - live}
            </strong>
          </div>
          <p className={s.resultNote}>
            {String(v.gender)}. Показатель рассчитывается отдельно на каждую дату.
          </p>
        </>
      );
    }
    case 'personnel':
      return (
        <>
          <div className={s.mapping}>
            {[
              ['ФИО', v.fullName],
              ['Табельный номер', v.number],
              ['Телефон', v.phone],
              ['Начало вахты', v.shift],
            ].map(([label, source]) => (
              <div key={String(label)}>
                <span>{source === 'Не использовать' ? 'Не связано' : `Столбец «${source}»`}</span>
                <Glyph name="arrow" />
                <strong>{label}</strong>
              </div>
            ))}
          </div>
          <div className={s.employee}>
            <span className={s.avatar}>АИ</span>
            <div>
              <strong>
                {v.fullName === 'Не использовать' ? 'Нет связи с ФИО' : 'Алексей Иванов'}
              </strong>
              <p>
                {v.number !== 'Не использовать' ? 'Табельный № 001' : 'Табельный номер не связан'}
                {v.phone !== 'Не использовать' ? ' · +7 (900) 000-00-00' : ''}
              </p>
              {v.shift !== 'Не использовать' && <small>Начало вахты: 1 ноября 2026</small>}
            </div>
          </div>
          <p className={s.resultNote}>
            После привязки существующие строки требуют проверки. Совпадения объединяются вручную.
          </p>
        </>
      );
    case 'dashboard':
    case 'statistics':
      return (
        <>
          <div className={s.chartMeta}>
            <span>25–31 октября 2026</span>
            <span>{String(v.source)}</span>
          </div>
          <Chart draft={draft} />
          <p className={s.resultNote}>
            {v.display === 'График'
              ? 'Каждая точка — отдельный день.'
              : String(v.aggregate ?? v.period)}
            .{' '}
            {v.scope === 'Только Северный'
              ? 'Общежитие «Северный».'
              : 'Общежития: Северный, Заводской, Речной.'}
          </p>
          {(v.aggregate === 'Сумма за период' || v.period === 'За весь период') &&
            v.source !== 'План заездов' &&
            v.display !== 'График' && (
              <p className={s.caution}>
                Здесь складываются дневные значения. Для количества людей или мест на дату выберите
                последнее значение.
              </p>
            )}
        </>
      );
    case 'arrivals':
      return <ArrivalSample draft={draft} />;
  }
}

function Preview({
  builder,
  draft,
  canvas = false,
  zone,
  onZone,
}: {
  builder: Builder;
  draft: Draft;
  canvas?: boolean;
  zone?: Zone;
  onZone?: (zone: Zone) => void;
}): JSX.Element {
  return (
    <section
      className={`${s.preview} ${canvas ? s.canvasPreview : ''}`}
      aria-label="Предпросмотр результата"
    >
      <div className={s.previewTop}>
        <span>
          <i /> Живой пример
        </span>
        <small>Демонстрационные данные</small>
      </div>
      <div className={s.resultHeading}>
        {canvas ? (
          <button
            className={s.editableTitle}
            aria-pressed={zone === 'name'}
            onClick={() => onZone?.('name')}
          >
            <h3>{String(draft.values.name || 'Добавьте название')}</h3>
            <Glyph name="edit" />
            <span>Название</span>
          </button>
        ) : (
          <h3>{String(draft.values.name || 'Добавьте название')}</h3>
        )}
      </div>
      <div
        className={s.outputZone}
        data-editable={canvas}
        data-selected={canvas && zone === 'content'}
      >
        {canvas && (
          <button
            className={s.editZone}
            onClick={() => onZone?.('content')}
            aria-pressed={zone === 'content'}
          >
            <Glyph name="edit" />
            Настроить содержимое
          </button>
        )}
        <Output builder={builder} draft={draft} />
      </div>
      {canvas && (
        <button
          className={s.viewZone}
          onClick={() => onZone?.('view')}
          aria-pressed={zone === 'view'}
        >
          <Glyph name="edit" />
          Настроить вид и поведение
        </button>
      )}
      <div className={s.previewSummary}>
        <Glyph name="check" />
        <p>{summary(builder, draft)}</p>
      </div>
    </section>
  );
}

const viewKeys = new Set([
  'wide',
  'limit',
  'pin',
  'display',
  'group',
  'format',
  'period',
  'aggregate',
  'archived',
  'layout',
  'card',
  'empty',
  'types',
  'addRow',
  'clear',
]);

export function ConstructorLab(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const builder = builders.find((item) => item.id === params.get('builder')) ?? builders[8];
  const variant = variants.find((item) => item.id === params.get('variant')) ?? variants[1];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<Record<string, Draft>>({});
  const [history, setHistory] = useState<Record<string, Draft[]>>({});
  const [step, setStep] = useState(0);
  const [zone, setZone] = useState<Zone>('content');
  const [notice, setNotice] = useState('');
  const [showComparison, setShowComparison] = useState(false);
  const draft = drafts[builder.id] ?? builder.initial;
  const errors = validate(builder, draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved[builder.id] ?? builder.initial);
  const fields = visibleFields(builder, draft);
  const mainFields = fields.filter((field) => !field.advanced);
  const advancedFields = fields.filter((field) => field.advanced);
  const currentHistory = history[builder.id] ?? [];

  useEffect(() => {
    const previous = document.title;
    document.title = 'Пять вариантов конструкторов — Домовой';
    return () => {
      document.title = previous;
    };
  }, []);

  function navigate(nextBuilder: BuilderId, nextVariant: VariantId): void {
    setParams({ builder: nextBuilder, variant: nextVariant }, { replace: true });
    setStep(0);
    setZone('content');
    setNotice('');
  }
  function change(next: Draft): void {
    setHistory((current) => ({
      ...current,
      [builder.id]: [...(current[builder.id] ?? []), draft].slice(-40),
    }));
    setDrafts((current) => ({ ...current, [builder.id]: next }));
    setNotice('');
  }
  function changeValue(key: string, value: string | boolean): void {
    change({ ...draft, values: { ...draft.values, [key]: value } });
  }
  function undo(): void {
    const previous = currentHistory[currentHistory.length - 1];
    if (!previous) return;
    setDrafts((current) => ({ ...current, [builder.id]: previous }));
    setHistory((current) => ({ ...current, [builder.id]: currentHistory.slice(0, -1) }));
    setNotice('Последнее изменение отменено.');
  }
  const controls = (list: Field[], compact = false): JSX.Element[] =>
    list.map((field) => (
      <Control
        key={field.key}
        field={field}
        draft={draft}
        onChange={changeValue}
        compact={compact}
      />
    ));
  const collection = builder.collection ? (
    <ItemEditor builder={builder} draft={draft} onChange={change} />
  ) : null;
  const advanced = advancedFields.length > 0 && (
    <details className={s.advanced}>
      <summary>
        Дополнительные настройки <span>{advancedFields.length}</span>
      </summary>
      <div>{controls(advancedFields)}</div>
    </details>
  );
  const allSettings = (
    <>
      {controls(mainFields)}
      {collection}
      {advanced}
    </>
  );
  const renderPreview = (canvas = false): JSX.Element => (
    <Preview builder={builder} draft={draft} canvas={canvas} zone={zone} onZone={setZone} />
  );
  const selectedFields =
    zone === 'name'
      ? fields.filter((field) => field.key === 'name')
      : zone === 'view'
        ? fields.filter((field) => viewKeys.has(field.key))
        : fields.filter((field) => field.key !== 'name' && !viewKeys.has(field.key));

  return (
    <div className={s.page}>
      <header className={s.topbar}>
        <Link className={s.brand} to="/">
          <span>
            <Glyph name="house" />
          </span>
          Домовой
        </Link>
        <span className={s.labBadge}>Тестовая мастерская</span>
        <a href="#comparison" onClick={() => setShowComparison(true)}>
          Сравнить подходы <Glyph name="arrow" />
        </a>
      </header>
      <main className={s.main}>
        <div className={s.pageHeading}>
          <div>
            <h1>Как сделать конструкторы понятнее</h1>
            <p>Выберите конструктор и попробуйте пять способов его настроить.</p>
          </div>
          <div className={s.demoNote}>
            <Glyph name="check" />
            <span>
              Можно экспериментировать.
              <br />
              Изменения действуют только на этой странице.
            </span>
          </div>
        </div>
        <nav className={s.variants} aria-label="Варианты интерфейса">
          {variants.map((item, index) => (
            <button
              key={item.id}
              className="btn btn--choice"
              aria-pressed={item.id === variant.id}
              onClick={() => navigate(builder.id, item.id)}
            >
              <span className={s.variantDrawing}>
                <Glyph name={item.id} />
                <small>Вариант {index + 1}</small>
                {item.id === 'split' && <em>Рекомендую</em>}
              </span>
              <strong>{item.name}</strong>
              <span>{item.short}</span>
            </button>
          ))}
        </nav>
        <div className={s.workspace}>
          <aside className={s.sidebar} aria-label="Конструкторы проекта">
            <div className={s.sidebarTitle}>
              <h2>Что настраиваем</h2>
              <span>{builders.length}</span>
            </div>
            <select
              className={s.mobileSelect}
              aria-label="Выберите конструктор"
              value={builder.id}
              onChange={(event) => navigate(event.target.value as BuilderId, variant.id)}
            >
              {builders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <nav>
              {builders.map((item) => (
                <button
                  key={item.id}
                  className="btn btn--quiet"
                  aria-label={item.shortName}
                  aria-pressed={item.id === builder.id}
                  onClick={() => navigate(item.id, variant.id)}
                >
                  <Glyph name={item.id} />
                  <span>{item.shortName}</span>
                  {drafts[item.id] && <i aria-label="Есть черновик" />}
                </button>
              ))}
            </nav>
            <div className={s.sidebarNote}>
              <strong>Один язык для всего проекта</strong>
              <p>Одинаковые названия действий, подсказки и проверка перед применением.</p>
            </div>
          </aside>
          <section className={s.workbench} aria-label={builder.name}>
            <header className={s.workbenchHeading}>
              <div>
                <p className={s.breadcrumb}>{builder.location}</p>
                <h2>{builder.name}</h2>
                <p>{builder.task}</p>
              </div>
              <span className={s.variantBadge}>{variant.name}</span>
            </header>
            <div className={s.approach}>
              <Glyph name={variant.id} />
              <div>
                <strong>{variant.benefit}</strong>
                <p>{variant.description}</p>
              </div>
            </div>
            <details className={s.reason}>
              <summary>Что улучшаем в этом конструкторе</summary>
              <div>
                <p>
                  <strong>Сейчас.</strong> {builder.problem}
                </p>
                <p>
                  <strong>Предлагаю.</strong> {builder.improvement}
                </p>
              </div>
            </details>
            <div className={s.editor} key={`${builder.id}-${variant.id}`}>
              {variant.id === 'steps' && (
                <>
                  <nav className={s.steps} aria-label="Шаги настройки">
                    {['Задача и название', 'Содержимое', 'Проверка результата'].map(
                      (label, index) => (
                        <button
                          key={label}
                          className="btn btn--quiet"
                          aria-current={step === index ? 'step' : undefined}
                          onClick={() => setStep(index)}
                        >
                          <span>{step > index ? '✓' : index + 1}</span>
                          {label}
                        </button>
                      ),
                    )}
                  </nav>
                  <div className={s.wizardBody}>
                    {step === 0 ? (
                      <div className={s.wizardIntro}>
                        <div className={s.wizardIcon}>
                          <Glyph name={builder.id} />
                        </div>
                        <h3>Что должно получиться?</h3>
                        <p>{builder.task}</p>
                        {controls(fields.filter((field) => field.key === 'name'))}
                        <div className={s.tip}>
                          На следующем шаге настроим содержимое. После этого проверим результат на
                          примере.
                        </div>
                      </div>
                    ) : step === 1 ? (
                      <div className={s.wizardSettings}>
                        <h3>Настройте под свою задачу</h3>
                        {controls(mainFields.filter((field) => field.key !== 'name'))}
                        {collection}
                        {advanced}
                      </div>
                    ) : (
                      <>
                        {renderPreview()}
                        <div className={s.checkResult}>
                          <strong>
                            {errors.length
                              ? 'Нужно поправить перед применением'
                              : 'Всё готово для проверки'}
                          </strong>
                          <p>
                            Прочитайте описание под результатом. Если всё верно — примените
                            настройки в примере.
                          </p>
                          <button className={s.textButton} onClick={() => setStep(1)}>
                            Вернуться к настройкам
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className={s.stepActions}>
                    <button
                      className={s.secondary}
                      disabled={step === 0}
                      onClick={() => setStep((value) => value - 1)}
                    >
                      Назад
                    </button>
                    <span>Шаг {step + 1} из 3</span>
                    {step < 2 && (
                      <button
                        className={s.primary}
                        disabled={step === 0 && !String(draft.values.name).trim()}
                        onClick={() => setStep((value) => value + 1)}
                      >
                        {step === 0 ? 'Настроить содержимое' : 'Посмотреть результат'}
                        <Glyph name="arrow" />
                      </button>
                    )}
                  </div>
                </>
              )}
              {variant.id === 'split' && (
                <div className={s.splitLayout}>
                  <div className={s.settings}>
                    <h3>Настройки</h3>
                    <p className={s.muted}>Измените значение — результат обновится рядом.</p>
                    {allSettings}
                  </div>
                  {renderPreview()}
                </div>
              )}
              {variant.id === 'templates' && (
                <>
                  <div className={s.templateHeading}>
                    <h3>С чего начнём?</h3>
                    <p>Выберите знакомую задачу. Любой пример можно изменить.</p>
                  </div>
                  <div className={s.presets}>
                    {builder.presets.map((preset) => (
                      <button
                        key={preset.name}
                        className="btn btn--choice"
                        aria-pressed={
                          Object.entries(preset.values).every(
                            ([key, value]) => draft.values[key] === value,
                          ) &&
                          (!preset.items ||
                            JSON.stringify(preset.items) === JSON.stringify(draft.items))
                        }
                        onClick={() => {
                          change(applyPreset(draft, preset));
                          setNotice(
                            `Пример «${preset.name}» выбран. Настройки можно изменить ниже.`,
                          );
                        }}
                      >
                        <span className={s.presetIcon}>
                          <Glyph name={builder.id} />
                        </span>
                        <strong>{preset.name}</strong>
                        <p>{preset.description}</p>
                        <span className={s.choosePreset}>
                          Взять за основу <Glyph name="arrow" />
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className={s.splitLayout}>
                    <div className={s.settings}>
                      <h3>Подстройте пример</h3>
                      {allSettings}
                    </div>
                    {renderPreview()}
                  </div>
                </>
              )}
              {variant.id === 'sentence' && (
                <>
                  <div className={s.sentenceIntro}>
                    <h3>Опишите результат из готовых частей</h3>
                    <p>Выберите значения. Ниже прочитайте правило целиком и проверьте результат.</p>
                  </div>
                  <div className={s.sentence}>
                    <p>{builder.sentence}</p>
                    <div>{controls(mainFields, true)}</div>
                    {advanced}
                    <div className={s.readback}>
                      <Glyph name="check" />
                      <p>{summary(builder, draft)}</p>
                    </div>
                  </div>
                  {collection && <div className={s.sentenceCollection}>{collection}</div>}
                  {renderPreview()}
                </>
              )}
              {variant.id === 'canvas' && (
                <>
                  <p className={s.canvasHint}>
                    <Glyph name="edit" />
                    Нажмите на название, содержимое или кнопку вида в примере.
                  </p>
                  <div className={s.canvasLayout}>
                    {renderPreview(true)}
                    <aside className={s.inspector} aria-label="Настройки выбранной области">
                      <h3>
                        {zone === 'name'
                          ? 'Название'
                          : zone === 'content'
                            ? 'Содержимое'
                            : 'Вид и поведение'}
                      </h3>
                      <div className={s.zoneTabs}>
                        {(['name', 'content', 'view'] as const).map((item) => (
                          <button
                            key={item}
                            className="btn btn--segment"
                            onClick={() => setZone(item)}
                            aria-pressed={zone === item}
                          >
                            {item === 'name' ? 'Название' : item === 'content' ? 'Данные' : 'Вид'}
                          </button>
                        ))}
                      </div>
                      {controls(selectedFields)}
                      {zone === 'content' && collection}
                      {selectedFields.length === 0 && !(zone === 'content' && collection) && (
                        <p className={s.muted}>
                          Для этого примера отдельные настройки вида не нужны. Выберите «Данные» или
                          «Название».
                        </p>
                      )}
                    </aside>
                  </div>
                </>
              )}
            </div>
            <footer className={s.applyBar}>
              <div className={s.feedback} aria-live="polite">
                {errors.length > 0 ? (
                  <ul className={s.errors}>
                    {errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <span className={dirty ? s.draftStatus : s.readyStatus}>
                      <i />
                      {dirty
                        ? 'Есть изменения в примере'
                        : saved[builder.id]
                          ? 'Применено в примере'
                          : 'Готово к эксперименту'}
                    </span>
                    <p>{notice || 'Данные рабочего кабинета не меняются.'}</p>
                  </>
                )}
              </div>
              <div className={s.applyActions}>
                <button
                  className={s.iconButton}
                  disabled={!currentHistory.length}
                  onClick={undo}
                  aria-label="Отменить последнее изменение"
                  title="Отменить последнее изменение"
                >
                  <Glyph name="undo" />
                </button>
                <button
                  className={s.secondary}
                  onClick={() => {
                    change(builder.initial);
                    setNotice('Возвращён исходный пример. Это действие можно отменить.');
                  }}
                >
                  Сбросить
                </button>
                <button
                  className={s.primary}
                  disabled={errors.length > 0 || (variant.id === 'steps' && step !== 2)}
                  onClick={() => {
                    setSaved((current) => ({ ...current, [builder.id]: draft }));
                    setNotice('Настройки применены в примере и хранятся до перезагрузки страницы.');
                  }}
                >
                  <Glyph name="check" />
                  Применить в примере
                </button>
              </div>
            </footer>
          </section>
        </div>
        <section className={s.recommendation}>
          <span className={s.recommendIcon}>
            <Glyph name="split" />
          </span>
          <div>
            <h2>Я бы начал с «Настройки + результат»</h2>
            <p>
              Это общая основа для всех {builders.length} сценариев. При первом создании можно
              включать мастер, для типовых задач предлагать примеры, а формулы и связи дополнить
              читаемым описанием.
            </p>
          </div>
          <button className={s.secondary} onClick={() => navigate(builder.id, 'split')}>
            Попробовать основу
          </button>
        </section>
        <section className={s.comparison} id="comparison">
          <button
            className={s.comparisonToggle}
            aria-expanded={showComparison}
            aria-controls="constructor-comparison"
            onClick={() => setShowComparison((value) => !value)}
          >
            <span>
              <h2>Сравнить все пять подходов</h2>
              <p>Где каждый помогает и что нужно учесть</p>
            </span>
            <span aria-hidden="true">{showComparison ? '−' : '+'}</span>
          </button>
          {showComparison && (
            <div id="constructor-comparison" className={s.tableScroll}>
              <table>
                <thead>
                  <tr>
                    <th>Подход</th>
                    <th>Где особенно полезен</th>
                    <th>Преимущество</th>
                    <th>Что учесть</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <button
                          className={s.textButton}
                          onClick={() => navigate(builder.id, item.id)}
                        >
                          {item.name}
                        </button>
                      </th>
                      <td>{item.best}</td>
                      <td>{item.benefit}</td>
                      <td>{item.tradeoff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className={s.bottomNote}>
          Во всех вариантах доступны одни и те же настройки. Черновик каждого конструктора
          сохраняется при переключении. Перезагрузка возвращает исходные примеры.
        </p>
      </main>
    </div>
  );
}
