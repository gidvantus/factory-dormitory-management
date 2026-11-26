import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { WorkspaceIcon } from '../../workspace/WorkspaceIcon';
import { HostelBuilder, ModeMark, outline, primary } from './HostelBuilder';
import {
  days,
  demoId,
  dormitories,
  evaluate,
  initialDemo,
  modeNames,
  sampleDay,
  showFormula,
  sourceOptions,
  sources,
} from './model';
import type { Demo, Dormitory, Hostel, Template } from './model';
import styles from './HostelBuilderPreview.module.css';

const storageKey = 'dormitory-hostel-builder-preview-v1';

function loadDemo(): Demo {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value ? (JSON.parse(value) as Demo) : initialDemo;
  } catch {
    return initialDemo;
  }
}

function HostelTable({
  hostel,
  onEdit,
  onValue,
}: {
  hostel: Hostel;
  onEdit: () => void;
  onValue: (rowId: string, day: number, raw: string) => void;
}): JSX.Element {
  const daily = days.map((day) => evaluate(hostel, day));
  return (
    <article className={styles.hostel}>
      <header className={styles.hostelHeading}>
        <div className={styles.hostelName}>
          <span>
            <WorkspaceIcon name="building" />
          </span>
          <h2>{hostel.name}</h2>
        </div>
        <button type="button" className={outline} onClick={onEdit}>
          Настроить хостел
        </button>
      </header>
      <div className={styles.tableScroll}>
        <table className={styles.table} aria-label={`Размещение · ${hostel.name}`}>
          <thead>
            <tr>
              <th scope="col">Показатель</th>
              {days.map((day) => (
                <th key={day} scope="col" data-current={day === sampleDay}>
                  <span>{day} ноя</span>
                  <small>
                    {new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(
                      new Date(Date.UTC(2026, 10, day)),
                    )}
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hostel.rows.map((row) => {
              const description =
                row.mode === 'source'
                  ? `${sources[row.source].name} · ${sourceOptions(row.source).find(([key]) => key === row.indicator)?.[1]}`
                  : row.mode === 'formula'
                    ? showFormula(row.formula, hostel.rows)
                    : modeNames.manual;
              return (
                <tr key={row.id} data-highlight={row.highlight}>
                  <th scope="row">
                    <span className={styles.tableRowName} title={description}>
                      <ModeMark mode={row.mode} />
                      <span>{row.name.trim()}</span>
                    </span>
                  </th>
                  {days.map((day, index) => {
                    const cell = daily[index].get(row.id);
                    return (
                      <td key={day} data-current={day === sampleDay}>
                        {row.mode === 'manual' ? (
                          <input
                            className={styles.manualValue}
                            aria-label={`${row.name}, ${day} ноября`}
                            inputMode="numeric"
                            maxLength={8}
                            placeholder="—"
                            value={hostel.values[row.id]?.[day] ?? ''}
                            onChange={(event) => onValue(row.id, day, event.target.value)}
                          />
                        ) : cell?.error ? (
                          <span
                            className={styles.cellError}
                            title={cell.error}
                            aria-label={cell.error}
                          >
                            —
                          </span>
                        ) : cell?.value == null ? (
                          <span className={styles.missing}>—</span>
                        ) : (
                          <span className={cell.value < 0 ? styles.cellError : undefined}>
                            {cell.value.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function TemplateLibrary({
  templates,
  onClose,
  onUse,
}: {
  templates: Template[];
  onClose: () => void;
  onUse: (template: Template) => void;
}): JSX.Element {
  return (
    <Modal
      title="Шаблоны хостелов"
      testId="hostel-preview-templates"
      panelClassName={styles.libraryPanel}
      onClose={onClose}
    >
      <p className={styles.fieldHint}>
        Шаблон переносит строки, формулы и настройки связей. Дневные значения заполняются в новом
        хостеле.
      </p>
      <ul className={styles.library}>
        {templates.map((template) => (
          <li key={template.id}>
            <WorkspaceIcon name="document" />
            <div>
              <strong>{template.name}</strong>
              <small>
                {dormitories.find(({ id }) => id === template.dormitory)?.name} ·{' '}
                {template.rows.length} строк
              </small>
            </div>
            <button
              type="button"
              className={outline}
              onClick={() => onUse(template)}
              aria-label={`Использовать шаблон «${template.name}»`}
            >
              Использовать
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export default function HostelBuilderPreview(): JSX.Element {
  const [demo, setDemo] = useState(loadDemo);
  const [dormitory, setDormitory] = useState<Dormitory>('north');
  const [builder, setBuilder] = useState<{ hostel: Hostel; creating: boolean } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const current = demo.hostels.filter((hostel) => hostel.dormitory === dormitory);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(demo));
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [demo]);

  function create(template?: Template): void {
    setLibraryOpen(false);
    setBuilder({
      creating: true,
      hostel: {
        id: demoId(),
        name: '',
        dormitory,
        rows: template?.rows ?? [],
        values: {},
      },
    });
  }

  function save(hostel: Hostel): void {
    const creating = builder?.creating;
    setDemo((previous) => ({
      ...previous,
      hostels: creating
        ? [...previous.hostels, hostel]
        : previous.hostels.map((item) => (item.id === hostel.id ? hostel : item)),
    }));
    setBuilder(null);
    setNotice(
      creating
        ? `Хостел «${hostel.name}» создан.`
        : `Настройки хостела «${hostel.name}» сохранены.`,
    );
  }

  function setValue(hostelId: string, rowId: string, day: number, raw: string): void {
    if (!/^\d*$/u.test(raw)) return;
    setDemo((previous) => ({
      ...previous,
      hostels: previous.hostels.map((hostel) =>
        hostel.id === hostelId
          ? {
              ...hostel,
              values: { ...hostel.values, [rowId]: { ...hostel.values[rowId], [day]: raw } },
            }
          : hostel,
      ),
    }));
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brand}>
            <WorkspaceIcon name="house" /> Домовой
          </div>
          <span className={styles.demoTag}>Тестовая страница</span>
        </div>
      </header>
      <main className={styles.content}>
        <div className={styles.path}>
          <WorkspaceIcon name="building" /> Общежития <WorkspaceIcon name="chevron" />{' '}
          {dormitories.find(({ id }) => id === dormitory)?.name}
        </div>
        <div className={styles.pageHeading}>
          <div>
            <h1>Размещение персонала</h1>
            <p>Дневные показатели хостелов и настройки их расчёта.</p>
          </div>
          <div className={styles.topActions}>
            <button type="button" className={outline} onClick={() => setLibraryOpen(true)}>
              <WorkspaceIcon name="document" /> Шаблоны хостелов
            </button>
            <button type="button" className={primary} onClick={() => create()}>
              <span aria-hidden="true">+</span> Добавить хостел
            </button>
          </div>
        </div>

        <div className={styles.filters}>
          <label className={styles.field}>
            Общежитие
            <select
              value={dormitory}
              onChange={(event) => {
                setDormitory(event.target.value as Dormitory);
                setNotice('');
              }}
            >
              {dormitories.map(({ id, name }) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.period}>
            <span>Период примера</span>
            <strong>8–14 ноября 2026</strong>
          </div>
        </div>

        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        {storageFailed && (
          <p className={styles.error} role="alert">
            Хранилище браузера недоступно. Изменения сохраняются до перезагрузки страницы.
          </p>
        )}
        <section className={styles.placement} aria-label="Показатели хостелов">
          <div className={styles.legend}>
            {(Object.entries(modeNames) as [keyof typeof modeNames, string][]).map(
              ([mode, name]) => (
                <span key={mode}>
                  <ModeMark mode={mode} />
                  {name}
                </span>
              ),
            )}
          </div>
          {current.map((hostel) => (
            <HostelTable
              key={hostel.id}
              hostel={hostel}
              onEdit={() => setBuilder({ hostel, creating: false })}
              onValue={(rowId, day, raw) => setValue(hostel.id, rowId, day, raw)}
            />
          ))}
        </section>
      </main>
      {libraryOpen && (
        <TemplateLibrary
          templates={demo.templates}
          onClose={() => setLibraryOpen(false)}
          onUse={create}
        />
      )}
      {builder && (
        <HostelBuilder
          key={builder.hostel.id}
          hostel={builder.hostel}
          creating={builder.creating}
          templates={demo.templates}
          onClose={() => setBuilder(null)}
          onSave={save}
          onTemplateSave={(template) =>
            setDemo((previous) => ({ ...previous, templates: [...previous.templates, template] }))
          }
        />
      )}
    </div>
  );
}
