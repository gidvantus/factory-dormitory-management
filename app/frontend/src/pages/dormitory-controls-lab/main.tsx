import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import { SessionProvider } from '../../auth/SessionProvider';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { UnsavedChangesProvider } from '../../components/UnsavedChanges';
import { Cabinet } from '../../pages/Cabinet';
import { Dormitories } from '../../workspace/Dormitories';
import { currentMonth, dateNumber, rangeError } from '../../workspace/dashboard/dates';
import { DormitoryDetails } from '../../workspace/dormitories/DormitoryDetails';
import dormitoryStyles from '../../workspace/dormitories/Dormitories.module.css';
import residentStyles from '../../workspace/dormitories/ResidentsTable.module.css';
import placesStyles from '../../workspace/dormitories/HostelPlaces.module.css';
import readinessStyles from '../../workspace/dormitories/ReportReadiness.module.css';
import exchangeStyles from '../../workspace/dormitories/TableExchange.module.css';
import columnStyles from '../../workspace/dormitories/ConfigurableColumns.module.css';
import { dormitory, hostels, installDemoFetch, residents } from './demoData';
import '../../index.css';
import './preview.css';

const buttons = {
  settings: 'Настроить',
  readiness: 'Готовность отчёта',
  add: 'Добавить строку',
  addColumn: 'Добавить столбец',
  columns: 'Настроить столбцы',
  import: 'Импорт из Excel',
  export: 'Экспорт в Excel',
  template: 'Сохранить как шаблон',
  clear: 'Очистить список',
  row: 'Действия в строках',
} as const;
const filters = {
  search: 'Поиск',
  range: 'Диапазон дат',
  month: 'Переключение месяцев',
  hostel: 'Место проживания',
  gender: 'Пол',
  book: 'ЛМК',
  reset: 'Сбросить фильтры',
} as const;
type Action = keyof typeof buttons;
type Filter = keyof typeof filters;
type Choice = Action | Filter;
const actionKeys = Object.keys(buttons) as Action[];
const filterKeys = Object.keys(filters) as Filter[];
const all: Choice[] = [...actionKeys, ...filterKeys];
const initial: Choice[] = ['settings', 'readiness', 'add', 'row', 'search'];
const previewPath = `/cabinet/dormitories/${dormitory.id}/residents`;
const buttonClass = 'btn btn--ghost btn--compact';
const newFilters = () => ({
  search: '',
  from: '',
  to: '',
  month: '',
  hostel: '',
  gender: '',
  book: '',
});

