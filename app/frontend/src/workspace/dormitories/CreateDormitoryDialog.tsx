import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { api, ApiError } from '../../api/client';
import type {
  Dormitory,
  ReportTemplate,
  TabCatalogItem,
  StructureTemplate,
  StructureTemplateDetail,
} from '../../api/client';
import { DormitoryTabPicker } from './DormitoryTabPicker';
import { Modal } from '../../components/Modal';
import styles from './Dormitories.module.css';
import creationStyles from './CreateDormitoryDialog.module.css';
import { standardTabs } from './tabStructure';

interface Props {
  onClose: () => void;
  onCreated: (dormitory: Dormitory) => void;
  triggerRef: RefObject<HTMLButtonElement>;
}

export function CreateDormitoryDialog({ onClose, onCreated, triggerRef }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templatesStatus, setTemplatesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [templatesAttempt, setTemplatesAttempt] = useState(0);
  const [catalog, setCatalog] = useState<TabCatalogItem[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string | null>>({});
  const [mode, setMode] = useState<'manual' | 'sample'>('manual');
  const [sample, setSample] = useState('');
  const [structures, setStructures] = useState<StructureTemplate[]>([]);
  const [structure, setStructure] = useState<StructureTemplateDetail | null>(null);
  const [structureKeys, setStructureKeys] = useState<string[]>([]);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState('');
  const [sampleAttempt, setSampleAttempt] = useState(0);
  const [errors, setErrors] = useState<{ name?: string; clientName?: string }>({});
  const [requestError, setRequestError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== 'sample') return;
    const controller = new AbortController();
    setSampleError('');
    void api
      .structureTemplates(controller.signal)
      .then((items) => {
        if (!Array.isArray(items)) throw new Error('Invalid templates');
        if (!controller.signal.aborted) setStructures(items);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSampleError('Не удалось загрузить сохранённые структуры.');
      });
    return () => controller.abort();
  }, [mode, sampleAttempt]);

  useEffect(() => {
    if (!sample.startsWith('template:')) return;
    const controller = new AbortController();
    setSampleLoading(true);
    setSampleError('');
    void api
      .structureTemplate(Number(sample.slice(9)), controller.signal)
      .then((item) => {
        if (!controller.signal.aborted) {
          setStructure(item);
          setStructureKeys([
            ...Object.entries(item.snapshot.sections)
              .filter(([, status]) => status !== 'deleted')
              .map(([key]) => key),
            ...item.snapshot.tabs.map((tab) => tab.key),
          ]);
          setSampleLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setSampleError(
            caught instanceof ApiError ? caught.message : 'Не удалось загрузить структуру.',
          );
          setSampleLoading(false);
        }
      });
    return () => controller.abort();
  }, [sample, sampleAttempt]);

  const samples = [
    ...new Map(
      catalog
        .flatMap((item) => item.variants)
        .filter((item) => item.dormitory_id)
        .map((item) => [item.dormitory_id, item]),
    ).values(),
  ];
  const preview =
    mode === 'sample' && structure
      ? [
          ...Object.entries(structure.snapshot.sections)
            .filter(([key, state]) => state !== 'deleted' && structureKeys.includes(key))
            .map(([key]) => ({
              key,
              name: standardTabs.find((tab) => tab.path === key)?.label ?? key,
              parent: structure.snapshot.parents[key],
              columns:
                structure.snapshot.columns[key]?.filter(
                  (col) => !col.archived && col.kind !== 'action',
                ).length ?? 0,
            })),
          ...structure.snapshot.tabs
            .filter((tab) => structureKeys.includes(tab.key))
            .map((tab) => ({
              ...tab,
              columns:
                structure.snapshot.columns[tab.key]?.filter(
                  (col) => !col.archived && col.kind !== 'action',
                ).length ?? 0,
            })),
        ]
      : catalog.flatMap((item) => {
          const source = item.variants.find((variant) => variant.id === selectedTabs[item.id]);
          if (!source) return [];
          return [
            {
              key: item.name.toLocaleLowerCase('ru'),
              name: item.name,
              parent: source.parent_name?.toLocaleLowerCase('ru') ?? null,
              columns: null,
            },
          ];
        });
  function depth(key: string): number {
    const visited = new Set<string>();
    let current = preview.find((item) => item.key === key);
    let count = 0;
    while (current?.parent && !visited.has(current.parent)) {
      visited.add(current.parent);
      current = preview.find((item) => item.key === current?.parent);
      if (current) count++;
    }
    return count;
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const trigger = triggerRef.current;
    return () => {
      document.body.style.overflow = previousOverflow;
      trigger?.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  useEffect(() => {
    const controller = new AbortController();
    setTemplatesStatus('loading');
    void api
      .reportTemplates(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(items)) throw new Error('Invalid templates response');
          setTemplates(items);
          setTemplatesStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setTemplatesStatus('error');
      });
    return () => controller.abort();
  }, [templatesAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogStatus('loading');
    void api
      .tabCatalog(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(items)) throw new Error('Invalid tab catalog');
          setCatalog(items);
          setSelectedTabs((current) =>
            Object.fromEntries(
              items.map((item) => [
                item.id,
                item.id in current
                  ? item.variants.some((variant) => variant.id === current[item.id])
                    ? current[item.id]
                    : null
                  : (item.variants.find((variant) => variant.id.startsWith('standard:0:'))?.id ??
                    null),
              ]),
            ),
          );
          setCatalogStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogStatus('error');
      });
    return () => controller.abort();
  }, [catalogAttempt]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const normalizedName = name.trim().replace(/\s+/g, ' ');
    const normalizedClient = clientName.trim().replace(/\s+/g, ' ');
    const found: typeof errors = {};
    if (!normalizedName) found.name = 'Укажите название общежития';
    else if (normalizedName.length > 255) found.name = 'Не более 255 символов';
    if (!normalizedClient) found.clientName = 'Укажите название клиента';
    else if (normalizedClient.length > 255) found.clientName = 'Не более 255 символов';
    setErrors(found);
    setRequestError('');
    if (found.name || found.clientName) {
      (found.name ? nameRef : clientRef).current?.focus();
      return;
    }
    if (catalogStatus !== 'ready') return;
    if (
      mode === 'sample' &&
      (!sample || sampleLoading || (sample.startsWith('template:') && !structure))
    ) {
      setRequestError('Выберите и дождитесь загрузки образца.');
      return;
    }

    inFlight.current = true;
    setSaving(true);
    try {
      const created = await api.createDormitory({
        name: normalizedName,
        client_name: normalizedClient,
        ...(mode === 'sample' && structure
          ? { structure_template_id: structure.id, structure_template_keys: structureKeys }
          : {
              ...(templateId ? { template_id: Number(templateId) } : {}),
              tabs: Object.values(selectedTabs)
                .filter((id): id is string => !!id)
                .map((source_id) => ({ source_id })),
            }),
      });
      onCreated(created);
    } catch (error) {
      setRequestError(
        error instanceof ApiError && error.status === 401
          ? 'Сессия завершилась. Войдите в аккаунт снова.'
          : error instanceof ApiError
            ? error.message
            : 'Не удалось создать общежитие. Проверьте соединение и попробуйте ещё раз.',
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <Modal
      title="Создать общежитие"
      testId="create-dormitory-modal"
      onClose={onClose}
      closeDisabled={saving}
      panelClassName={creationStyles.panel}
      containerClassName={creationStyles.overlay}
    >
      <form
        className={creationStyles.form}
        noValidate
        onSubmit={(event) => void submit(event)}
        aria-busy={saving}
      >
        <div className={creationStyles.fields}>
          <div className="field">
            <label className="field__label" htmlFor="dormitory-name">
              Название общежития
            </label>
            <input
              className="field__input"
              id="dormitory-name"
              data-testid="dormitory-name"
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={255}
              required
              disabled={saving}
              placeholder="Например, Северное"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'dormitory-name-error' : undefined}
            />
            {errors.name && (
              <p className="field__error" id="dormitory-name-error" role="alert">
                {errors.name}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="dormitory-client-name">
              Название клиента
            </label>
            <input
              className="field__input"
              id="dormitory-client-name"
              data-testid="dormitory-client-name"
              ref={clientRef}
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
              maxLength={255}
              required
              disabled={saving}
              placeholder="Например, Стройкомплект"
              aria-invalid={!!errors.clientName}
              aria-describedby={errors.clientName ? 'dormitory-client-error' : undefined}
            />
            {errors.clientName && (
              <p className="field__error" id="dormitory-client-error" role="alert">
                {errors.clientName}
              </p>
            )}
          </div>
          <div className={creationStyles.modes} role="group" aria-label="Способ создания структуры">
            <button
              type="button"
              aria-pressed={mode === 'manual'}
              disabled={saving}
              onClick={() => {
                setMode('manual');
                setSample('');
                setStructure(null);
              }}
            >
              Выбрать вручную
            </button>
            <button
              type="button"
              aria-pressed={mode === 'sample'}
              disabled={saving}
              onClick={() => {
                setMode('sample');
                setTemplateId('');
              }}
            >
              По образцу
            </button>
          </div>
          {mode === 'sample' && (
            <div className="field">
              <label className="field__label" htmlFor="dormitory-sample">
                Образец структуры
              </label>
              <select
                className="field__input"
                id="dormitory-sample"
                value={sample}
                disabled={saving || catalogStatus !== 'ready'}
                onChange={(event) => {
                  const value = event.target.value;
                  setSample(value);
                  setStructure(null);
                  setSampleError('');
                  setSampleLoading(false);
                  if (value.startsWith('dorm:'))
                    setSelectedTabs(
                      Object.fromEntries(
                        catalog.map((item) => [
                          item.id,
                          item.variants.find(
                            (variant) => variant.dormitory_id === Number(value.slice(5)),
                          )?.id ?? null,
                        ]),
                      ),
                    );
                }}
              >
                <option value="">Выберите общежитие или шаблон</option>
                <optgroup label="Сохранённые структуры">
                  {structures.map((item) => (
                    <option key={item.id} value={`template:${item.id}`}>
                      {item.name} · {item.tab_count} вкладок
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Существующие общежития">
                  {samples.map((item) => (
                    <option key={item.dormitory_id} value={`dorm:${item.dormitory_id}`}>
                      {item.client_name} · {item.dormitory_name}
                    </option>
                  ))}
                </optgroup>
              </select>
              {sampleLoading && <p role="status">Загружаем структуру…</p>}
              {sampleError && (
                <p role="alert">
                  {sampleError}{' '}
                  <button type="button" onClick={() => setSampleAttempt((value) => value + 1)}>
                    Повторить загрузку образцов
                  </button>
                </p>
              )}
            </div>
          )}
          {mode === 'manual' && (
            <div className="field">
              <label className="field__label" htmlFor="dormitory-template">
                Шаблон отчёта <span className={styles.optional}>(необязательно)</span>
              </label>
              <select
                className="field__input"
                id="dormitory-template"
                data-testid="dormitory-template"
                value={templateId}
                onChange={(event) => {
                  setTemplateId(event.target.value);
                  const report = catalog.find((item) =>
                    item.variants.some((variant) => variant.section_key === 'report'),
                  );
                  if (event.target.value && report && !selectedTabs[report.id])
                    setSelectedTabs((items) => ({ ...items, [report.id]: report.variants[0].id }));
                }}
                disabled={saving || templatesStatus !== 'ready'}
              >
                <option value="">Без шаблона</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {template.row_count} строк
                  </option>
                ))}
              </select>
              {templatesStatus === 'loading' && (
                <p className={styles.templateHint}>Загружаем шаблоны…</p>
              )}
              {templatesStatus === 'error' && (
                <p className={styles.templateHint}>
                  Не удалось загрузить шаблоны.{' '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setTemplatesAttempt((value) => value + 1)}
                  >
                    Повторить
                  </button>
                </p>
              )}
              {templateId && (
                <p className={styles.templateHint}>
                  Скопируются только строки и формулы. Значения останутся пустыми.
                </p>
              )}
            </div>
          )}
          {catalogStatus === 'loading' && <p role="status">Загружаем доступные вкладки…</p>}
          {catalogStatus === 'error' && (
            <p role="alert">
              Не удалось загрузить список вкладок.{' '}
              <button type="button" onClick={() => setCatalogAttempt((value) => value + 1)}>
                Повторить загрузку вкладок
              </button>
            </p>
          )}
          {mode === 'sample' && structure && (
            <fieldset className={creationStyles.snapshotPicker} disabled={saving}>
              <legend>Вкладки нового общежития</legend>
              <p>
                Отметьте нужные вкладки. Без выбранного родителя подвкладка станет самостоятельной.
              </p>
              {[
                ...Object.entries(structure.snapshot.sections)
                  .filter(([, state]) => state !== 'deleted')
                  .map(([key]) => ({
                    key,
                    name: standardTabs.find((tab) => tab.path === key)?.label ?? key,
                  })),
                ...structure.snapshot.tabs,
              ].map((item) => (
                <label key={item.key}>
                  <input
                    type="checkbox"
                    checked={structureKeys.includes(item.key)}
                    onChange={(event) =>
                      setStructureKeys((current) =>
                        event.target.checked
                          ? [...current, item.key]
                          : current.filter((key) => key !== item.key),
                      )
                    }
                  />
                  {item.name}
                </label>
              ))}
            </fieldset>
          )}
          {catalogStatus === 'ready' &&
            (mode === 'manual' || (sample.startsWith('dorm:') && !sampleLoading)) && (
              <DormitoryTabPicker
                items={catalog}
                selected={selectedTabs}
                disabled={saving}
                onChange={(selected) => {
                  setSelectedTabs(selected);
                  const report = catalog.find((item) =>
                    item.variants.some((variant) => variant.section_key === 'report'),
                  );
                  if (report && !selected[report.id]) setTemplateId('');
                }}
              />
            )}
        </div>
        <aside className={creationStyles.preview} aria-label="Предпросмотр структуры">
          <p className={creationStyles.eyebrow}>ПРЕДПРОСМОТР</p>
          <h3>{name.trim() || 'Новое общежитие'}</h3>
          <p>{clientName.trim() || 'Название клиента'}</p>
          <div className={creationStyles.previewTree}>
            {preview.map((item) => (
              <div key={item.key} style={{ paddingLeft: 12 + depth(item.key) * 16 }}>
                <span>{item.name}</span>
                {item.columns !== null && item.columns > 0 && <small>{item.columns} ст.</small>}
              </div>
            ))}
          </div>
          <p className={creationStyles.note}>
            Только структура, без записей. Изменения образца не повлияют на новое общежитие.
          </p>
        </aside>
        {requestError && (
          <p className="alert alert--error" role="alert">
            {requestError}
          </p>
        )}
        <div className={`dialog-actions ${creationStyles.actions}`}>
          <button type="button" className="btn btn--ghost" disabled={saving} onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            aria-busy={saving}
            disabled={
              saving ||
              catalogStatus !== 'ready' ||
              sampleLoading ||
              (mode === 'sample' && (!sample || (sample.startsWith('template:') && !structure)))
            }
            data-testid="create-dormitory-submit"
          >
            Создать
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
