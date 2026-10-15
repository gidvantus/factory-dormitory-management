import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Block, BlockKind } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import house from '../../assets/dorm-house.svg';
import plant from '../../assets/plant.svg';
import resident from '../../assets/avatar-rezident.svg';
import manager from '../../assets/avatar-kadrovik.svg';
import commandant from '../../assets/avatar-komendant.svg';
import workspace from '../../workspace/Workspace.module.css';
import lab from '../PricingDesignPreview.module.css';
import context from '../DashboardTariffDesignPreview.module.css';
import { blockNames, designs, dorms, kinds, newBlock, preset, scopeName, snapshot } from './data';
import type { Snapshot } from './data';
import s from './PersonnelWorkspaceDesignPreview.module.css';

type IconName = BlockKind | 'plus' | 'settings' | 'arrow' | 'up' | 'down' | 'remove' | 'expand';
const dateAt = (day: number): string =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 9, 14 + day)),
  );
function Icon({ name }: { name: IconName }): JSX.Element {
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
      {name === 'plans' && (
        <>
          <rect x="4" y="5" width="16" height="16" rx="3" />
          <path d="M8 3v4m8-4v4M4 10h16m-12 4h2m4 0h2m-8 3h2" />
        </>
      )}
      {name === 'residents' && (
        <>
          <path d="m3 10 9-7 9 7M5 9v12h14V9M10 21v-7h4v7M8 10h1m6 0h1" />
        </>
      )}
      {name === 'ending' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 6v6l4 2" />
        </>
      )}
      {name === 'contacts' && (
        <>
          <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a14 14 0 0 1-7-7l2-2-2-5Z" />
          <path d="M15 3a6 6 0 0 1 6 6m-6-2a2 2 0 0 1 2 2" />
        </>
      )}
      {name === 'saved' && (
        <>
          <path d="M6 3h12v18l-6-4-6 4V3Z" />
          <path d="M9 8h6m-6 4h4" />
        </>
      )}
      {name === 'plus' && <path d="M12 5v14M5 12h14" />}
      {name === 'arrow' && <path d="M4 12h16m-6-6 6 6-6 6" />}
      {name === 'up' && <path d="M12 20V4m-6 6 6-6 6 6" />}
      {name === 'down' && <path d="M12 4v16m-6-6 6 6 6-6" />}
      {name === 'remove' && (
        <>
          <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
        </>
      )}
      {name === 'expand' && <path d="M9 3H3v6m0-6 7 7m5 11h6v-6m0 6-7-7" />}
      {name === 'settings' && (
        <>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <path d="M8 3v6m8 0v6M9 15v6" />
        </>
      )}
    </svg>
  );
}

function Artwork({ kind }: { kind: BlockKind }): JSX.Element {
  return (
    <div className={s.artwork} aria-hidden="true">
      {kind === 'residents' && <img className={s.house} src={house} alt="" />}
      {kind === 'contacts' && (
        <div className={s.portraits}>
          <img src={resident} alt="" />
          <img src={manager} alt="" />
          <img src={commandant} alt="" />
        </div>
      )}
      {kind === 'plans' && (
        <svg viewBox="0 0 132 106" className={s.drawing}>
          <path className={s.artLine} d="M7 98h119" />
          <rect
            className={s.artPaper}
            x="24"
            y="20"
            width="87"
            height="76"
            rx="10"
            transform="rotate(8 67 58)"
          />
          <rect className={s.artPaper} x="15" y="17" width="86" height="76" rx="10" />
          <path className={s.artSky} d="M25 17h66a10 10 0 0 1 10 10v13H15V27a10 10 0 0 1 10-10Z" />
          <path className={s.artLine} d="M35 9v16M81 9v16" />
          <text x="58" y="76" textAnchor="middle" className={s.artNumber}>
            14
          </text>
          <circle className={s.artMint} cx="108" cy="81" r="18" />
          <path className={s.artLine} d="m100 81 5 5 11-11" />
        </svg>
      )}
      {kind === 'ending' && (
        <svg viewBox="0 0 132 106" className={s.drawing}>
          <path className={s.artLine} d="M10 98h112M39 88l-8 10m62-10 8 10" />
          <path className={s.artPeach} d="M22 25 37 9l13 8-18 18Zm60-8 13-8 15 16-10 10Z" />
          <circle className={s.artPaper} cx="66" cy="56" r="39" />
          <circle className={s.artButter} cx="66" cy="56" r="31" />
          <path className={s.artLine} d="M66 34v23l17 10M66 19v5m0 64v5M29 56h5m64 0h5" />
          <circle className={s.artInk} cx="66" cy="56" r="3" />
        </svg>
      )}
      {kind === 'saved' && (
        <svg viewBox="0 0 132 106" className={s.drawing}>
          <rect
            className={s.artLilac}
            x="33"
            y="12"
            width="73"
            height="83"
            rx="8"
            transform="rotate(8 70 53)"
          />
          <rect className={s.artPaper} x="18" y="17" width="75" height="82" rx="8" />
          <path className={s.artMint} d="M64 17h15v29l-7.5-5-7.5 5Z" />
          <path className={s.artLine} d="m29 55 3 3 6-7m7 4h31m-47 17 3 3 6-7m7 4h31m-47 14h39" />
        </svg>
      )}
    </div>
  );
}

