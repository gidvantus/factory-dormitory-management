import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { WorkspaceIcon } from '../workspace/WorkspaceIcon';
import styles from './DormitoryDesignPreview.module.css';

type Kind = 'text' | 'number' | 'date' | 'select' | 'checkbox';
type Column = { id: string; name: string; kind: Kind; options?: string };
type Tab = { id: string; name: string; parent?: string; hidden?: boolean; columns: Column[] };
type Row = { id: number; values: Record<string, string> };
type Rule = { name: string; source: string; column: string; value: string; date: string };
const kinds: Record<Kind, string> = {
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  select: 'Список',
  checkbox: 'Чекбокс',
};
const column = (id: string, name: string, kind: Kind = 'text', options?: string): Column => ({
  id,
  name,
  kind,
  options,
});
const initialTabs: Tab[] = [
  { id: 'report', name: 'Общий отчёт', columns: [] },
  {
    id: 'places',
    name: 'Размещение персонала',
    columns: [
      column('building', 'Корпус'),
      column('paid', 'Оплачено', 'number'),
      column('occupied', 'Проживает', 'number'),
    ],
  },
  {
    id: 'residents',
    name: 'Проживающие',
    columns: [
      column('name', 'ФИО'),
      column('number', 'Т/н'),
      column('gender', 'Пол', 'select', 'М; Ж'),
      column('arrival', 'Дата заселения', 'date'),
      column('building', 'Корпус', 'select', 'Корпус А; Корпус Б'),
      column('phone', 'Телефон'),
    ],
  },
  { id: 'movement', name: 'Движение персонала', columns: [] },
  {
    id: 'inflow',
    name: 'Приток',
    parent: 'movement',
    columns: [
      column('name', 'ФИО'),
      column('arrival', 'Дата заселения', 'date'),
      column('number', 'Т/н'),
    ],
  },
  {
    id: 'outflow',
    name: 'Отток',
    parent: 'movement',
    columns: [
      column('name', 'ФИО'),
      column('reason', 'Причина', 'select', 'Сбежал; Завершил вахту; Уволился'),
      column('departure', 'Дата выезда', 'date'),
    ],
  },
  { id: 'payments', name: 'Выплаты', columns: [] },
  {
    id: 'advance',
    name: 'На аванс',
    parent: 'payments',
    columns: [column('name', 'ФИО'), column('amount', 'Сумма', 'number')],
  },
  {
    id: 'settlement',
    name: 'На расчёт',
    parent: 'payments',
    columns: [column('name', 'ФИО'), column('date', 'Дата расчёта', 'date')],
  },
  {
    id: 'documents',
    name: 'Документы',
    columns: [
      column('name', 'ФИО'),
      column('document', 'Документ', 'select', 'Паспорт; Медкнижка'),
      column('valid', 'Действителен до', 'date'),
    ],
  },
  { id: 'archive', name: 'Архив', hidden: true, columns: [column('name', 'ФИО')] },
];
function sampleRows(): Record<string, Row[]> {
  return {
    residents: [
      'Романов Алексей Сергеевич',
      'Соколова Анна Дмитриевна',
      'Ковалёв Дмитрий Игоревич',
      'Морозова Елена Андреевна',
      'Волков Сергей Николаевич',
      'Орлова Мария Павловна',
      'Лебедев Иван Олегович',
      'Новикова Дарья Романовна',
    ].map((name, index) => ({
      id: index + 1,
      values: {
        name,
        number: String(1042 + index * 3),
        gender: index % 2 ? 'Ж' : 'М',
        arrival: `2026-10-0${index + 1}`,
        building: index % 3 ? 'Корпус А' : 'Корпус Б',
        phone: '+7 (900) 000-00-00',
      },
    })),
    outflow: [1, 2, 3].map((id) => ({
      id,
      values: {
        name: ['Белов Андрей', 'Петров Максим', 'Смирнов Николай'][id - 1],
        reason: 'Сбежал',
        departure: '2026-10-08',
      },
    })),
    inflow: [
      {
        id: 1,
        values: { name: 'Иванов Михаил Александрович', arrival: '2026-10-09', number: '1078' },
      },
    ],
    documents: [
      {
        id: 1,
        values: { name: 'Романов Алексей Сергеевич', document: 'Паспорт', valid: '2030-05-12' },
      },
    ],
  };
}
const initialRule: Rule = {
  name: 'Сбежал',
  source: 'outflow',
  column: 'reason',
  value: 'Сбежал',
  date: 'departure',
};
const cloneTabs = (): Tab[] => structuredClone(initialTabs);

