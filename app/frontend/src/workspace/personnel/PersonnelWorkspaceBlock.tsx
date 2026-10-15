import type { Block, BlockKind, PersonnelData } from '../../api/personnel';
import resident from '../../assets/avatar-rezident.svg';
import manager from '../../assets/avatar-kadrovik.svg';
import commandant from '../../assets/avatar-komendant.svg';
import { dayDiff, dormName, personName, value } from './helpers';
import { PersonnelBlockIcon as Icon } from './PersonnelBlockIcon';
import { blockSource, workspaceBlockData } from './workspaceBlockData';
import type { BlockCriteria, WorkspaceBlockData } from './workspaceBlockData';
import s from './PersonnelWorkspace.module.css';

const labels: Record<BlockKind, string> = {
  plans: 'человек ожидается',
  residents: 'проживают сейчас',
  ending: 'завершают вахту',
  contacts: 'сотрудников в списке',
  saved: 'в сохранённом списке',
};
function BlockChart({ kind, model }: { kind: BlockKind; model: WorkspaceBlockData }): JSX.Element {
  if (!model.total)
    return (
      <div className={s.chartEmpty}>
        <Icon name={kind} />
        <span>{model.missingList ? 'Выберите список' : 'Пока нет данных'}</span>
      </div>
    );
  if (kind === 'residents') {
    const placements = model.dorms.reduce((total, dorm) => total + dorm.count, 0);
    const series = model.dorms
      .slice(0, 4)
      .map((dorm) => ({ label: dorm.name, count: dorm.count, tone: dorm.tone }));
    if (model.dorms.length > 4)
      series.push({
        label: 'Другие общежития',
        count: model.dorms.slice(4).reduce((total, dorm) => total + dorm.count, 0),
        tone: 4,
      });
    let offset = 0;
    return (
      <div className={s.ringWrap}>
        <svg
          viewBox="0 0 100 100"
          className={s.ring}
          role="img"
          aria-label={`Размещения по общежитиям: ${series
            .filter((point) => point.count)
            .map((point) => `${point.label} — ${point.count}`)
            .join('; ')}`}
        >
          {series
            .filter((point) => point.count)
            .map((point, index) => {
              const size = (point.count / Math.max(placements, 1)) * 100;
              const start = offset;
              offset += size;
              const gap = Math.min(1, size / 3);
              return (
                <circle
                  key={`${index}:${point.label}`}
                  className={s.ringSegment}
                  data-tone={point.tone}
                  cx="50"
                  cy="50"
                  r="38"
                  fill="none"
                  strokeWidth="12"
                  pathLength="100"
                  strokeDasharray={`${size - gap} ${100 - size + gap}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 50 50)"
                />
              );
            })}
          <text x="50" y="54" textAnchor="middle">
            {placements}
          </text>
        </svg>
        <span>{placements === model.total ? 'По общежитиям' : 'Размещений'}</span>
      </div>
    );
  }
  if (kind === 'plans' || kind === 'ending') {
    const maximum = Math.max(1, ...model.series.map((point) => point.count));
    return (
      <div
        className={s.bars}
        role="img"
        aria-label={`По датам: ${model.series.map((point) => `${point.label} — ${point.count} чел.`).join('; ')}`}
      >
        {model.series.map((point) => (
          <div key={point.label}>
            <span>{point.count}</span>
            <div className={s.barTrack}>
              <i style={{ height: `${(point.count / maximum) * 100}%` }} />
            </div>
            <small>{point.label}</small>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={s.chartPeople}>
      <div className={s.portraits} aria-hidden="true">
        <img src={resident} alt="" />
        <img src={manager} alt="" />
        <img src={commandant} alt="" />
      </div>
      <span>{kind === 'saved' ? model.list?.name : 'Контакты команды'}</span>
    </div>
  );
}

type Props = {
  block: Block;
  data: PersonnelData;
  dormitory: number | null;
  configuring: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onPerson: (id: string) => void;
  onList: (criteria: BlockCriteria) => void;
  onPlanning: () => void;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
};
export function PersonnelWorkspaceBlock({
  block,
  data,
  dormitory,
  configuring,
  busy,
  first,
  last,
  onPerson,
  onList,
  onPlanning,
  onEdit,
  onMove,
  onRemove,
}: Props): JSX.Element {
  const model = workspaceBlockData(block, data, dormitory);
  const rowCount =
    block.kind === 'plans'
      ? model.plans.length
      : block.kind === 'residents'
        ? model.dorms.length
        : model.people.length;
  const placements = model.dorms.reduce((total, dorm) => total + dorm.count, 0);
  const openList = (): void => (block.kind === 'plans' ? onPlanning() : onList(model.criteria));
  return (
    <article
      className={s.card}
      data-kind={block.kind}
      data-wide={block.wide}
      data-testid={`personnel-block-${block.id}`}
      aria-label={block.title}
    >
      {configuring && (
        <div className={s.blockTools}>
          <span>Настройка блока</span>
          <button
            type="button"
            className={`btn btn--outline btn--compact ${s.iconButton}`}
            disabled={busy || first}
            aria-label={`Поднять блок «${block.title}»`}
            onClick={() => onMove(-1)}
          >
            <Icon name="up" />
          </button>
          <button
            type="button"
            className={`btn btn--outline btn--compact ${s.iconButton}`}
            disabled={busy || last}
            aria-label={`Опустить блок «${block.title}»`}
            onClick={() => onMove(1)}
          >
            <Icon name="down" />
          </button>
          <button
            type="button"
            className={`btn btn--outline btn--compact ${s.iconButton}`}
            disabled={busy}
            aria-label={`Убрать блок «${block.title}»`}
            onClick={onRemove}
          >
            <Icon name="remove" />
          </button>
        </div>
      )}
      <div className={s.cardIntro}>
        <header className={s.cardHead}>
          <span className={s.typeIcon}>
            <Icon name={block.kind} />
          </span>
          <div>
            <h2>{block.title}</h2>
            <p>
              {model.scopeLabel}
              {(block.kind === 'plans' || block.kind === 'ending') && ` · ${block.days} дн.`}
            </p>
          </div>
          <button
            type="button"
            className={`link-button ${s.iconButton}`}
            disabled={busy}
            aria-label={`Настроить блок «${block.title}»`}
            onClick={onEdit}
          >
            <Icon name="settings" />
          </button>
        </header>
        <div className={s.visualSummary}>
          <button
            type="button"
            className={`link-button ${s.metric}`}
            disabled={model.missingList}
            onClick={openList}
          >
            <strong>{model.total}</strong>
            <span>{labels[block.kind]}</span>
          </button>
          <BlockChart kind={block.kind} model={model} />
        </div>
      </div>
      <div className={s.cardBody}>
        {model.missingList ? (
          <div className={s.empty}>
            <Icon name="saved" />
            <strong>Список не выбран или удалён</strong>
            <p>Выберите сохранённый список в настройках блока.</p>
            <button
              type="button"
              className="btn btn--outline btn--compact"
              disabled={busy}
              onClick={onEdit}
            >
              Выбрать список
            </button>
          </div>
        ) : (
          <>
            <ul className={s.rows}>
              {block.kind === 'plans' &&
                model.plans.slice(0, block.limit).map((plan) => (
                  <li key={plan.id}>
                    <button type="button" className={`link-button ${s.row}`} onClick={onPlanning}>
                      <time className={s.dateTile} dateTime={plan.date}>
                        <strong>{Number(plan.date.slice(8, 10))}</strong>
                        <small>
                          {new Intl.DateTimeFormat('ru-RU', {
                            month: 'short',
                            timeZone: 'UTC',
                          }).format(new Date(`${plan.date}T00:00:00Z`))}
                        </small>
                      </time>
                      <span className={s.rowCopy}>
                        <strong>{dormName(data, plan.dormitory_id)}</strong>
                        <span>{plan.names.length ? plan.names.join(', ') : 'ФИО не указаны'}</span>
                      </span>
                      <span className={s.rowValue}>{plan.count} чел.</span>
                    </button>
                  </li>
                ))}
              {block.kind === 'residents' &&
                model.dorms.slice(0, block.limit).map((dorm) => (
                  <li key={dorm.id}>
                    <button
                      type="button"
                      className={`link-button ${s.row}`}
                      onClick={() => onList({ ...model.criteria, dormitory: dorm.id })}
                    >
                      <span className={s.dormIcon} data-tone={dorm.tone}>
                        <Icon name="residents" />
                      </span>
                      <span className={s.rowCopy}>
                        <strong>{dorm.name}</strong>
                        <span>
                          {dorm.client_name || 'Проживают сейчас'}
                          {dorm.is_archived ? ' · архив' : ''}
                        </span>
                        <span className={s.residentTrack}>
                          <i
                            data-tone={dorm.tone}
                            style={{ width: `${(dorm.count / Math.max(placements, 1)) * 100}%` }}
                          />
                        </span>
                      </span>
                      <span className={s.rowValue}>{dorm.count}</span>
                    </button>
                  </li>
                ))}
              {block.kind !== 'residents' &&
                block.kind !== 'plans' &&
                model.people.slice(0, block.limit).map((person, index) => {
                  const source = blockSource(person, model.criteria, data.today);
                  const end = value(source, 'shift_end');
                  return (
                    <li key={person.id}>
                      <button
                        type="button"
                        className={`link-button ${s.row}`}
                        onClick={() => onPerson(person.id)}
                      >
                        <span className={s.initials} data-tone={index % 3} aria-hidden="true">
                          {person.full_name
                            ?.split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join('') || '?'}
                        </span>
                        <span className={s.rowCopy}>
                          <strong>{personName(person)}</strong>
                          <span>
                            {source
                              ? dormName(data, source.dormitory_id)
                              : [
                                  ...new Set(
                                    person.sources.map((item) => dormName(data, item.dormitory_id)),
                                  ),
                                ].join(' · ') || 'Нет текущего проживания'}{' '}
                            · Т/н {person.personnel_number ?? '—'}
                          </span>
                        </span>
                        {block.kind === 'contacts' ? (
                          <span className={s.rowValue}>{person.phone || 'Телефон не указан'}</span>
                        ) : block.kind === 'ending' ? (
                          <time
                            className={s.rowValue}
                            dateTime={end || undefined}
                            data-today={end === data.today}
                          >
                            {!end
                              ? 'Дата не указана'
                              : end === data.today
                                ? 'Сегодня'
                                : `Через ${dayDiff(data.today, end)} дн.`}
                          </time>
                        ) : (
                          <span className={s.rowValue}>
                            <Icon name="arrow" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
            </ul>
            {!rowCount && (
              <div className={s.empty}>
                <Icon name={block.kind} />
                <strong>
                  {block.kind === 'plans'
                    ? 'Пока нет заездов'
                    : block.kind === 'residents'
                      ? 'Нет общежитий в выборке'
                      : 'Нет сотрудников в выборке'}
                </strong>
                <p>
                  {block.kind === 'plans'
                    ? 'На выбранный период планов нет.'
                    : 'По выбранным условиям сотрудников нет.'}
                </p>
              </div>
            )}
            <footer className={s.footer}>
              <span>
                {rowCount > block.limit
                  ? `Показано ${block.limit} из ${rowCount}`
                  : 'Все записи в блоке'}
                {block.kind === 'residents' && placements !== model.total && (
                  <small>Человек может проживать в нескольких общежитиях.</small>
                )}
              </span>
              <button type="button" className={`link-button ${s.listLink}`} onClick={openList}>
                {block.kind === 'plans' ? 'Открыть план заездов' : 'Открыть список'}
                <Icon name="arrow" />
              </button>
            </footer>
          </>
        )}
      </div>
    </article>
  );
}