function MiniChart({ block, data }: { block: Block; data: Snapshot }): JSX.Element {
  if (!data.total)
    return (
      <div className={s.chartEmpty}>
        <Icon name={block.kind} />
        <span>Пока нет данных</span>
      </div>
    );
  if (block.kind === 'residents') {
    let offset = 0;
    return (
      <div className={s.ringWrap}>
        <svg
          viewBox="0 0 100 100"
          className={s.ring}
          aria-label="Распределение проживающих по общежитиям"
          role="img"
        >
          {data.allRows.map((row, index) => {
            const size = ((row.number ?? 0) / data.total) * 100;
            const start = offset;
            offset += size;
            return (
              <circle
                key={row.id}
                className={s.ringSegment}
                data-segment={index}
                cx="50"
                cy="50"
                r="38"
                fill="none"
                strokeWidth="12"
                pathLength="100"
                strokeDasharray={`${Math.max(0, size - 2)} ${102 - size}`}
                strokeDashoffset={-start}
                transform="rotate(-90 50 50)"
              />
            );
          })}
          <text x="50" y="54" textAnchor="middle">
            {data.total}
          </text>
        </svg>
        <span>По общежитиям</span>
      </div>
    );
  }
  if (block.kind === 'plans' || block.kind === 'ending') {
    const days = [...new Set(data.allRows.map((row) => row.day ?? 0))].sort((a, b) => a - b);
    const values = days.map((day) =>
      data.allRows
        .filter((row) => row.day === day)
        .reduce((sum, row) => sum + (row.number ?? 1), 0),
    );
    const maximum = Math.max(...values, 1);
    return (
      <div
        className={s.bars}
        role="img"
        aria-label={days.map((day, i) => `${dateAt(day)}: ${values[i]} чел.`).join('; ')}
      >
        {days.map((day, index) => (
          <div key={day}>
            <span>{values[index]}</span>
            <div className={s.barTrack}>
              <i style={{ height: `${(values[index] / maximum) * 100}%` }} />
            </div>
            <small>{dateAt(day)}</small>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={s.chartPeople}>
      <div className={s.portraits}>
        <img src={resident} alt="" />
        <img src={manager} alt="" />
        <img src={commandant} alt="" />
      </div>
      <span>{block.kind === 'saved' ? 'Бригада № 2' : 'Всегда на связи'}</span>
    </div>
  );
}

function Rows({
  block,
  data,
  showAll = false,
}: {
  block: Block;
  data: Snapshot;
  showAll?: boolean;
}): JSX.Element {
  const rows = showAll ? data.allRows : data.rows;
  if (!rows.length)
    return (
      <div className={s.emptyBlock}>
        <Icon name={block.kind} />
        <strong>Здесь пока тихо</strong>
        <span>Для выбранных настроек записей нет.</span>
      </div>
    );
  return (
    <ul className={s.rows}>
      {rows.map((row, index) => (
        <li className={s.dataRow} key={row.id}>
          {block.kind === 'plans' ? (
            <span className={s.dateTile}>
              <strong>{14 + (row.day ?? 0)}</strong>
              <small>окт</small>
            </span>
          ) : block.kind === 'residents' ? (
            <span className={s.dormIcon} data-segment={index}>
              <Icon name="residents" />
            </span>
          ) : (
            <span className={s.initials} data-segment={index % 3}>
              {row.title
                .split(' ')
                .map((word) => word[0])
                .slice(0, 2)
                .join('')}
            </span>
          )}
          <div className={s.rowCopy}>
            <strong>{row.title}</strong>
            <span>{row.detail}</span>
            {block.kind === 'residents' && (
              <span className={s.residentTrack}>
                <i
                  data-segment={index}
                  style={{ width: `${((row.number ?? 0) / Math.max(data.total, 1)) * 100}%` }}
                />
              </span>
            )}
          </div>
          <span className={s.rowValue} data-today={block.kind === 'ending' && row.day === 0}>
            {row.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

type WidgetProps = {
  block: Block;
  index: number;
  count: number;
  design: number;
  dorm: number;
  empty: boolean;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (step: number) => void;
  onWide: () => void;
  onOpen: () => void;
};
function Widget({
  block,
  index,
  count,
  design,
  dorm,
  empty,
  editing,
  onEdit,
  onRemove,
  onMove,
  onWide,
  onOpen,
}: WidgetProps): JSX.Element {
  const data = snapshot(block, dorm, empty);
  return (
    <article
      className={s.widget}
      data-kind={block.kind}
      data-wide={block.wide}
      data-featured={index === 0}
      data-block-id={block.id}
    >
      {editing && (
        <div className={s.editTools}>
          <span>Блок {index + 1}</span>
          <button
            type="button"
            className={`btn btn--outline btn--compact ${s.settings}`}
            aria-label={`Выше: ${block.title}`}
            disabled={!index}
            onClick={() => onMove(-1)}
          >
            <Icon name="up" />
          </button>
          <button
            type="button"
            className={`btn btn--outline btn--compact ${s.settings}`}
            aria-label={`Ниже: ${block.title}`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <Icon name="down" />
          </button>
          <button
            type="button"
            className={`btn btn--compact ${block.wide ? 'btn--primary' : 'btn--outline'} ${s.settings}`}
            aria-label={`На всю ширину: ${block.title}`}
            aria-pressed={block.wide}
            onClick={onWide}
          >
            <Icon name="expand" />
          </button>
          <button
            type="button"
            className={`btn btn--outline btn--compact ${s.settings}`}
            aria-label={`Удалить: ${block.title}`}
            onClick={onRemove}
          >
            <Icon name="remove" />
          </button>
        </div>
      )}
      <div className={s.widgetIntro}>
        <header className={s.widgetHead}>
          <span className={s.typeIcon}>
            <Icon name={block.kind} />
          </span>
          <div>
            <h4>{block.title}</h4>
            <p>
              {scopeName(block.scope)}
              {(block.kind === 'plans' || block.kind === 'ending') && ` · ${block.days} дн.`}
            </p>
          </div>
          <button
            type="button"
            className={`link-button ${s.settings}`}
            aria-label={`Настроить: ${block.title}`}
            onClick={onEdit}
          >
            <Icon name="settings" />
          </button>
        </header>
        <div className={s.visualSummary}>
          <div className={s.metric}>
            <strong>{data.total}</strong>
            <span>{data.label}</span>
          </div>
          {design === 2 ? <MiniChart block={block} data={data} /> : <Artwork kind={block.kind} />}
        </div>
      </div>
      <div className={s.widgetBody}>
        <Rows block={block} data={data} />
        <footer className={s.widgetFoot}>
          <span>
            {data.allRows.length > data.rows.length
              ? `Показано ${data.rows.length} из ${data.allRows.length}`
              : 'Все записи в блоке'}
          </span>
          <button type="button" className="link-button" onClick={onOpen}>
            {block.kind === 'plans' ? 'План заездов' : 'Открыть список'}
            <Icon name="arrow" />
          </button>
        </footer>
      </div>
    </article>
  );
}

function BlockEditor({
  initial,
  onClose,
  onSave,
  adding,
}: {
  initial: Block;
  onClose: () => void;
  onSave: (block: Block) => void;
  adding: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  function selectKind(kind: BlockKind): void {
    setDraft((current) => ({
      ...current,
      kind,
      title: blockNames[kind],
      saved_list_id: kind === 'saved' ? 'crew' : null,
    }));
  }
  return (
    <Modal
      title={adding ? 'Добавить блок' : 'Настроить блок'}
      testId="personnel-block-editor"
      onClose={onClose}
      panelClassName={s.editorPanel}
    >
      <form
        className={s.editor}
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.title.trim()) onSave({ ...draft, title: draft.title.trim() });
        }}
      >
        <fieldset>
          <legend>Тип блока</legend>
          <div className={s.kindPicker}>
            {kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`btn btn--compact ${draft.kind === kind ? 'btn--primary' : 'btn--outline'}`}
                aria-pressed={draft.kind === kind}
                onClick={() => selectKind(kind)}
              >
                <Icon name={kind} />
                <span>{blockNames[kind]}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          Название
          <input
            name="block-title"
            required
            maxLength={120}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>
        <fieldset>
          <legend>
            Общежития <span>· без отметок — все</span>
          </legend>
          <div className={s.scopeChecks}>
            {dorms.map((dorm) => (
              <label key={dorm.id}>
                <input
                  type="checkbox"
                  checked={draft.scope.includes(dorm.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      scope: event.target.checked
                        ? [...draft.scope, dorm.id]
                        : draft.scope.filter((id) => id !== dorm.id),
                    })
                  }
                />
                {dorm.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className={s.fields}>
          {(draft.kind === 'plans' || draft.kind === 'ending') && (
            <label>
              Период, дней
              <input
                name="block-days"
                type="number"
                min={1}
                max={365}
                required
                value={draft.days}
                onChange={(event) => setDraft({ ...draft, days: Number(event.target.value) })}
              />
            </label>
          )}
          <label>
            Строк в блоке
            <input
              name="block-limit"
              type="number"
              min={1}
              max={20}
              required
              value={draft.limit}
              onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })}
            />
          </label>
        </div>
        {draft.kind === 'saved' && (
          <label>
            Сохранённый список
            <select
              value={draft.saved_list_id ?? ''}
              onChange={(event) => setDraft({ ...draft, saved_list_id: event.target.value })}
            >
              <option value="crew">Бригада № 2</option>
            </select>
          </label>
        )}
        <label className={s.checkLabel}>
          <input
            name="block-wide"
            type="checkbox"
            checked={draft.wide}
            onChange={(event) => setDraft({ ...draft, wide: event.target.checked })}
          />
          На всю ширину рабочей поверхности
        </label>
        <p className={s.muted}>Настройки меняются только в этом макете.</p>
        <div className={s.editorActions}>
          <button type="button" className="btn btn--outline btn--compact" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn--primary btn--compact">
            {adding ? 'Добавить в макет' : 'Сохранить в макете'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const navigation: { label: string; icon: WorkspaceIconName }[] = [
  { label: 'Обзор', icon: 'overview' },
  { label: 'Общежития', icon: 'house' },
  { label: 'Тарифы', icon: 'chart' },
  { label: 'Магазин улучшений', icon: 'info' },
  { label: 'Документы', icon: 'document' },
  { label: 'Персонал', icon: 'people' },
  { label: 'Статистика', icon: 'chart' },
];

export function PersonnelWorkspaceDesignPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('variant') ?? 1);
  const active = Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : 1;
  const all = params.get('view') === 'all';
  const [blocks, setBlocks] = useState<Block[]>(() => preset());
  const [editing, setEditing] = useState(false);
  const [dorm, setDorm] = useState(0);
  const [days, setDays] = useState(5);
  const [empty, setEmpty] = useState(false);
  const [editor, setEditor] = useState<{ block: Block; adding: boolean } | null>(null);
  const [detail, setDetail] = useState<{ title: string; block?: Block } | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const title = document.title;
    document.title = 'Персонал — 5 вариантов рабочей поверхности — Домовой';
    return () => {
      document.title = title;
    };
  }, []);
  function choose(variant: number, showAll = false): void {
    const next = new URLSearchParams(params);
    next.set('variant', String(variant));
    if (showAll) next.set('view', 'all');
    else next.delete('view');
    setParams(next, { preventScrollReset: true });
  }
  function add(): void {
    if (blocks.length < 20) setEditor({ block: newBlock('plans'), adding: true });
  }
  function move(id: string, step: number): void {
    setBlocks((current) => {
      const index = current.findIndex((block) => block.id === id);
      const next = [...current];
      if (index + step >= 0 && index + step < next.length)
        [next[index], next[index + step]] = [next[index + step], next[index]];
      return next;
    });
    setNotice('Порядок блоков изменён');
  }
  const residents = snapshot({ ...preset()[1] }, dorm, empty).total;
  const ending = snapshot({ ...preset()[2], days }, dorm, empty).total;
  return (
    <div className={`${context.page} ${s.page}`} data-testid="personnel-workspace-preview">
      <a className="skip-link" href="#personnel-workspace-preview">
        К рабочей поверхности
      </a>
      <header className={lab.lab}>
        <div className={context.container}>
          <div className={lab.labTop}>
            <Link className={context.labBrand} to="/">
              <WorkspaceIcon name="house" />
              Домовой<span>/ Дизайн-примерочная</span>
            </Link>
            <Link className={context.previousPreview} to="/cabinet/personnel">
              Открыть текущий раздел ↗
            </Link>
          </div>
          <div className={lab.labHeading}>
            <div>
              <h1>Персонал · рабочая поверхность</h1>
              <p>
                Пять способов сделать блоки живее. Добавляйте свои и сравнивайте на одном наборе
                данных.
              </p>
            </div>
            <span className={lab.testBadge}>Тестовая страница</span>
          </div>
          <div className={lab.switcher}>
            <nav className={lab.variantNav} aria-label="Варианты рабочей поверхности">
              {designs.map((design, index) => (
                <button
                  type="button"
                  key={design.name}
                  className={`btn btn--sm ${!all && active === index + 1 ? 'btn--ink' : 'btn--outline'}`}
                  aria-pressed={!all && active === index + 1}
                  onClick={() => choose(index + 1)}
                >
                  <span className={lab.navNumber}>0{index + 1}</span>
                  {design.name}
                </button>
              ))}
            </nav>
            <button
              type="button"
              className={`btn btn--sm ${all ? 'btn--ink' : 'btn--outline'}`}
              aria-pressed={all}
              onClick={() => choose(active, !all)}
            >
              Все варианты
            </button>
          </div>
        </div>
      </header>
      <main className={context.container} id="personnel-workspace-preview">
        <div className={context.stateBar}>
          <div className={context.stateButtons} role="group" aria-label="Набор блоков">
            <span>Проверить на макете:</span>
            <button
              type="button"
              className="btn btn--outline btn--compact"
              onClick={() => {
                setBlocks(preset());
                setNotice('Восстановлены 4 стандартных блока');
              }}
            >
              4 блока
            </button>
            <button
              type="button"
              className="btn btn--outline btn--compact"
              onClick={() => {
                setBlocks(preset(true));
                setNotice('Загружены 8 блоков, включая сохранённый список и широкий блок');
              }}
            >
              8 блоков
            </button>
            <button
              type="button"
              className={`btn btn--compact ${empty ? 'btn--primary' : 'btn--ghost'}`}
              aria-pressed={empty}
              onClick={() => setEmpty(!empty)}
            >
              Без данных
            </button>
          </div>
          <span className={context.snapshot}>Демонстрационные данные · 14 октября 2026</span>
        </div>
        <div className={`${workspace.shell} ${context.frame} ${s.frame}`}>
          <aside className={context.sidebar} aria-label="Контекст рабочего пространства">
            <div className={context.sidebarBrand}>
              <span className={s.brandIcon}>
                <WorkspaceIcon name="house" />
              </span>
              <strong>Домовой</strong>
            </div>
            <p className={context.sidebarCaption}>Рабочее пространство</p>
            <ul>
              {navigation.map((item) => (
                <li
                  key={item.label}
                  className={context.contextNav}
                  data-active={item.label === 'Персонал'}
                >
                  <WorkspaceIcon name={item.icon} />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
            <div className={context.sidebarFoot}>
              <WorkspaceIcon name="info" />
              <span>
                Макет раздела
                <br />
                Для сравнения дизайна
              </span>
            </div>
          </aside>
          <div className={context.workspace}>
            <div className={context.topbar}>
              <span>
                Рабочее пространство <span aria-hidden="true">/</span>
                <strong>Персонал</strong>
              </span>
              <span className={context.contextBadge}>Предпросмотр</span>
            </div>
            <div className={s.content}>
              <div className={s.pageHead}>
                <div>
                  <span className={s.eyebrow}>Люди и их история</span>
                  <h2>Персонал</h2>
                  <p>Проживание, вахты и контакты — в одном месте.</p>
                </div>
                <button
                  type="button"
                  className="btn btn--primary btn--compact"
                  disabled={blocks.length >= 20}
                  onClick={add}
                  data-testid="add-personnel-block"
                >
                  <Icon name="plus" />
                  Добавить блок
                </button>
              </div>
              <div className={s.tabs} aria-label="Разделы персонала">
                <span aria-current="page">Рабочая поверхность</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setDetail({ title: 'Сотрудники' })}
                >
                  Сотрудники
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    setDetail({ title: 'План заездов', block: { ...preset()[0], limit: 20 } })
                  }
                >
                  План заездов
                </button>
              </div>
              <div className={s.toolbar}>
                <label>
                  <span className={s.srOnly}>Общежитие</span>
                  <select value={dorm} onChange={(event) => setDorm(Number(event.target.value))}>
                    <option value={0}>Все общежития</option>
                    {dorms.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Вахты на
                  <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                    {[5, 7, 14, 30].map((value) => (
                      <option key={value} value={value}>
                        {value} дней
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={`btn btn--compact ${editing ? 'btn--primary' : 'btn--outline'}`}
                  aria-pressed={editing}
                  onClick={() => setEditing(!editing)}
                  data-testid="configure-personnel"
                >
                  <Icon name="settings" />
                  {editing ? 'Готово' : 'Настроить'}
                </button>
              </div>
              <div className={s.summaryLine}>
                <span>
                  <i />
                  <strong>{residents}</strong> проживают сейчас
                </span>
                <span>
                  <Icon name="ending" />
                  <strong>{ending}</strong> заканчивают вахту за {days} дн.
                </span>
                <span className={s.blockCount}>{blocks.length} / 20 блоков</span>
              </div>
              {editing && (
                <p className={s.configureHint}>
                  Меняйте порядок стрелками, растягивайте блоки и добавляйте новые. Настройки
                  одинаковы во всех пяти вариантах.
                </p>
              )}
              <div className={s.variants}>
                {(all ? [1, 2, 3, 4, 5] : [active]).map((design) => (
                  <section
                    key={design}
                    className={s.variant}
                    data-variant={design}
                    aria-labelledby={`personnel-variant-${design}`}
                  >
                    <div className={s.variantTitle}>
                      <span>0{design}</span>
                      <h3 id={`personnel-variant-${design}`}>{designs[design - 1].name}</h3>
                      <p>{designs[design - 1].note}</p>
                    </div>
                    <div className={s.grid}>
                      {blocks.map((block, index) => (
                        <Widget
                          key={block.id}
                          block={block}
                          index={index}
                          count={blocks.length}
                          design={design}
                          dorm={dorm}
                          empty={empty}
                          editing={editing}
                          onEdit={() => setEditor({ block, adding: false })}
                          onMove={(step) => move(block.id, step)}
                          onRemove={() => {
                            setBlocks((current) => current.filter((item) => item.id !== block.id));
                            setNotice(`Удалён блок «${block.title}»`);
                          }}
                          onWide={() =>
                            setBlocks((current) =>
                              current.map((item) =>
                                item.id === block.id ? { ...item, wide: !item.wide } : item,
                              ),
                            )
                          }
                          onOpen={() => setDetail({ title: block.title, block })}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      className={s.addTile}
                      disabled={blocks.length >= 20}
                      onClick={add}
                    >
                      <span>
                        <Icon name="plus" />
                      </span>
                      <strong>
                        {blocks.length >= 20 ? 'Добавлено 20 блоков' : 'Добавьте свой блок'}
                      </strong>
                      <span>
                        {blocks.length >= 20
                          ? 'Удалите один из блоков, чтобы добавить новый'
                          : 'Список, контакты или отдельное общежитие'}
                      </span>
                      <img src={plant} alt="" />
                    </button>
                  </section>
                ))}
              </div>
            </div>
          </div>
        </div>
        <p className={s.previewFoot}>
          Изменения в этой примерочной не затрагивают рабочие данные. Добавленные блоки сохраняются
          при переключении вариантов до перезагрузки страницы.
        </p>
        <p className={s.srOnly} role="status">
          {notice}
        </p>
      </main>
      {editor && (
        <BlockEditor
          initial={editor.block}
          adding={editor.adding}
          onClose={() => setEditor(null)}
          onSave={(block) => {
            setBlocks((current) =>
              editor.adding
                ? current.length < 20
                  ? [...current, block]
                  : current
                : current.map((item) => (item.id === block.id ? block : item)),
            );
            setNotice(`Блок «${block.title}» ${editor.adding ? 'добавлен' : 'изменён'}`);
            setEditor(null);
          }}
        />
      )}
      {detail && (
        <Modal
          title={detail.title}
          testId="personnel-preview-detail"
          onClose={() => setDetail(null)}
          panelClassName={s.editorPanel}
        >
          <div className={s.detail}>
            <p>Демонстрационный список для проверки макета.</p>
            <Rows
              block={detail.block ?? { ...preset()[3], limit: 20 }}
              data={snapshot(detail.block ?? { ...preset()[3], limit: 20 }, dorm, empty)}
              showAll
            />
            <button
              type="button"
              className="btn btn--primary btn--compact"
              onClick={() => setDetail(null)}
            >
              Вернуться к макету
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
