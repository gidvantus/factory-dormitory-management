import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { useUnloadWarning } from '../../components/useUnsavedChanges';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import type { WorkspaceIconName } from '../../workspace/WorkspaceIcon';
import cabinet from '../../workspace/Workspace.module.css';
import { Control, ItemEditor, Output } from '../constructor-lab/ConstructorLab';
import { employeeExamples, summary, validate, visibleFields } from '../constructor-lab/model';
import type { BuilderId, Draft, Field } from '../constructor-lab/model';
import lab from '../constructor-lab/ConstructorLab.module.css';
import {
  changedSettings,
  editorInfo,
  fieldGroup,
  getBuilder,
  projectBuilders,
  sections,
} from './data';
import type { Section } from './data';
import house from '../../assets/dorm-house.svg';
import resident from '../../assets/avatar-rezident.svg';
import s from './ConstructorProjectPreview.module.css';

type DormTab = 'residents' | 'report' | 'places' | 'custom';
type PersonnelTab = 'workspace' | 'employees' | 'arrivals';
const initial = (id: BuilderId): Draft => getBuilder(id).initial;
const action = (
  label: string,
  onClick: () => void,
  primary = false,
  icon?: WorkspaceIconName,
  disabled = false,
): JSX.Element => (
  <button
    type="button"
    className={`btn ${primary ? 'btn--primary' : 'btn--outline'} btn--compact ${s.action}`}
    onClick={onClick}
    disabled={disabled}
  >
    {icon && <WorkspaceIcon name={icon} />}
    {label}
  </button>
);

