import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useSearchParams } from 'react-router-dom';
import { personnelApi } from '../../api/personnel';
import type { PersonnelData } from '../../api/personnel';
import { ApiError } from '../../api/client';
import { personnelBuilderApi, serverState } from '../../api/personnelBuilder';
import type { BuilderCatalog } from '../../api/personnelBuilder';
import { useUnsavedChanges } from '../../components/useUnsavedChanges';
import { PersonnelTabBuilder } from '../../pages/personnel-tab-builder/PersonnelTabBuilder';
import { emptyBuilderState } from '../../pages/personnel-tab-builder/model';
import type { DemoState } from '../../pages/personnel-tab-builder/model';
import { BuilderEnvironmentContext } from '../../pages/personnel-tab-builder/BuilderEnvironment';
import { usePageRefresh } from '../usePageRefresh';
import s from '../../pages/personnel-tab-builder/Tabs.module.css';

const signature = (state: DemoState): string => JSON.stringify(serverState(state));
const hydrate = (state: DemoState): DemoState => ({
  ...state,
  tabs: [...emptyBuilderState().tabs, ...state.tabs.filter((tab) => !tab.builtin)],
});
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось сохранить настройки';

/** Рабочий конструктор: только API организации; локальные примеры сюда не загружаются. */
export function PersonnelWithBuilder(): JSX.Element {
  const [state, setLocalState] = useState(emptyBuilderState);
  const [data, setData] = useState<PersonnelData | null>(null);
  const [catalog, setCatalog] = useState<BuilderCatalog>({ sources: [], templates: [] });
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [structureRevision, setStructureRevision] = useState(0);
  const savedStructure = useRef('');
  const trackStructure = useCallback((next: DemoState) => {
    const key = JSON.stringify(
      next.tabs.map((tab) => [
        tab.id,
        tab.columns.map((column) => [column.id, column.archived]),
        tab.rows.map((row) => row.id),
      ]),
    );
    if (key !== savedStructure.current) {
      savedStructure.current = key;
      setStructureRevision((value) => value + 1);
    }
  }, []);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [params, setParams] = useSearchParams();
  const refresh = usePageRefresh();
  const latest = useRef(state);
  const acknowledged = useRef<string | null>(null);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const changedVersion = useRef(0);
  const dataRequest = useRef<Promise<void> | null>(null);
  const drafts = useRef(new Set<string>());
  const registerDraft = useCallback((id: string, active: boolean) => {
    if (active) {
      drafts.current.add(id);
      changedVersion.current++;
    } else drafts.current.delete(id);
  }, []);
  const serialized = signature(state);
  const dirty = ready && serialized !== saved;
  useUnsavedChanges(dirty || saving, { ignoreSearch: true });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const version = changedVersion.current;
    if (
      inFlight.current ||
      drafts.current.size > 0 ||
      (acknowledged.current !== null && signature(latest.current) !== acknowledged.current)
    ) {
      setReading(false);
      return;
    }
    setReading(true);
    void personnelBuilderApi
      .read(controller.signal)
      .then((document) => {
        if (controller.signal.aborted || changedVersion.current !== version) return;
        const next = hydrate(document.state);
        revision.current = document.revision;
        latest.current = next;
        acknowledged.current = signature(next);
        setLocalState(next);
        setSaved(signature(next));
        trackStructure(next);
        setReady(true);
        setError('');
        setConflict(false);
        if (
          !params.has('tab') &&
          !params.has('view') &&
          document.state.defaultTab !== 'workspace'
        ) {
          setParams(
            document.state.defaultTab === 'employees'
              ? { view: 'list' }
              : document.state.defaultTab === 'planning'
                ? { view: 'planning' }
                : { tab: document.state.defaultTab },
            { replace: true },
          );
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
    // Обновление источников не должно менять выбранную вкладку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, refresh]);

  const receiveData = useCallback((value: PersonnelData) => setData(value), []);
  const loadData = useCallback(async (): Promise<void> => {
    if (dataRequest.current) return dataRequest.current;
    const task = Promise.all([
      data ? Promise.resolve(data) : personnelApi.workspace(),
      personnelBuilderApi.sources(),
    ])
      .then(([people, sources]) => {
        if (!mounted.current) return;
        setData(people);
        if (sources) {
          setCatalog(sources);
        }
      })
      .finally(() => {
        dataRequest.current = null;
      });
    dataRequest.current = task;
    return task;
  }, [data]);
  const activeCustom = state.tabs.some(
    (tab) => !tab.builtin && tab.id === (params.get('tab') ?? state.defaultTab),
  );
  useEffect(() => {
    if (!ready || !activeCustom) return;
    void loadData().catch((caught) => {
      if (mounted.current) setError(errorText(caught));
    });
  }, [ready, activeCustom, loadData]);

  const setState: Dispatch<SetStateAction<DemoState>> = useCallback(
    (value) => {
      const next = typeof value === 'function' ? value(latest.current) : value;
      latest.current = next;
      changedVersion.current++;
      setLocalState(next);
      setError((previous) => (conflict ? previous : ''));
    },
    [conflict],
  );
  useEffect(() => {
    if (!ready || !dirty || reading || inFlight.current || error || conflict) return;
    const timer = setTimeout(() => {
      const snapshot = latest.current;
      const sent = signature(snapshot);
      inFlight.current = true;
      setSaving(true);
      void personnelBuilderApi
        .save({ revision: revision.current, state: snapshot })
        .then((document) => {
          revision.current = document.revision;
          acknowledged.current = sent;
          if (mounted.current) {
            setSaved(sent);
            trackStructure(snapshot);
            setError('');
          }
        })
        .catch((caught) => {
          if (mounted.current) {
            setError(errorText(caught));
            setConflict(caught instanceof ApiError && caught.status === 409);
          }
        })
        .finally(() => {
          inFlight.current = false;
          if (mounted.current) {
            setSaving(false);
            setPulse((value) => value + 1);
          }
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [ready, dirty, serialized, error, conflict, pulse, reading, trackStructure]);
  const environment = useMemo(
    () => ({
      ...catalog,
      evaluate: personnelBuilderApi.evaluate,
      registerDraft,
      structureRevision,
    }),
    [catalog, registerDraft, structureRevision],
  );
  function downloadDraft(): void {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(serverState(latest.current), null, 2)], {
        type: 'application/json',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'personnel-builder-draft.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reload(): void {
    if (
      dirty &&
      !window.confirm(
        'Заменить несохранённый черновик версией с сервера? При необходимости сначала скачайте копию.',
      )
    )
      return;
    setReading(true);
    acknowledged.current = signature(latest.current);
    setError('');
    setConflict(false);
    setAttempt((value) => value + 1);
  }
  return (
    <BuilderEnvironmentContext.Provider value={environment}>
      {error && (
        <div className={s.selection} role="alert">
          <p>{error}</p>
          <div className={s.buttons}>
            {!conflict && (
              <button
                className="btn btn--outline btn--compact"
                onClick={() => {
                  setError('');
                  if (ready) setPulse((value) => value + 1);
                  else setAttempt((value) => value + 1);
                }}
              >
                Повторить
              </button>
            )}
            {dirty && (
              <button className="btn btn--outline btn--compact" onClick={downloadDraft}>
                Скачать черновик
              </button>
            )}
            {ready && (
              <button className="btn btn--outline btn--compact" onClick={reload}>
                Загрузить актуальную версию
              </button>
            )}
          </div>
        </div>
      )}
      <PersonnelTabBuilder
        runtime={{ state, setState, data, ready, loadData, onNativeData: receiveData }}
      />
      {ready && (
        <p className={s.pageFoot} role="status">
          {saving
            ? 'Сохраняем изменения…'
            : dirty
              ? 'Есть несохранённые изменения.'
              : 'Изменения конструктора сохранены.'}
        </p>
      )}
    </BuilderEnvironmentContext.Provider>
  );
}