export function Lab(): JSX.Element {
  const { pathname } = useLocation();
  const residentsTab = pathname.endsWith('/residents');
  const placesTab = pathname.endsWith('/places');
  const [choices, setChoices] = useState<Choice[]>(initial);
  const [values, setValues] = useState(newFilters);
  const [dateDraft, setDateDraft] = useState({ from: '', to: '' });
  const [dateError, setDateError] = useState('');
  const [sample, setSample] = useState<Action | null>(null);
  const actual = useRef<HTMLDivElement>(null);
  const [target] = useState(() => document.createElement('div'));
  const enabled = (choice: Choice) => choices.includes(choice);
  const active = (key: keyof ReturnType<typeof newFilters>, choice: Choice = key as Choice) =>
    enabled(choice) ? values[key] : '';
  const from = active('from', 'range');
  const to = active('to', 'range');
  const query = active('search').trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const activeFilters = Object.keys(newFilters()).some((key) =>
    active(
      key as keyof ReturnType<typeof newFilters>,
      key === 'from' || key === 'to' ? 'range' : (key as Choice),
    ),
  );
  const visible = new Set(
    residents
      .filter((resident) => {
        const date = resident.shift_start ?? '';
        const search = `${resident.full_name ?? ''} ${resident.personnel_number ?? ''}`
          .toLocaleLowerCase('ru')
          .replaceAll('ё', 'е');
        return (
          (!query || search.includes(query)) &&
          (!from || date >= from) &&
          (!to || date <= to) &&
          (!active('month') || date.startsWith(active('month'))) &&
          (!active('hostel') || String(resident.hostel_id) === active('hostel')) &&
          (!active('gender') || resident.gender === active('gender')) &&
          (!active('book') || resident.medical_book === active('book'))
        );
      })
      .map(({ id }) => String(id)),
  );

  useLayoutEffect(() => {
    const scope = actual.current;
    if (!scope) return;
    function decorate(): void {
      const section = scope?.querySelector(`.${dormitoryStyles.sectionContent} > section`);
      if (section && target.parentElement !== section) {
        const heading = section.firstElementChild;
        if (heading?.querySelector('h2') || heading?.matches('h2')) heading.after(target);
        else section.prepend(target);
      } else if (!section && target.parentElement) target.remove();
      if (section) {
        const candidates = section.querySelectorAll<HTMLButtonElement>('button');
        for (const node of candidates) {
          if (node.closest('[data-lab-toolbar], [role="dialog"], table')) continue;
          if (
            /^(\+\s*)?(Добавить строку|Добавляем…|Добавить хостел|Сохранить как шаблон|Очистить список|Очищаем…)$/.test(
              node.textContent?.trim() ?? '',
            )
          ) {
            node.dataset.labOriginal = '';
          }
        }
      }
      scope?.querySelectorAll<HTMLTableRowElement>('[data-testid^="resident-"]').forEach((row) => {
        if (row.tagName === 'TR')
          row.toggleAttribute(
            'data-lab-filtered',
            !visible.has(row.dataset.testid?.slice(9) ?? ''),
          );
      });
    }
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(scope, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  useLayoutEffect(() => () => target.remove(), [target]);

  function toggle(choice: Choice): void {
    setChoices((current) =>
      current.includes(choice) ? current.filter((item) => item !== choice) : [...current, choice],
    );
    if (choice === 'range') setDateError('');
  }

  function resetFilters(): void {
    setValues(newFilters());
    setDateDraft({ from: '', to: '' });
    setDateError('');
  }

  function setFilter(key: keyof ReturnType<typeof newFilters>, value: string): void {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  function operate(action: Action): void {
    if (action === 'columns') {
      actual.current
        ?.querySelector<HTMLButtonElement>('[data-testid="dormitory-details-heading"] > button')
        ?.click();
      return;
    }
    const matching = {
      add: placesTab ? '+ Добавить хостел' : '+ Добавить строку',
      import: buttons.import,
      template: buttons.template,
    } as const;
    if (action in matching) {
      const native = Array.from(
        actual.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      ).find(
        (node) =>
          !node.closest('[data-lab-toolbar], [role="dialog"]') &&
          node.textContent?.trim() === matching[action as keyof typeof matching],
      );
      if (native && !native.disabled) {
        native.click();
        return;
      }
    }
    setSample(action);
  }

  function applyRange(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = { from: String(data.get('from') ?? ''), to: String(data.get('to') ?? '') };
    const error = next.from || next.to ? rangeError(next) : '';
    setDateError(error);
    if (!error) setValues((previous) => ({ ...previous, ...next }));
  }

  function changeMonth(offset: number): void {
    const date = new Date(dateNumber(`${values.month || currentMonth().from.slice(0, 7)}-01`));
    date.setUTCMonth(date.getUTCMonth() + offset);
    setFilter('month', date.toISOString().slice(0, 7));
  }

  function selectFilter(
    key: 'hostel' | 'gender' | 'book',
    options: [string, string][],
  ): JSX.Element | null {
    if (!enabled(key)) return null;
    return (
      <label className="lab-field">
        {filters[key]}
        <select value={values[key]} onChange={(event) => setFilter(key, event.target.value)}>
          <option value="">Все</option>
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function actionButton(action: Action): JSX.Element {
    const label = action === 'add' && placesTab ? 'Добавить хостел' : buttons[action];
    const variant = action === 'add' ? 'primary' : 'ghost';
    return (
      <button
        key={action}
        type="button"
        className={`btn btn--${variant} btn--compact ${action === 'clear' ? 'lab-danger' : ''}`}
        onClick={() => operate(action)}
      >
        {(action === 'add' || action === 'addColumn') && <span aria-hidden="true">+</span>} {label}
      </button>
    );
  }

  const secondary: Action[] = ['addColumn', 'columns', 'import', 'export', 'template', 'clear'];
  const activeSecondary = secondary.filter(enabled);
  const filtersOn = filterKeys.some(enabled);
  const toolbar = (
    <div data-lab-toolbar="" aria-label="Панель кнопок и фильтров">
      {(activeSecondary.length > 0 || enabled('add')) && (
        <div className="lab-actions" aria-label="Действия с таблицей">
          <div className="lab-secondary">{activeSecondary.map(actionButton)}</div>
          <div className="lab-primary">{enabled('add') && actionButton('add')}</div>
        </div>
      )}
      {filtersOn && (
        <div className="lab-filters" aria-label="Фильтры таблицы">
          <div className="lab-filter-line">
            {enabled('search') && (
              <label className="lab-field lab-search">
                Поиск по таблице
                <input
                  type="search"
                  value={values.search}
                  placeholder="ФИО или табельный номер"
                  onChange={(event) => setFilter('search', event.target.value)}
                />
              </label>
            )}
            {selectFilter(
              'hostel',
              hostels.map(({ id, name }) => [String(id), name]),
            )}
            {selectFilter('gender', [
              ['М', 'Мужской'],
              ['Ж', 'Женский'],
            ])}
            {selectFilter('book', [
              ['Есть', 'Есть'],
              ['Нет', 'Нет'],
              ['Делается', 'Делается'],
            ])}
            {enabled('reset') && (
              <button type="button" className={buttonClass} onClick={resetFilters}>
                Сбросить фильтры
              </button>
            )}
          </div>
          {(enabled('range') || enabled('month')) && (
            <div className="lab-filter-line lab-dates">
              {enabled('range') && (
                <form className="lab-range" onSubmit={applyRange} noValidate>
                  <label className="lab-field">
                    Дата с
                    <input
                      name="from"
                      type="date"
                      value={dateDraft.from}
                      onChange={(event) => setDateDraft({ ...dateDraft, from: event.target.value })}
                    />
                  </label>
                  <label className="lab-field">
                    Дата по
                    <input
                      name="to"
                      type="date"
                      value={dateDraft.to}
                      onChange={(event) => setDateDraft({ ...dateDraft, to: event.target.value })}
                    />
                  </label>
                  <button type="submit" className={buttonClass}>
                    Применить период
                  </button>
                </form>
              )}
              {enabled('month') && (
                <div className="lab-month">
                  <button
                    type="button"
                    className={`${buttonClass} btn--icon`}
                    aria-label="Предыдущий месяц"
                    onClick={() => changeMonth(-1)}
                  >
                    ‹
                  </button>
                  <label className="lab-field">
                    Месяц
                    <input
                      type="month"
                      value={values.month}
                      onChange={(event) => setFilter('month', event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={`${buttonClass} btn--icon`}
                    aria-label="Следующий месяц"
                    onClick={() => changeMonth(1)}
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setFilter('month', currentMonth().from.slice(0, 7))}
                  >
                    Текущий месяц
                  </button>
                </div>
              )}
            </div>
          )}
          {dateError && enabled('range') && (
            <p role="alert" className="lab-error">
              {dateError}
            </p>
          )}
          {residentsTab && activeFilters && (
            <p className="lab-found" role="status">
              Найдено {visible.size} из {residents.length}
            </p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="lab">
      <section className="lab-panel" aria-label="Управление тестовой страницей">
        <div className="lab-panel-heading">
          <div>
            <h2>Проверка кнопок и фильтров</h2>
            <p>
              Галочки меняют экран ниже сразу. Дополнительные фильтры работают на вкладке
              «Проживающие».
            </p>
          </div>
          <div className="lab-presets">
            <button
              type="button"
              className="btn btn--primary btn--compact"
              onClick={() => setChoices(all)}
            >
              Показать всё
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setChoices([]);
                resetFilters();
              }}
            >
              Скрыть всё
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setChoices(initial);
                resetFilters();
              }}
            >
              Исходный набор
            </button>
          </div>
        </div>
        <details open>
          <summary>
            Выбрать элементы{' '}
            <span aria-live="polite">
              {choices.length} из {all.length}
            </span>
          </summary>
          <div className="lab-options">
            <fieldset>
              <legend>Кнопки и действия</legend>
              {actionKeys.map((key) => (
                <label key={key}>
                  <input type="checkbox" checked={enabled(key)} onChange={() => toggle(key)} />
                  {buttons[key]}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Фильтры</legend>
              {filterKeys.map((key) => (
                <label key={key}>
                  <input type="checkbox" checked={enabled(key)} onChange={() => toggle(key)} />
                  {filters[key]}
                </label>
              ))}
            </fieldset>
          </div>
        </details>
      </section>
      <div
        ref={actual}
        className="lab-actual"
        data-lab-settings={enabled('settings')}
        data-lab-readiness={enabled('readiness')}
        data-lab-row={enabled('row')}
      >
        <DormitoryDetails />
        {createPortal(toolbar, target)}
      </div>
      {sample && (
        <Modal title={buttons[sample]} testId="lab-sample" onClose={() => setSample(null)}>
          <p>
            На тестовой странице эта кнопка показывает место действия. Записи и файлы здесь не
            изменяются.
          </p>
          <div className="dialog-actions">
            <ModalCancelButton className={buttonClass}>Закрыть</ModalCancelButton>
          </div>
        </Modal>
      )}
      <style>{`
      .lab-actual [data-testid="dormitory-table-tools"],
      .lab-actual [data-testid="dormitory-table-tools"] > [role="group"],
      .lab-actual [data-testid="dormitory-table-tools"] > [aria-label="Действия с таблицей"] > * {
        display: contents !important;
      }
      .lab-actual .${dormitoryStyles.periodForm}, .lab-actual .${residentStyles.searchBar},
      .lab-actual .${exchangeStyles.actions}, .lab-actual .${placesStyles.monthFilter},
      .lab-actual .${exchangeStyles.container}:has(> .${exchangeStyles.actions}:only-child),
      .lab-actual .${exchangeStyles.container}:has(> .${exchangeStyles.actions}:only-child),
      .lab-actual [data-lab-original] { display: none !important; }
      .lab-actual[data-lab-readiness="false"] .${readinessStyles.readiness},
      .lab-actual[data-lab-row="false"] .${columnStyles.rowActions},
      .lab-actual[data-lab-row="false"] table:has(td.${columnStyles.rowActions}) thead th:last-child:not([data-column-key]) { display: none !important; }
    `}</style>
    </div>
  );
}

installDemoFetch();

const router = createMemoryRouter(
  [
    {
      element: (
        <SessionProvider>
          <UnsavedChangesProvider>
            <Cabinet />
          </UnsavedChangesProvider>
        </SessionProvider>
      ),
      children: [
        { path: '/cabinet/dormitories/:dormitoryId/*', element: <Lab /> },
        { path: '/cabinet/dormitories', element: <Dormitories /> },
        { path: '*', element: <Navigate to={previewPath} replace /> },
      ],
    },
  ],
  { initialEntries: [previewPath], future: { v7_relativeSplatPath: true } },
);

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} future={{ v7_startTransition: true }} />,
);