function Icon({
  name,
}: {
  name:
    | 'settings'
    | 'plus'
    | 'close'
    | 'check'
    | 'search'
    | 'columns'
    | 'link'
    | 'template'
    | 'tree'
    | 'info';
}): JSX.Element {
  const paths: Record<string, ReactNode> = {
    settings: (
      <>
        <path d="m9 3-1 3-3 1-2 3 2 3v4l3 2 3-1 3 1 3-2v-4l2-3-2-3-3-1-1-3Z" />
        <circle cx="11" cy="11" r="3" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    columns: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M9 4v16M15 4v16M3 9h18" />
      </>
    ),
    link: (
      <>
        <path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
      </>
    ),
    template: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    tree: (
      <>
        <rect x="3" y="3" width="7" height="5" rx="1" />
        <rect x="13" y="11" width="8" height="5" rx="1" />
        <path d="M6 8v12h7M6 13h7" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7h.01" />
      </>
    ),
  };
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function PreviewDialog({
  children,
  title,
  subtitle,
  wide,
  onClose,
  footer,
}: {
  children: ReactNode;
  title: string;
  subtitle: string;
  wide?: boolean;
  onClose: () => void;
  footer?: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.body.style.overflow;
    const trigger = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const panel = ref.current;
    panel?.querySelector<HTMLElement>('button')?.focus();
    function key(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
        ) || [],
      ).filter((node) => node.getClientRects().length);
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', key);
      trigger?.focus();
    };
  }, []);
  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`${styles.dialog} ${wide ? styles.wide : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>ДЕМОНСТРАЦИЯ / НАСТРОЙКИ</span>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className={styles.iconButton} onClick={onClose} aria-label="Закрыть окно">
            <Icon name="close" />
          </button>
        </header>
        {children}
        {footer && <footer className={styles.dialogFooter}>{footer}</footer>}
      </div>
    </div>
  );
}

export function DormitoryDesignPreview(): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(cloneTabs);
  const [rows, setRows] = useState(sampleRows);
  const [active, setActive] = useState('residents');
  const [name, setName] = useState('Северное');
  const [client, setClient] = useState('Стройкомплект');
  const [search, setSearch] = useState('');
  const [gender, setGender] = useState('');
  const [settings, setSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<'structure' | 'links' | 'templates'>(
    'structure',
  );
  const [draft, setDraft] = useState<Tab[]>(cloneTabs);
  const [selected, setSelected] = useState('residents');
  const [rule, setRule] = useState<Rule>(initialRule);
  const [draftRule, setDraftRule] = useState<Rule>(initialRule);
  const [notice, setNotice] = useState('');
  const [actions, setActions] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createMode, setCreateMode] = useState<'manual' | 'sample'>('manual');
  const [newName, setNewName] = useState('');
  const [newClient, setNewClient] = useState('Стройкомплект');
  const [createSample, setCreateSample] = useState('north');
  const [picked, setPicked] = useState<string[]>(
    initialTabs.filter((tab) => !tab.hidden).map((tab) => tab.id),
  );
  const [newTabName, setNewTabName] = useState('');
  const [newTabParent, setNewTabParent] = useState('');
  const [addingTab, setAddingTab] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const current = tabs.find((tab) => tab.id === active) || tabs[0];
  const editor = draft.find((tab) => tab.id === selected) || draft[0];
  const parent = tabs.find((tab) => tab.id === current?.parent);
  const children = tabs.filter((tab) => tab.parent === (parent?.id || current?.id) && !tab.hidden);
  const shownRows = (rows[current?.id] || []).filter(
    (row) =>
      Object.values(row.values).some((value) =>
        value.toLowerCase().includes(search.toLowerCase()),
      ) &&
      (!gender || row.values.gender === gender),
  );
  const rootId = parent?.id || current?.id;
  const source = draft.find((tab) => tab.id === draftRule.source);
  const ruleSource = tabs.find((tab) => tab.id === rule.source);
  const ruleCount = (rows[rule.source] || []).filter(
    (row) => row.values[rule.column] === rule.value,
  ).length;
  function openSettings(page: typeof settingsPage = 'structure'): void {
    setDraft(structuredClone(tabs));
    setDraftRule({ ...rule });
    setSelected(current?.columns.length ? current.id : 'residents');
    setSettingsPage(page);
    setAddingTab(false);
    setSettings(true);
  }
  function editTab(patch: Partial<Tab>): void {
    setDraft((items) => items.map((tab) => (tab.id === editor.id ? { ...tab, ...patch } : tab)));
  }
  function editColumn(id: string, patch: Partial<Column>): void {
    editTab({ columns: editor.columns.map((col) => (col.id === id ? { ...col, ...patch } : col)) });
  }
  function save(): void {
    setTabs(draft);
    setRule(draftRule);
    if (!draft.some((tab) => tab.id === active && !tab.hidden))
      setActive(draft.find((tab) => !tab.hidden && !tab.parent)?.id || '');
    setSettings(false);
    setNotice('Настройки применены к демонстрационной странице');
  }
  function reset(): void {
    setTabs(cloneTabs());
    setDraft(cloneTabs());
    setRows(sampleRows());
    setActive('residents');
    setName('Северное');
    setClient('Стройкомплект');
    setSavedTemplate(false);
    setRule(initialRule);
    setSearch('');
    setGender('');
    setSettings(false);
    setNotice('Макет возвращён к исходному виду');
  }
  function labelFor(items: Tab[], tab?: Tab): string {
    return tab?.parent
      ? `${items.find((item) => item.id === tab.parent)?.name} → ${tab.name}`
      : tab?.name || '';
  }
  function go(id: string): void {
    const target = tabs.find((tab) => tab.id === id);
    setActive(
      target?.columns.length || id === 'report'
        ? id
        : tabs.find((tab) => tab.parent === id && !tab.hidden)?.id || id,
    );
    setSearch('');
    setGender('');
    setActions(null);
  }
  function moveColumn(index: number, offset: number): void {
    const columns = [...editor.columns];
    [columns[index], columns[index + offset]] = [columns[index + offset], columns[index]];
    editTab({ columns });
  }
  function addTab(): void {
    if (!newTabName.trim()) return;
    const id = `tab-${Date.now()}`;
    setDraft((items) => [
      ...items,
      { id, name: newTabName.trim(), parent: newTabParent || undefined, columns: [] },
    ]);
    setSelected(id);
    setNewTabName('');
    setAddingTab(false);
  }
  function createDormitory(): void {
    if (!newName.trim() || !picked.length) return;
    setName(newName.trim());
    setClient(newClient.trim() || 'Стройкомплект');
    setTabs(
      initialTabs
        .filter((tab) => picked.includes(tab.id))
        .map((tab) => ({
          ...structuredClone(tab),
          hidden: false,
          parent: picked.includes(tab.parent || '') ? tab.parent : undefined,
        })),
    );
    setRows({});
    setActive(picked.includes('residents') ? 'residents' : picked[0]);
    setCreating(false);
    setNotice('Демонстрационное общежитие создано с пустыми таблицами');
  }
  function chooseSample(sample: string): void {
    setCreateSample(sample);
    setPicked(
      sample === 'staff'
        ? ['residents', 'movement', 'inflow', 'outflow', 'documents']
        : initialTabs.filter((tab) => !tab.hidden).map((tab) => tab.id),
    );
  }

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <Link to="/" className={styles.brand}>
          <span>
            <WorkspaceIcon name="house" />
          </span>
          Домовой
        </Link>
        <p className={styles.brandCaption}>
          Учёт проживающих
          <br />в общежитиях
        </p>
        <span className={styles.navCaption}>РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <button
          className={styles.sideLink}
          onClick={() => setNotice('В этом макете показана работа с общежитием')}
        >
          <WorkspaceIcon name="overview" />
          Обзор
        </button>
        <button
          className={`${styles.sideLink} ${styles.sideActive}`}
          onClick={() => go('residents')}
        >
          <WorkspaceIcon name="house" />
          Общежития<span>8</span>
        </button>
        <button className={styles.sideLink} onClick={() => openSettings('templates')}>
          <Icon name="template" />
          Шаблоны
        </button>
        <div className={styles.sidebarBottom}>
          <span className={styles.avatar}>АС</span>
          <div>
            <strong>Администратор</strong>
            <small>Демонстрационный режим</small>
          </div>
        </div>
      </aside>
      <div className={styles.workspace}>
        <div className={styles.previewBar}>
          <span>
            <span className={styles.liveDot} />
            Тестовая страница <b>·</b> новый вариант интерфейса
          </span>
          <button onClick={reset}>Сбросить макет ↺</button>
        </div>
        <div className={styles.breadcrumb}>
          <Link to="/cabinet/dormitories">Общежития</Link>
          <span>›</span>
          <strong>{name}</strong>
          <span className={styles.demoLabel}>Демо-данные</span>
        </div>
        <main className={styles.main}>
          <header className={styles.heading}>
            <div>
              <span className={styles.eyebrow}>КЛИЕНТ · {client.toLocaleUpperCase('ru')}</span>
              <h1>
                {name}
                <span className={styles.activeBadge}>Активно</span>
              </h1>
              <p>Управление проживанием и движением персонала</p>
            </div>
            <div className={styles.headerActions}>
              <button
                className={styles.secondary}
                onClick={() => {
                  setNewName('');
                  setCreating(true);
                }}
              >
                <Icon name="plus" />
                Общежитие
              </button>
              <button className={styles.settingsButton} onClick={() => openSettings()}>
                <Icon name="settings" />
                Настроить
              </button>
            </div>
          </header>
          <nav className={styles.tabs} aria-label="Вкладки демонстрационного общежития">
            {tabs
              .filter((tab) => !tab.parent && !tab.hidden)
              .map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => go(tab.id)}
                  className={rootId === tab.id ? styles.activeTab : ''}
                  aria-current={rootId === tab.id ? 'page' : undefined}
                >
                  {tab.name}
                  {tab.id === 'residents' && <span>{(rows.residents || []).length}</span>}
                </button>
              ))}
          </nav>
          {!!children.length && (
            <nav className={styles.subtabs} aria-label="Подвкладки">
              {parent?.columns.length && (
                <button onClick={() => go(parent.id)}>Основная таблица</button>
              )}
              {children.map((tab) => (
                <button
                  className={active === tab.id ? styles.subActive : ''}
                  key={tab.id}
                  onClick={() => go(tab.id)}
                >
                  {tab.name}
                </button>
              ))}
            </nav>
          )}
          {current?.id === 'report' ? (
            <>
              <div className={styles.tableHeading}>
                <div>
                  <h2>Общий отчёт</h2>
                  <p>Октябрь 2026 · показатели за каждый день</p>
                </div>
                <button className={styles.secondary} onClick={() => openSettings('links')}>
                  <Icon name="link" />
                  Связи отчёта
                </button>
              </div>
              <div className={styles.ruleSummary}>
                <span className={styles.ruleIcon}>
                  <Icon name="link" />
                </span>
                <div>
                  <strong>{rule.name}</strong>
                  <p>
                    Считать записи из «{labelFor(tabs, ruleSource)}», где «
                    {ruleSource?.columns.find((col) => col.id === rule.column)?.name || 'Причина'}»
                    = «{rule.value}», по выбранной дате.
                  </p>
                </div>
                <button className={styles.textButton} onClick={() => openSettings('links')}>
                  Изменить связь ↗
                </button>
              </div>
              <div className={styles.tableScroll}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Показатель</th>
                      {['05', '06', '07', '08', '09', '10', '11'].map((day) => (
                        <th key={day}>{day} окт</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {['Выход Итого', 'Проживает', 'Оплачено', rule.name].map((item, index) => (
                      <tr key={item}>
                        <td>
                          <strong>{item}</strong>
                          {index === 3 && (
                            <small>
                              <Icon name="link" />
                              Связь с таблицей
                            </small>
                          )}
                        </td>
                        {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                          <td key={day}>
                            {index === 3 ? (day === 3 ? ruleCount : 0) : [16, 8, 24][index]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <div className={styles.tableHeading}>
                <div>
                  <h2>
                    {current?.name || 'Выберите вкладку'}
                    <span>{shownRows.length} записей</span>
                  </h2>
                  <p>
                    {current?.id === 'residents'
                      ? 'Все проживающие в общежитии на текущий момент'
                      : 'Записи выбранной таблицы'}
                  </p>
                </div>
                <button
                  className={styles.primary}
                  disabled={!current?.columns.length}
                  onClick={() => {
                    setRows((items) => ({
                      ...items,
                      [active]: [
                        ...(items[active] || []),
                        { id: Date.now(), values: { name: 'Новый сотрудник' } },
                      ],
                    }));
                    setNotice('Добавлена демонстрационная строка');
                  }}
                >
                  <Icon name="plus" />
                  Добавить строку
                </button>
              </div>
              <div className={styles.toolbar}>
                <label className={styles.search}>
                  <Icon name="search" />
                  <input
                    aria-label="Поиск по таблице"
                    placeholder="Найти сотрудника или табельный номер"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                {current?.id === 'residents' && (
                  <select
                    aria-label="Пол"
                    value={gender}
                    onChange={(event) => setGender(event.target.value)}
                  >
                    <option value="">Любой пол</option>
                    <option>М</option>
                    <option>Ж</option>
                  </select>
                )}
                <span className={styles.saved}>
                  <Icon name="check" />
                  Демо-данные
                </span>
              </div>
              {current?.columns.length ? (
                <div className={styles.tableScroll}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th className={styles.rowNumber}>№</th>
                        {current.columns.map((col) => (
                          <th key={col.id}>{col.name}</th>
                        ))}
                        <th aria-label="Действия" />
                      </tr>
                    </thead>
                    <tbody>
                      {shownRows.map((row, index) => (
                        <tr key={row.id}>
                          <td className={styles.rowNumber}>{index + 1}</td>
                          {current.columns.map((col) => (
                            <td key={col.id} className={col.id === 'name' ? styles.personName : ''}>
                              {col.id === 'name' ? (
                                <>
                                  <span className={styles.personAvatar}>
                                    {(row.values.name || 'Н')
                                      .split(' ')
                                      .slice(0, 2)
                                      .map((word) => word[0])
                                      .join('')}
                                  </span>
                                  {row.values[col.id]}
                                </>
                              ) : col.id === 'gender' && row.values[col.id] ? (
                                <span className={styles.gender}>{row.values[col.id]}</span>
                              ) : col.kind === 'date' && row.values[col.id] ? (
                                row.values[col.id].split('-').reverse().join('.')
                              ) : (
                                row.values[col.id] || <span className={styles.emptyValue}>—</span>
                              )}
                            </td>
                          ))}
                          <td className={styles.rowAction}>
                            <button
                              className={styles.iconButton}
                              aria-label={`Действия: ${row.values.name}`}
                              aria-expanded={actions === row.id}
                              onClick={() => setActions(actions === row.id ? null : row.id)}
                            >
                              •••
                            </button>
                            {actions === row.id && (
                              <div className={styles.actionMenu}>
                                {[
                                  'Записать на аванс',
                                  'Записать на расчёт',
                                  'Перевести',
                                  'В отток',
                                ].map((action) => (
                                  <button
                                    key={action}
                                    onClick={() => {
                                      setActions(null);
                                      setNotice(
                                        `${action}: демонстрация действия для ${row.values.name}`,
                                      );
                                    }}
                                  >
                                    {action}
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!shownRows.length && (
                    <div className={styles.empty}>
                      <Icon name="columns" />
                      <h3>Пока нет записей</h3>
                      <p>Структура готова. Можно добавить первую строку.</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className={styles.empty}>
                  <Icon name="columns" />
                  <h3>Начните с настройки таблицы</h3>
                  <p>Добавьте нужные столбцы в общем конструкторе.</p>
                  <button className={styles.secondary} onClick={() => openSettings()}>
                    Настроить таблицу
                  </button>
                </div>
              )}
              <div className={styles.tableFooter}>
                <span>
                  Показано {shownRows.length} из {(rows[active] || []).length} записей
                </span>
                <span>
                  Столбцы и вкладки — в разделе «Настроить» <Icon name="settings" />
                </span>
              </div>
            </>
          )}
          <div className={styles.previewNote}>
            <Icon name="info" />
            <span>
              Это интерактивный макет. Изменения доступны только на этой странице и сбрасываются при
              её обновлении.
            </span>
          </div>
        </main>
      </div>
      {notice && (
        <div className={styles.toast} role="status">
          <Icon name="check" />
          {notice}
          <button
            className={styles.iconButton}
            onClick={() => setNotice('')}
            aria-label="Скрыть сообщение"
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {settings && (
        <PreviewDialog
          title="Настройки общежития"
          subtitle="Вкладки, столбцы и связи — в одном месте"
          wide
          onClose={() => setSettings(false)}
          footer={
            <>
              <span className={styles.footerHint}>Изменения применятся после сохранения</span>
              <button className={styles.secondary} onClick={() => setSettings(false)}>
                Отмена
              </button>
              <button className={styles.primary} onClick={save}>
                <Icon name="check" />
                Сохранить изменения
              </button>
            </>
          }
        >
          <nav className={styles.settingsTabs} aria-label="Разделы настройки">
            {(
              [
                ['structure', 'tree', 'Вкладки и таблицы'],
                ['links', 'link', 'Связи отчёта'],
                ['templates', 'template', 'Шаблоны'],
              ] as const
            ).map(([id, icon, label]) => (
              <button
                key={id}
                className={settingsPage === id ? styles.settingsTabActive : ''}
                onClick={() => setSettingsPage(id)}
                aria-pressed={settingsPage === id}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </nav>
          {settingsPage === 'structure' && (
            <div className={styles.constructorLayout}>
              <aside className={styles.tree}>
                <div className={styles.treeHeading}>
                  <span>СТРУКТУРА ОБЩЕЖИТИЯ</span>
                  <span>{draft.length}</span>
                </div>
                {draft
                  .filter((tab) => !tab.parent)
                  .map((tab) => (
                    <div key={tab.id}>
                      <button
                        className={`${styles.treeItem} ${selected === tab.id ? styles.treeSelected : ''}`}
                        onClick={() => setSelected(tab.id)}
                      >
                        <Icon name={tab.id === 'report' ? 'link' : 'columns'} />
                        <span>{tab.name}</span>
                        {tab.hidden && <small>Скрыта</small>}
                      </button>
                      {draft
                        .filter((child) => child.parent === tab.id)
                        .map((child) => (
                          <button
                            key={child.id}
                            className={`${styles.treeItem} ${styles.treeChild} ${selected === child.id ? styles.treeSelected : ''}`}
                            onClick={() => setSelected(child.id)}
                          >
                            <span className={styles.branch}>└</span>
                            <span>{child.name}</span>
                            {child.hidden && <small>Скрыта</small>}
                          </button>
                        ))}
                    </div>
                  ))}
                <button
                  className={styles.addTree}
                  onClick={() => {
                    setAddingTab(true);
                    setNewTabParent('');
                  }}
                >
                  <Icon name="plus" />
                  Добавить вкладку
                </button>
              </aside>
              <section className={styles.editor}>
                {addingTab ? (
                  <>
                    <span className={styles.eyebrow}>НОВАЯ ВКЛАДКА</span>
                    <h3>Добавить в структуру</h3>
                    <label className={styles.field}>
                      Название
                      <input
                        value={newTabName}
                        onChange={(event) => setNewTabName(event.target.value)}
                        placeholder="Например, Медосмотры"
                        maxLength={80}
                      />
                    </label>
                    <label className={styles.field}>
                      Где разместить
                      <select
                        value={newTabParent}
                        onChange={(event) => setNewTabParent(event.target.value)}
                      >
                        <option value="">Самостоятельная вкладка</option>
                        {draft
                          .filter((tab) => !tab.parent)
                          .map((tab) => (
                            <option key={tab.id} value={tab.id}>
                              Внутри «{tab.name}»
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className={styles.inlineActions}>
                      <button className={styles.secondary} onClick={() => setAddingTab(false)}>
                        Отмена
                      </button>
                      <button
                        className={styles.primary}
                        disabled={!newTabName.trim()}
                        onClick={addTab}
                      >
                        Добавить
                      </button>
                    </div>
                  </>
                ) : (
                  editor && (
                    <>
                      <div className={styles.editorHeading}>
                        <div>
                          <span className={styles.eyebrow}>
                            {editor.parent ? 'ПОДВКЛАДКА' : 'ВКЛАДКА'}
                          </span>
                          <h3>{editor.name}</h3>
                        </div>
                        <button
                          className={styles.textButton}
                          onClick={() => {
                            setNewTabParent(editor.parent || editor.id);
                            setAddingTab(true);
                          }}
                        >
                          + Подвкладка
                        </button>
                      </div>
                      <label className={styles.field}>
                        Название вкладки
                        <input
                          value={editor.name}
                          maxLength={80}
                          onChange={(event) => editTab({ name: event.target.value })}
                        />
                      </label>
                      {editor.id === 'report' ? (
                        <div className={styles.empty}>
                          <Icon name="link" />
                          <h3>Показатели и связи отчёта</h3>
                          <p>Правила подсчёта собраны в отдельном разделе настроек.</p>
                          <button
                            className={styles.secondary}
                            onClick={() => setSettingsPage('links')}
                          >
                            Перейти к связям
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className={styles.columnsHeading}>
                            <h4>
                              Столбцы таблицы <span>{editor.columns.length}</span>
                            </h4>
                            <p>Настройте весь список и сохраните одним действием</p>
                          </div>
                          <div className={styles.columnLabels}>
                            <span>Порядок</span>
                            <span>Название столбца</span>
                            <span>Формат</span>
                            <span />
                          </div>
                          {editor.columns.map((col, index) => (
                            <div className={styles.columnBlock} key={col.id}>
                              <div className={styles.columnRow}>
                                <div className={styles.order}>
                                  <span>{index + 1}</span>
                                  <div>
                                    <button
                                      aria-label={`Поднять ${col.name}`}
                                      disabled={!index}
                                      onClick={() => moveColumn(index, -1)}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      aria-label={`Опустить ${col.name}`}
                                      disabled={index === editor.columns.length - 1}
                                      onClick={() => moveColumn(index, 1)}
                                    >
                                      ↓
                                    </button>
                                  </div>
                                </div>
                                <input
                                  aria-label={`Название столбца ${index + 1}`}
                                  value={col.name}
                                  onChange={(event) =>
                                    editColumn(col.id, { name: event.target.value })
                                  }
                                />
                                <select
                                  aria-label={`Формат столбца ${index + 1}`}
                                  value={col.kind}
                                  onChange={(event) =>
                                    editColumn(col.id, { kind: event.target.value as Kind })
                                  }
                                >
                                  {Object.entries(kinds).map(([key, label]) => (
                                    <option key={key} value={key}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className={styles.iconButton}
                                  aria-label={`Убрать столбец ${col.name}`}
                                  disabled={
                                    draftRule.source === editor.id &&
                                    [draftRule.column, draftRule.date].includes(col.id)
                                  }
                                  title={
                                    draftRule.source === editor.id &&
                                    [draftRule.column, draftRule.date].includes(col.id)
                                      ? 'Столбец используется в связи отчёта'
                                      : undefined
                                  }
                                  onClick={() =>
                                    editTab({
                                      columns: editor.columns.filter((item) => item.id !== col.id),
                                    })
                                  }
                                >
                                  <Icon name="close" />
                                </button>
                              </div>
                              {col.kind === 'select' && (
                                <label className={styles.optionsField}>
                                  Варианты списка
                                  <input
                                    aria-label={`Варианты списка ${col.name}`}
                                    value={col.options || ''}
                                    placeholder="Через точку с запятой: М; Ж"
                                    onChange={(event) =>
                                      editColumn(col.id, { options: event.target.value })
                                    }
                                  />
                                </label>
                              )}
                            </div>
                          ))}
                          {!editor.columns.length && (
                            <p className={styles.help}>
                              Таблица пока не создана. Добавьте её первые столбцы.
                            </p>
                          )}
                          <button
                            className={styles.addColumn}
                            onClick={() =>
                              editTab({
                                columns: [
                                  ...editor.columns,
                                  column(`column-${Date.now()}`, 'Новый столбец'),
                                ],
                              })
                            }
                          >
                            <Icon name="plus" />
                            Добавить столбец
                          </button>
                        </>
                      )}
                      <div className={styles.availability}>
                        <div>
                          <h4>Доступность вкладки</h4>
                          <p>
                            {editor.hidden
                              ? 'Скрыта. Данные продолжат учитываться в отчётах.'
                              : 'Видна в общежитии, доступна для заполнения.'}
                          </p>
                        </div>
                        <select
                          aria-label="Доступность вкладки"
                          value={editor.hidden ? 'hidden' : 'active'}
                          onChange={(event) => editTab({ hidden: event.target.value === 'hidden' })}
                        >
                          <option value="active">Активна</option>
                          <option value="hidden">Скрыта · только просмотр</option>
                        </select>
                      </div>
                      <div className={styles.deleteRow}>
                        <p>
                          {(rows[editor.id] || []).length
                            ? `Есть ${(rows[editor.id] || []).length} записей. Можно скрыть, удаление недоступно.`
                            : 'Удаление доступно только для пустой вкладки без связей.'}
                        </p>
                        <button
                          className={styles.dangerButton}
                          disabled={
                            !!(rows[editor.id] || []).length ||
                            editor.id === 'report' ||
                            draftRule.source === editor.id ||
                            draft.some((tab) => tab.parent === editor.id)
                          }
                          onClick={() => {
                            setDraft((items) => items.filter((tab) => tab.id !== editor.id));
                            setSelected(draft.find((tab) => tab.id !== editor.id)?.id || '');
                          }}
                        >
                          Удалить вкладку
                        </button>
                      </div>
                    </>
                  )
                )}
              </section>
            </div>
          )}
          {settingsPage === 'links' && (
            <section className={styles.linksEditor}>
              <div className={styles.sectionIntro}>
                <span className={styles.eyebrow}>АВТОМАТИЧЕСКИЙ ПОДСЧЁТ</span>
                <h3>От записи в таблице — к показателю в отчёте</h3>
                <p>
                  Выберите источник, условие и дату. Ниже сразу видно, как будет работать правило.
                </p>
              </div>
              <div className={styles.linkForm}>
                <label className={styles.field}>
                  Строка общего отчёта
                  <input
                    value={draftRule.name}
                    onChange={(event) => setDraftRule({ ...draftRule, name: event.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  Таблица-источник
                  <select
                    value={draftRule.source}
                    onChange={(event) => {
                      const next = draft.find((tab) => tab.id === event.target.value);
                      setDraftRule({
                        ...draftRule,
                        source: event.target.value,
                        column: next?.columns.find((col) => col.kind !== 'date')?.id || '',
                        date: next?.columns.find((col) => col.kind === 'date')?.id || '',
                        value: '',
                      });
                    }}
                  >
                    {draft
                      .filter((tab) => tab.columns.length && tab.id !== 'places')
                      .map((tab) => (
                        <option key={tab.id} value={tab.id}>
                          {labelFor(draft, tab)}
                          {tab.hidden ? ' · скрыта' : ''}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={styles.field}>
                  Столбец для проверки
                  <select
                    value={draftRule.column}
                    onChange={(event) =>
                      setDraftRule({ ...draftRule, column: event.target.value, value: '' })
                    }
                  >
                    {source?.columns.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  Равно значению
                  <input
                    value={draftRule.value}
                    onChange={(event) => setDraftRule({ ...draftRule, value: event.target.value })}
                    placeholder="Например, Сбежал"
                  />
                </label>
                <label className={styles.field}>
                  Распределять по дате
                  <select
                    value={draftRule.date}
                    onChange={(event) => setDraftRule({ ...draftRule, date: event.target.value })}
                  >
                    <option value="">Дата создания записи</option>
                    {source?.columns
                      .filter((col) => col.kind === 'date')
                      .map((col) => (
                        <option key={col.id} value={col.id}>
                          {col.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <div className={styles.rulePreview}>
                <span>
                  <Icon name="link" />
                  Как будет считаться
                </span>
                <p>
                  В строке <strong>«{draftRule.name || 'Новый показатель'}»</strong> считать записи
                  из <strong>«{labelFor(draft, source)}»</strong>, где{' '}
                  <strong>
                    «{source?.columns.find((col) => col.id === draftRule.column)?.name}» = «
                    {draftRule.value || '…'}»
                  </strong>
                  , за каждую дату из поля{' '}
                  <strong>
                    «
                    {source?.columns.find((col) => col.id === draftRule.date)?.name ||
                      'Дата создания записи'}
                    »
                  </strong>
                  .
                </p>
              </div>
              <p className={styles.help}>
                Скрытые таблицы остаются доступны как источники. Их данные продолжают участвовать в
                подсчёте.
              </p>
            </section>
          )}
          {settingsPage === 'templates' && (
            <section className={styles.templates}>
              <div className={styles.sectionIntro}>
                <span className={styles.eyebrow}>НЕЗАВИСИМЫЕ КОПИИ</span>
                <h3>Готовая структура вместо повторной настройки</h3>
                <p>
                  Копируются названия, столбцы, форматы и варианты списков. Записи остаются в
                  исходном общежитии.
                </p>
              </div>
              <div className={styles.templateGrid}>
                {[
                  {
                    title: 'Стандартное общежитие',
                    tag: 'Базовый набор',
                    text: 'Проживающие, движение персонала, выплаты и отчёт',
                    count: '6 вкладок · 4 подвкладки',
                  },
                  {
                    title: 'Кадровый учёт',
                    tag: 'Свой шаблон',
                    text: 'Учёт сотрудников, документов и медицинских осмотров',
                    count: '4 вкладки · 2 подвкладки',
                  },
                ].map((item) => (
                  <article className={styles.templateCard} key={item.title}>
                    <span className={styles.templateMark}>
                      <Icon name="template" />
                    </span>
                    <small>{item.tag}</small>
                    <h4>{item.title}</h4>
                    <p>{item.text}</p>
                    <span>{item.count}</span>
                    <button
                      className={styles.secondary}
                      onClick={() => {
                        setSettings(false);
                        setCreateMode('sample');
                        chooseSample(item.tag === 'Свой шаблон' ? 'staff' : 'north');
                        setCreating(true);
                      }}
                    >
                      Использовать структуру ↗
                    </button>
                  </article>
                ))}
              </div>
              <div className={styles.saveTemplate}>
                <div>
                  <h4>{savedTemplate ? 'Структура сохранена' : `Сохранить структуру «${name}»`}</h4>
                  <p>
                    {savedTemplate
                      ? 'Демонстрационный шаблон готов к использованию.'
                      : 'Чтобы использовать этот набор вкладок в новом общежитии.'}
                  </p>
                </div>
                <button
                  className={styles.secondary}
                  onClick={() => {
                    setSavedTemplate(true);
                    setNotice('Демонстрационный шаблон сохранён');
                  }}
                >
                  <Icon name="template" />
                  {savedTemplate ? 'Сохранено ✓' : 'Сохранить как шаблон'}
                </button>
              </div>
            </section>
          )}
        </PreviewDialog>
      )}
      {creating && (
        <PreviewDialog
          title="Создать общежитие"
          subtitle="Выберите готовую структуру или соберите свою"
          wide
          onClose={() => setCreating(false)}
          footer={
            <>
              <span className={styles.footerHint}>Независимая копия · без записей</span>
              <button className={styles.secondary} onClick={() => setCreating(false)}>
                Отмена
              </button>
              <button
                className={styles.primary}
                disabled={!newName.trim() || !picked.length}
                onClick={createDormitory}
              >
                Создать общежитие
              </button>
            </>
          }
        >
          <div className={styles.createBody}>
            <section>
              <div className={styles.linkForm}>
                <label className={styles.field}>
                  Название общежития
                  <input
                    placeholder="Например, Восточное"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    maxLength={80}
                  />
                </label>
                <label className={styles.field}>
                  Клиент
                  <input value={newClient} onChange={(event) => setNewClient(event.target.value)} />
                </label>
              </div>
              <div className={styles.modeChoices}>
                <button
                  className={createMode === 'manual' ? styles.modeSelected : ''}
                  onClick={() => setCreateMode('manual')}
                >
                  <Icon name="tree" />
                  <strong>Выбрать самостоятельно</strong>
                  <span>Отметить нужные вкладки</span>
                </button>
                <button
                  className={createMode === 'sample' ? styles.modeSelected : ''}
                  onClick={() => {
                    setCreateMode('sample');
                    chooseSample(createSample);
                  }}
                >
                  <Icon name="template" />
                  <strong>По образцу общежития</strong>
                  <span>Взять готовую структуру</span>
                </button>
              </div>
              {createMode === 'sample' && (
                <label className={styles.field}>
                  Общежитие-образец
                  <select
                    value={createSample}
                    onChange={(event) => chooseSample(event.target.value)}
                  >
                    <option value="north">Стройкомплект · Северное</option>
                    <option value="staff">Кадровый учёт</option>
                  </select>
                </label>
              )}
              <div className={styles.columnsHeading}>
                <h4>Какие вкладки нужны?</h4>
                <button className={styles.textButton} onClick={() => setPicked([])}>
                  Снять все
                </button>
              </div>
              <div className={styles.checkboxList}>
                {initialTabs.map((tab) => (
                  <label key={tab.id} className={tab.parent ? styles.checkboxChild : ''}>
                    <input
                      type="checkbox"
                      checked={picked.includes(tab.id)}
                      onChange={(event) =>
                        setPicked(
                          event.target.checked
                            ? [...picked, tab.id]
                            : picked.filter((id) => id !== tab.id),
                        )
                      }
                    />
                    <span>{tab.name}</span>
                    {tab.parent && picked.includes(tab.id) && !picked.includes(tab.parent) && (
                      <small>Самостоятельная</small>
                    )}
                  </label>
                ))}
              </div>
            </section>
            <aside className={styles.structurePreview}>
              <span className={styles.eyebrow}>ПОЛУЧИТСЯ В НОВОМ ОБЩЕЖИТИИ</span>
              <h3>{newName || 'Новое общежитие'}</h3>
              <p>{picked.length} вкладок и подвкладок · 0 записей</p>
              {initialTabs
                .filter((tab) => picked.includes(tab.id) && !picked.includes(tab.parent || ''))
                .map((tab) => (
                  <div key={tab.id}>
                    <strong>
                      <Icon name="columns" />
                      {tab.name}
                    </strong>
                    {initialTabs
                      .filter((child) => child.parent === tab.id && picked.includes(child.id))
                      .map((child) => (
                        <span key={child.id}>└ {child.name}</span>
                      ))}
                  </div>
                ))}
              {!picked.length && <p>Отметьте вкладки слева</p>}
              <div className={styles.independent}>
                <Icon name="check" />
                <p>Изменения в образце не повлияют на созданное общежитие.</p>
              </div>
            </aside>
          </div>
        </PreviewDialog>
      )}
    </div>
  );
}
