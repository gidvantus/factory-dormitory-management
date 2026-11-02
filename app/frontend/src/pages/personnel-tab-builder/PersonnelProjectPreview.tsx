import { useEffect, useState, useSyncExternalStore } from 'react';
import { installSandboxApis } from '../constructor-sandbox/api';
import { PersonnelTabBuilder } from './PersonnelTabBuilder';
import { installProjectPersonnelApis, PROJECT_DATA_KEY, projectStore } from './projectApi';

export function PersonnelProjectPreview(): JSX.Element {
  const [{ store, details }] = useState(projectStore);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const revision = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    const restoreBase = installSandboxApis(store);
    const restorePersonnel = installProjectPersonnelApis(store, details);
    setReady(true);
    return () => {
      restorePersonnel();
      restoreBase();
    };
  }, [store, details]);
  useEffect(() => {
    try {
      localStorage.setItem(
        PROJECT_DATA_KEY,
        JSON.stringify({ personnel: store.personnel, details }),
      );
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [store, details, revision]);
  if (!ready) return <p role="status">Открываем тестовую копию страницы «Персонал»…</p>;
  return (
    <>
      {storageError && (
        <p role="alert">
          Браузер не разрешил сохранить тестовые изменения. До перезагрузки все действия доступны.
        </p>
      )}
      <PersonnelTabBuilder project projectData={store.personnel} />
    </>
  );
}
