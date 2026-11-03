import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import cabinet from '../../workspace/Workspace.module.css';
import { EditorArea, BASE } from './Area';
import { inventory, legacyScenes } from './inventory';
import type { Scene } from './inventory';
import { Sandbox } from './store';
import { installSandboxApis } from './api';
import s from './Sandbox.module.css';

const groups: { name: string; icon: WorkspaceIconName }[] = [
  { name: 'Обзор', icon: 'overview' },
  { name: 'Общежития', icon: 'house' },
  { name: 'Персонал', icon: 'people' },
  { name: 'Статистика', icon: 'chart' },
];

export function ConstructorSandbox(): JSX.Element {
  const [store] = useState(() => new Sandbox());
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState(false);
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const requested = params.get('builder') ?? 'formula';
  const scene: Scene = location.pathname.includes('/statistics')
    ? 'statistics'
    : (inventory.find((item) => item.id === requested)?.id ?? legacyScenes[requested] ?? 'formula');
  const selected = inventory.find((item) => item.id === scene)!;
  const dorm = store.dorms.some((item) => item.info.id === Number(params.get('dorm')))
    ? params.get('dorm')!
    : '1';
  useEffect(() => {
    const restore = installSandboxApis(store);
    setReady(true);
    return restore;
  }, [store]);
  useEffect(() => {
    const before = document.title;
    document.title = `${selected.title} — конструкторы Домовой`;
    return () => {
      document.title = before;
    };
  }, [selected.title]);
  function open(id: Scene): void {
    navigate(id === 'statistics' ? `${BASE}/statistics` : `${BASE}?builder=${id}&dorm=${dorm}`);
    setMenu(false);
  }
  return (
    <div className={`${cabinet.shell} ${s.shell}`} data-menu-open={String(menu)}>
      <button
        className={cabinet['mobile-backdrop']}
        tabIndex={-1}
        aria-label="Закрыть меню"
        onClick={() => setMenu(false)}
      />
      <aside className={cabinet.sidebar} id="constructor-sidebar" aria-label="Разделы кабинета">
        <Link className={cabinet.brand} to={`${BASE}?builder=dashboard`}>
          <span className={s.brandMark}>
            <WorkspaceIcon name="house" />
          </span>
          <span className={cabinet['brand-name']}>Домовой</span>
        </Link>
        <p className={cabinet['brand-note']}>Учёт проживающих в общежитиях</p>
        <nav>
          <p className={cabinet['nav-label']}>Рабочее пространство</p>
          {groups.map((group) => (
            <div key={group.name}>
              <button
                className={cabinet['nav-link']}
                aria-current={selected.section === group.name ? 'page' : undefined}
                onClick={() => open(inventory.find((item) => item.section === group.name)!.id)}
              >
                <WorkspaceIcon name={group.icon} />
                {group.name}
              </button>
              {selected.section === group.name && (
                <div className={s.subnav}>
                  {inventory
                    .filter((item) => item.section === group.name)
                    .map((item) => (
                      <button
                        key={item.id}
                        className="btn btn--ghost btn--compact"
                        aria-pressed={scene === item.id}
                        onClick={() => open(item.id)}
                      >
                        {item.title}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className={cabinet['sidebar-bottom']}>
          <div className={s.sidebarNote}>
            <strong>Полные конструкторы проекта</strong>
            <p>Действующие формы и действия. Настройки слева, результат рядом.</p>
          </div>
          <div className={cabinet.account}>
            <span className={cabinet['account-avatar']}>ДК</span>
            <div>
              <strong className={cabinet['account-name']}>Тестовый кабинет</strong>
              <p className={cabinet['account-email']}>Данные в памяти страницы</p>
            </div>
          </div>
        </div>
      </aside>
      <div className={cabinet.workspace}>
        <header className={cabinet.topbar}>
          <button
            className={cabinet['menu-toggle']}
            aria-label={menu ? 'Закрыть меню разделов' : 'Открыть меню разделов'}
            aria-expanded={menu}
            aria-controls="constructor-sidebar"
            onClick={() => setMenu((value) => !value)}
          >
            <WorkspaceIcon name="menu" />
          </button>
          <div className={cabinet.breadcrumbs}>
            <span>Рабочее пространство</span>
            <WorkspaceIcon name="chevron" />
            <strong>{selected.section}</strong>
          </div>
          <span className={cabinet['preview-label']}>Тестовая страница</span>
        </header>
        <main className={s.main}>
          <div className={s.banner}>
            <span>
              <i />
              Полные формы «Домового» в варианте №2
            </span>
            <small>
              Сохранение, удаление и восстановление действуют на тестовые данные до перезагрузки.
            </small>
          </div>
          <div className={s.heading}>
            <div>
              <h1>{selected.title}</h1>
              <p>{selected.detail}</p>
            </div>
            <details className={s.coverage}>
              <summary>Что включено</summary>
              <p>
                Используются действующие компоненты проекта с полным набором полей и действий. Два
                раздела настроек заездов сохранены. Формулы вводятся свободным выражением со
                скобками и несколькими действиями.
              </p>
            </details>
          </div>
          <div className={s.selectors}>
            <label>
              Конструктор проекта
              <select value={scene} onChange={(event) => open(event.target.value as Scene)}>
                {groups.map((group) => (
                  <optgroup key={group.name} label={group.name}>
                    {inventory
                      .filter((item) => item.section === group.name)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              Тестовое общежитие
              <select
                value={dorm}
                onChange={(event) => {
                  const next = new URLSearchParams(params);
                  next.set('builder', scene);
                  next.set('dorm', event.target.value);
                  navigate(`${BASE}?${next}`);
                }}
              >
                {store.dorms.map((item) => (
                  <option key={item.info.id} value={item.info.id}>
                    {item.info.name}
                  </option>
                ))}
              </select>
            </label>
            <span>Пример расчёта: 25–31 октября 2026</span>
          </div>
          {ready ? (
            <EditorArea
              key={`${scene}-${dorm}-${params.get('row') ?? ''}-${params.get('table') ?? ''}-${params.get('tab') ?? ''}`}
              store={store}
              scene={scene}
              dorm={dorm}
            />
          ) : (
            <p role="status">Подготовка тестовых данных…</p>
          )}
          {store.unsupported.size > 0 && (
            <div className={s.error} role="alert">
              Не выполнено в стенде: {[...store.unsupported].join(', ')}. Запрос на рабочий сервер
              не отправлен.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