function SourceNote({ id, draft }: { id: BuilderId; draft: Draft }): JSX.Element {
  if (id === 'statistics' || id === 'dashboard') {
    const source = draft.values.source;
    const path =
      source === 'План заездов'
        ? 'Персонал / План заездов / Количество приезжающих'
        : source === 'Свободные места'
          ? 'Размещение персонала / Свободных мест М + Ж'
          : 'Общежития / Проживающие / Количество записей';
    return (
      <div className={s.sourceNote}>
        <WorkspaceIcon name="document" />
        <div>
          <strong>Откуда берётся результат</strong>
          <p>{path}</p>
          <span>
            <i />
            {draft.values.scope === 'Только Северный'
              ? 'Данные общежития «Северный»'
              : 'Северный, Заводской и Речной'}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={s.sourceNote}>
      <WorkspaceIcon name="info" />
      <div>
        <strong>Проверьте перед сохранением</strong>
        <p>{summary(getBuilder(id), draft)}</p>
      </div>
    </div>
  );
}

function Readout({
  id,
  draft,
  onEdit,
}: {
  id: BuilderId;
  draft: Draft;
  onEdit?: () => void;
}): JSX.Element {
  return (
    <article className={s.resultCard}>
      <div className={s.cardHeading}>
        <div>
          <h2>{String(draft.values.name)}</h2>
          <p>{getBuilder(id).location}</p>
        </div>
        {onEdit && action('Настроить', onEdit, false, 'overview')}
      </div>
      <div className={`${lab.page} ${s.demoOutput}`}>
        <Output builder={getBuilder(id)} draft={draft} />
      </div>
    </article>
  );
}

export function ConstructorProjectPreview(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const requested = projectBuilders.find((builder) => builder.id === params.get('builder'));
  const editorId = requested?.id ?? (params.has('section') ? null : 'statistics');
  const section = editorId
    ? editorInfo[editorId].section
    : (sections.find((item) => item.id === params.get('section'))?.id ?? 'statistics');
  const sectionName = sections.find((item) => item.id === section)!.name;
  const [saved, setSaved] = useState<Record<string, Draft>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [history, setHistory] = useState<Draft[]>([]);
  const [previewTab, setPreviewTab] = useState<'preview' | 'changes'>('preview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState('');
  const [dormTab, setDormTab] = useState<DormTab>(() =>
    editorId === 'table'
      ? 'custom'
      : editorId && ['formula', 'link', 'places'].includes(editorId)
        ? 'report'
        : 'residents',
  );
  const [personnelTab, setPersonnelTab] = useState<PersonnelTab>(() =>
    editorId === 'arrivals' ? 'arrivals' : editorId === 'filters' ? 'employees' : 'workspace',
  );
  const [reportRow, setReportRow] = useState<BuilderId>(() =>
    editorId && ['formula', 'link', 'places'].includes(editorId) ? editorId : 'formula',
  );
  const [search, setSearch] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const builder = editorId ? getBuilder(editorId) : null;
  const draft = editorId ? (drafts[editorId] ?? saved[editorId] ?? initial(editorId)) : null;
  const previous = editorId ? (saved[editorId] ?? initial(editorId)) : null;
  const changes = previous && draft ? changedSettings(previous, draft) : [];
  const dirty = changes.length > 0;
  const errors = builder && draft ? validate(builder, draft) : [];
  useUnloadWarning(dirty);

  useEffect(() => {
    const old = document.title;
    document.title = `${editorId ? editorInfo[editorId].title : sectionName} — тестовый кабинет Домовой`;
    headingRef.current?.focus({ preventScroll: true });
    return () => {
      document.title = old;
    };
  }, [editorId, sectionName]);

  useEffect(() => {
    if (!menuOpen) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    function keys(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuRef.current?.focus();
      }
      if (event.key !== 'Tab') return;
      const buttons = sidebarRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href]',
      );
      const first = buttons?.[0];
      const last = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', keys);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keys);
    };
  }, [menuOpen]);

  function guard(next: () => void): void {
    if (dirty) setPending(() => next);
    else next();
  }
  function goSection(next: Section): void {
    guard(() => {
      setParams({ section: next });
      setMenuOpen(false);
      setNotice('');
      setHistory([]);
    });
  }
  function start(id: BuilderId): void {
    guard(() => {
      const info = editorInfo[id];
      if (info.section === 'dormitories')
        setDormTab(
          id === 'formula' || id === 'link' || id === 'places'
            ? 'report'
            : id === 'table'
              ? 'custom'
              : 'residents',
        );
      if (info.section === 'personnel')
        setPersonnelTab(
          id === 'arrivals' ? 'arrivals' : id === 'filters' ? 'employees' : 'workspace',
        );
      if (id === 'formula' || id === 'link' || id === 'places') setReportRow(id);
      setParams({ section: info.section, builder: id });
      setMenuOpen(false);
      setPreviewTab('preview');
      setHistory([]);
      setNotice('');
    });
  }
  function update(next: Draft): void {
    if (!editorId || !draft) return;
    setHistory((current) => [...current, draft].slice(-40));
    setDrafts((current) => ({ ...current, [editorId]: next }));
    setNotice('');
  }
  function changeValue(key: string, value: string | boolean): void {
    if (draft) update({ ...draft, values: { ...draft.values, [key]: value } });
  }
  function close(): void {
    guard(() => {
      setParams({ section });
      setHistory([]);
    });
  }
  function save(): void {
    if (!editorId || !draft || errors.length) return;
    setSaved((current) => ({ ...current, [editorId]: draft }));
    setParams({ section });
    setNotice(`«${draft.values.name}» сохранено в тестовом кабинете. Результат показан ниже.`);
    setHistory([]);
  }
  const value = (id: BuilderId): Draft => saved[id] ?? initial(id);
  const card = (id: BuilderId): JSX.Element => (
    <Readout id={id} draft={value(id)} onEdit={() => start(id)} />
  );
  const currentFields = builder && draft ? visibleFields(builder, draft) : [];
  const renderField = (field: Field): JSX.Element => (
    <Control
      key={field.key}
      field={
        field.key === 'name' && editorId
          ? { ...field, label: editorInfo[editorId].nameLabel }
          : field
      }
      draft={draft!}
      onChange={changeValue}
    />
  );
  const mainFields = currentFields.filter((field) => !field.advanced && field.key !== 'name');
  const advancedFields = currentFields.filter((field) => field.advanced);
  const actionFields = mainFields.filter((field) => fieldGroup(field.key) === 'data');
  const viewFields = mainFields.filter((field) => fieldGroup(field.key) === 'view');
  const people = employeeExamples.filter((person) =>
    `${person.name} ${person.dorm}`
      .toLocaleLowerCase('ru')
      .includes(search.toLocaleLowerCase('ru')),
  );

  return (
    <div className={`${cabinet.shell} ${s.shell}`} data-menu-open={String(menuOpen)}>
      <button
        className={cabinet['mobile-backdrop']}
        type="button"
        aria-label="Закрыть меню"
        tabIndex={-1}
        onClick={() => {
          setMenuOpen(false);
          menuRef.current?.focus();
        }}
      />
      <aside
        className={cabinet.sidebar}
        id="project-preview-sidebar"
        aria-label="Боковая панель кабинета"
        ref={sidebarRef}
      >
        <button
          className={`${cabinet.brand} ${s.brand}`}
          onClick={() => goSection('overview')}
          aria-label="Домовой — обзор"
        >
          <span className={s.brandIcon}>
            <WorkspaceIcon name="house" />
          </span>
          <span className={cabinet['brand-name']}>Домовой</span>
        </button>
        <p className={cabinet['brand-note']}>Учёт проживающих в общежитиях</p>
        <nav aria-label="Разделы тестового кабинета">
          <p className={cabinet['nav-label']}>Рабочее пространство</p>
          <ul className={cabinet['nav-list']}>
            {sections.map((item) => (
              <li key={item.id}>
                <button
                  className={cabinet['nav-link']}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => goSection(item.id)}
                >
                  <WorkspaceIcon name={item.icon} />
                  {item.name}
                </button>
              </li>
            ))}
            <li>
              <span className={`${cabinet['nav-link']} ${s.quietNav}`}>
                <WorkspaceIcon name="document" />
                Документы
              </span>
            </li>
            <li>
              <span className={`${cabinet['nav-link']} ${s.quietNav}`}>
                <WorkspaceIcon name="journal" />
                Журнал
              </span>
            </li>
            <li>
              <span className={`${cabinet['nav-link']} ${s.quietNav}`}>
                <WorkspaceIcon name="info" />
                Магазин улучшений
              </span>
            </li>
          </ul>
        </nav>
        <div className={cabinet['sidebar-bottom']}>
          <div className={s.sidebarNote}>
            <WorkspaceIcon name="overview" />
            <strong>Настройки + результат</strong>
            <p>Вариант №2 в интерфейсе нашего проекта</p>
          </div>
          <div className={cabinet.account}>
            <span className={cabinet['account-avatar']}>ДК</span>
            <div className={cabinet['account-info']}>
              <p className={cabinet['account-name']}>Демонстрационный кабинет</p>
              <p className={cabinet['account-email']}>Пример для проверки интерфейса</p>
            </div>
          </div>
        </div>
      </aside>
      <div className={cabinet.workspace}>
        <header className={cabinet.topbar}>
          <button
            ref={menuRef}
            className={cabinet['menu-toggle']}
            aria-expanded={menuOpen}
            aria-controls="project-preview-sidebar"
            aria-label={menuOpen ? 'Закрыть меню разделов' : 'Открыть меню разделов'}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <WorkspaceIcon name="menu" />
          </button>
          <div className={cabinet.breadcrumbs}>
            <span>Рабочее пространство</span>
            <WorkspaceIcon name="chevron" />
            <strong>{sectionName}</strong>
            {editorId && (
              <>
                <WorkspaceIcon name="chevron" />
                <span className={s.currentCrumb}>{editorInfo[editorId].subtitle}</span>
              </>
            )}
          </div>
          <span className={cabinet['preview-label']}>Тестовая страница</span>
        </header>
        <main className={s.main}>
          <div className={s.previewNotice}>
            <span>
              <i />
              Вариант №2 в кабинете «Домовой»
              <small>Демонстрационные данные · изменения до перезагрузки</small>
            </span>
            <Link
              to="/preview/constructors"
              onClick={(event) => {
                if (dirty) {
                  event.preventDefault();
                  guard(() => navigate('/preview/constructors'));
                }
              }}
            >
              К пяти вариантам <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <details className={s.scenarios}>
            <summary>
              Открыть другой конструктор <span>{projectBuilders.length}</span>
            </summary>
            <div>
              {sections.map((item) => (
                <section key={item.id}>
                  <h2>{item.name}</h2>
                  {projectBuilders
                    .filter((entry) => editorInfo[entry.id].section === item.id)
                    .map((entry) => (
                      <button
                        key={entry.id}
                        className="link-button"
                        onClick={() => start(entry.id)}
                        aria-pressed={editorId === entry.id}
                      >
                        {entry.name}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                </section>
              ))}
            </div>
          </details>
          {editorId && builder && draft && previous ? (
            <>
              <button className={s.back} onClick={close}>
                <span aria-hidden="true">←</span>
                {editorInfo[editorId].back}
              </button>
              <div className={s.heading}>
                <div>
                  <p className={s.context}>{editorInfo[editorId].subtitle}</p>
                  <h1 ref={headingRef} tabIndex={-1}>
                    {editorInfo[editorId].title}
                  </h1>
                  <p>{builder.task}</p>
                </div>
                <span className={s.period}>
                  <WorkspaceIcon name="document" />
                  25–31 октября 2026
                </span>
              </div>
              <div className={s.editorLayout}>
                <section
                  className={`${lab.page} ${s.settingsPane}`}
                  aria-label="Настройки конструктора"
                >
                  <div className={s.paneTitle}>
                    <span className={s.paneIcon}>
                      <WorkspaceIcon name="overview" />
                    </span>
                    <div>
                      <h2>Что нужно настроить</h2>
                      <p>Результат обновляется сразу справа.</p>
                    </div>
                  </div>
                  <div className={`${s.controlGroup} ${s.identityGroup}`}>
                    {currentFields.filter((field) => field.key === 'name').map(renderField)}
                  </div>
                  {actionFields.length > 0 && (
                    <section className={s.controlGroup}>
                      <h3>
                        {editorId === 'personnel'
                          ? 'Сопоставление столбцов'
                          : editorId === 'formula'
                            ? 'Как получить значение'
                            : editorId === 'filters'
                              ? 'Кто попадёт в список'
                              : 'Данные и условия'}
                      </h3>
                      {actionFields.map(renderField)}
                    </section>
                  )}
                  {builder.collection && (
                    <div className={s.controlGroup}>
                      <ItemEditor builder={builder} draft={draft} onChange={update} />
                    </div>
                  )}
                  {viewFields.length > 0 && (
                    <section className={s.controlGroup}>
                      <h3>
                        {editorId === 'arrivals' ? 'Карточка заезда' : 'Как это будет выглядеть'}
                      </h3>
                      {viewFields.map(renderField)}
                    </section>
                  )}
                  {advancedFields.length > 0 && (
                    <details className={s.advanced}>
                      <summary>
                        {editorId === 'statistics' ? 'Уточнить расчёт' : 'Дополнительные настройки'}
                        <span>{advancedFields.length}</span>
                      </summary>
                      <div>{advancedFields.map(renderField)}</div>
                    </details>
                  )}
                </section>
                <aside className={s.previewPane} aria-label="Результат настройки">
                  <div className={s.previewTabs} role="group" aria-label="Просмотр результата">
                    <button
                      className="btn btn--tab"
                      aria-pressed={previewTab === 'preview'}
                      onClick={() => setPreviewTab('preview')}
                    >
                      Так увидят пользователи
                    </button>
                    <button
                      className="btn btn--tab"
                      aria-pressed={previewTab === 'changes'}
                      onClick={() => setPreviewTab('changes')}
                    >
                      Что изменится{changes.length > 0 && <span>{changes.length}</span>}
                    </button>
                    <span className={s.live}>
                      <i />
                      Обновляется сразу
                    </span>
                  </div>
                  {previewTab === 'preview' ? (
                    <>
                      <div className={s.previewCanvas}>
                        <div className={s.previewContext}>
                          <WorkspaceIcon
                            name={
                              section === 'personnel'
                                ? 'people'
                                : section === 'dormitories'
                                  ? 'house'
                                  : 'chart'
                            }
                          />
                          <span>{editorInfo[editorId].subtitle}</span>
                          <small>Пример</small>
                        </div>
                        <h2 className={s.previewName}>
                          {String(draft.values.name || 'Добавьте название')}
                        </h2>
                        <div className={`${lab.page} ${s.demoOutput}`}>
                          <Output builder={builder} draft={draft} />
                        </div>
                      </div>
                      <SourceNote id={editorId} draft={draft} />
                      <div className={s.readableRule}>
                        <WorkspaceIcon name="info" />
                        <p>{summary(builder, draft)}</p>
                      </div>
                    </>
                  ) : (
                    <section className={s.changeList}>
                      <h2>Изменения после сохранения</h2>
                      {changes.length === 0 ? (
                        <p>Пока ничего не изменено. Попробуйте поменять настройку слева.</p>
                      ) : (
                        <>
                          <p>Эти настройки обновятся в тестовом кабинете.</p>
                          <dl>
                            {changes.map((key) => (
                              <div key={key}>
                                <dt>
                                  {key === 'items'
                                    ? 'Состав и порядок элементов'
                                    : key === 'name'
                                      ? editorInfo[editorId].nameLabel
                                      : builder.fields.find((field) => field.key === key)?.label}
                                </dt>
                                <dd>
                                  {key === 'items' ? (
                                    <>
                                      <span>
                                        Было:{' '}
                                        {previous.items
                                          .filter((item) => item.enabled)
                                          .map((item) => item.name)
                                          .join(', ')}
                                      </span>
                                      <strong>
                                        Стало:{' '}
                                        {draft.items
                                          .filter((item) => item.enabled)
                                          .map((item) => item.name)
                                          .join(', ')}
                                      </strong>
                                    </>
                                  ) : (
                                    <>
                                      <span>
                                        Было:{' '}
                                        {typeof previous.values[key] === 'boolean'
                                          ? previous.values[key]
                                            ? 'Включено'
                                            : 'Выключено'
                                          : String(previous.values[key] ?? 'Не задано')}
                                      </span>
                                      <strong>
                                        Стало:{' '}
                                        {typeof draft.values[key] === 'boolean'
                                          ? draft.values[key]
                                            ? 'Включено'
                                            : 'Выключено'
                                          : String(draft.values[key])}
                                      </strong>
                                    </>
                                  )}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </>
                      )}
                    </section>
                  )}
                </aside>
              </div>
              <footer className={s.saveBar}>
                <div className={s.saveStatus} aria-live="polite">
                  {errors.length ? (
                    <ul>
                      {errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  ) : (
                    <>
                      <span>
                        <i data-dirty={dirty} />
                        {dirty ? 'Есть несохранённые изменения' : 'Можно проверить настройки'}
                      </span>
                      <small>Сохранение обновит пример в разделе «{sectionName}».</small>
                    </>
                  )}
                </div>
                <div className={s.saveActions}>
                  <button
                    className={s.undo}
                    aria-label="Отменить последнее изменение"
                    disabled={!history.length}
                    onClick={() => {
                      const before = history[history.length - 1];
                      if (before) {
                        setDrafts((current) => ({ ...current, [editorId]: before }));
                        setHistory((current) => current.slice(0, -1));
                      }
                    }}
                  >
                    ↶
                  </button>
                  {action('Отмена', close)}
                  {action(editorInfo[editorId].save, save, true, undefined, errors.length > 0)}
                </div>
                {errors.length > 0 && (
                  <span className={s.validationHint}>Исправьте настройки перед сохранением.</span>
                )}
              </footer>
            </>
          ) : (
            <>
              {notice && (
                <div className={s.success} role="status">
                  <span>✓</span>
                  <p>{notice}</p>
                </div>
              )}
              {section === 'statistics' && (
                <>
                  <div className={s.heading}>
                    <div>
                      <p className={s.context}>Статистика / Общий отчёт организации</p>
                      <h1 ref={headingRef} tabIndex={-1}>
                        Управленческий отчёт
                      </h1>
                      <p>Показатели всех общежитий за выбранный период.</p>
                    </div>
                    <span className={s.period}>25–31 октября 2026</span>
                  </div>
                  {card('statistics')}
                  <div className={s.nextAction}>
                    <WorkspaceIcon name="chart" />
                    <div>
                      <strong>Настройте отчёт под свою задачу</strong>
                      <p>
                        Название, источник, вид графика и способ расчёта доступны в одном редакторе.
                      </p>
                    </div>
                    {action('Настроить блок', () => start('statistics'), true)}
                  </div>
                </>
              )}
              {section === 'overview' && (
                <>
                  <div className={s.heading}>
                    <div>
                      <p className={s.context}>Организация / Все общежития</p>
                      <h1 ref={headingRef} tabIndex={-1}>
                        Обзор
                      </h1>
                      <p>Проживание и ближайшие заезды.</p>
                    </div>
                    {action('Настроить показатель', () => start('dashboard'), true, 'chart')}
                  </div>
                  <div className={s.metrics}>
                    {[
                      ['Проживают сейчас', '284', 'На 31 октября'],
                      ['Свободных мест', '46', 'Оплачено минус проживает'],
                      ['Заезды за неделю', '50', '25–31 октября'],
                    ].map(([label, count, hint]) => (
                      <article key={label}>
                        <span>{label}</span>
                        <strong>{count}</strong>
                        <small>{hint}</small>
                      </article>
                    ))}
                  </div>
                  {card('dashboard')}
                  <div className={s.dormCards}>
                    {['Северный', 'Заводской', 'Речной'].map((name, index) => (
                      <article key={name}>
                        <img src={house} alt="" />
                        <div>
                          <h2>{name}</h2>
                          <p>{[124, 92, 68][index]} проживают</p>
                        </div>
                        {index === 0 && action('Открыть', () => goSection('dormitories'))}
                      </article>
                    ))}
                  </div>
                </>
              )}
              {section === 'dormitories' && (
                <>
                  <div className={s.heading}>
                    <div>
                      <p className={s.context}>Общежития / Демо-клиент</p>
                      <h1 ref={headingRef} tabIndex={-1}>
                        {String(value('structure').values.name)}
                      </h1>
                      <p>Проживание, движение персонала и отчёты общежития.</p>
                    </div>
                    <div className={s.headingActions}>
                      {action('Настроить общежитие', () => start('structure'), false, 'overview')}
                      {action('Добавить вкладку', () => start('table'), true)}
                    </div>
                  </div>
                  <nav className={s.sectionTabs} aria-label="Вкладки общежития">
                    {(
                      [
                        ['report', 'Общий отчёт'],
                        ['places', 'Размещение персонала'],
                        ['residents', 'Проживающие'],
                        ['custom', String(value('table').values.name)],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        className="btn btn--segment btn--compact"
                        aria-pressed={dormTab === key}
                        onClick={() => setDormTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                  {dormTab === 'residents' && (
                    <>
                      <div className={s.tableToolbar}>
                        <div>
                          <h2>Проживающие</h2>
                          <span>Пример таблицы с настраиваемыми столбцами</span>
                        </div>
                        <div>
                          {action('Связь с персоналом', () => start('personnel'))}
                          {action('Настроить столбцы', () => start('columns'), true)}
                        </div>
                      </div>
                      {card('columns')}
                      {saved.structure && card('structure')}
                      {saved.personnel && card('personnel')}
                    </>
                  )}
                  {dormTab === 'custom' && (
                    <>
                      {card('table')}
                      <div className={s.nextAction}>
                        <WorkspaceIcon name="document" />
                        <p>У вкладки свой формат, период и набор столбцов.</p>
                        {action('Настроить вкладку', () => start('table'), true)}
                      </div>
                    </>
                  )}
                  {dormTab === 'places' && (
                    <>
                      <div className={s.tableToolbar}>
                        <div>
                          <h2>Размещение персонала</h2>
                          <span>Значения за 31 октября 2026 года</span>
                        </div>
                        {action('Связать с отчётом', () => start('places'), true)}
                      </div>
                      {card('places')}
                    </>
                  )}
                  {dormTab === 'report' && (
                    <>
                      <div className={s.tableToolbar}>
                        <div>
                          <h2>Общий отчёт</h2>
                          <span>Октябрь 2026</span>
                        </div>
                        <div>
                          {action('Строка и формула', () => start('formula'))}
                          {action('Связь с таблицей', () => start('link'))}
                          {action('Связь с размещением', () => start('places'))}
                        </div>
                      </div>
                      {card(reportRow)}
                    </>
                  )}
                </>
              )}
              {section === 'personnel' && (
                <>
                  <div className={s.heading}>
                    <div>
                      <p className={s.context}>Люди и их история</p>
                      <h1 ref={headingRef} tabIndex={-1}>
                        Персонал
                      </h1>
                      <p>Проживание, вахты и контакты — в одном месте.</p>
                    </div>
                    <img className={s.personArt} src={resident} alt="" />
                  </div>
                  <nav className={s.sectionTabs} aria-label="Разделы персонала">
                    {(
                      [
                        ['workspace', 'Рабочая поверхность'],
                        ['employees', 'Сотрудники'],
                        ['arrivals', 'План заездов'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        className="btn btn--segment btn--compact"
                        aria-pressed={personnelTab === key}
                        onClick={() => setPersonnelTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                  {personnelTab === 'workspace' && (
                    <>
                      <div className={s.tableToolbar}>
                        <div>
                          <h2>Моя рабочая поверхность</h2>
                          <span>Блоки с нужной информацией</span>
                        </div>
                        {action('Настроить блок персонала', () => start('workspace'), true)}
                      </div>
                      {card('workspace')}
                    </>
                  )}
                  {personnelTab === 'arrivals' && (
                    <>
                      <div className={s.tableToolbar}>
                        <div>
                          <h2>План заездов</h2>
                          <span>Следующая неделя / Северный</span>
                        </div>
                        {action('Настроить поля и карточки', () => start('arrivals'), true)}
                      </div>
                      {card('arrivals')}
                    </>
                  )}
                  {personnelTab === 'employees' && (
                    <>
                      <div className={s.tableToolbar}>
                        <label className={s.search}>
                          Найти сотрудника
                          <input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="ФИО или общежитие"
                          />
                        </label>
                        {action('Фильтры и свой список', () => start('filters'), true)}
                      </div>
                      <div className={s.peopleTable}>
                        <table>
                          <thead>
                            <tr>
                              <th>Сотрудник</th>
                              <th>Общежитие</th>
                              <th>Телефон</th>
                              <th>Проживание</th>
                            </tr>
                          </thead>
                          <tbody>
                            {people.map((person) => (
                              <tr key={person.name}>
                                <th scope="row">{person.name}</th>
                                <td>{person.dorm}</td>
                                <td>{person.phone || 'Не заполнен'}</td>
                                <td>
                                  <span className={s.statusPill}>
                                    {person.current ? 'Проживает' : 'Не проживает'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!people.length && (
                          <p className={s.empty}>
                            Никого не нашли. Попробуйте другое имя или общежитие.
                          </p>
                        )}
                      </div>
                      {saved.filters && card('filters')}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>
      {pending && (
        <Modal
          title="Сохранить изменения перед выходом?"
          testId="project-preview-unsaved"
          protectChanges={false}
          onClose={() => setPending(null)}
        >
          <p>Настройки ещё не сохранены в тестовом кабинете.</p>
          <div className={s.discardActions}>
            {action('Продолжить настройку', () => setPending(null))}
            {action('Выйти без сохранения', () => {
              if (editorId && previous)
                setDrafts((current) => ({ ...current, [editorId]: previous }));
              const next = pending;
              setPending(null);
              next();
            })}
            {errors.length === 0 &&
              action(
                'Сохранить и выйти',
                () => {
                  if (editorId && draft) setSaved((current) => ({ ...current, [editorId]: draft }));
                  const next = pending;
                  setPending(null);
                  next();
                },
                true,
              )}
          </div>
        </Modal>
      )}
    </div>
  );
}
