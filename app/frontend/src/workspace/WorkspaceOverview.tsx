import { useTrial } from '../auth/TrialProvider';
import { Dashboard } from './dashboard/Dashboard';
import { DashboardTariff } from './dashboard/DashboardTariff';
import { TrialNotice } from './TrialNotice';
import styles from './Workspace.module.css';

/**
 * Обзор: он остаётся открытым и на закрытом кабинете, поэтому состояние
 * пробного периода живёт здесь.
 *
 * Тариф и срок пробного периода — компактная лента. Дополнительное предупреждение
 * остаётся только у закрытого кабинета, чтобы объяснить недоступность разделов.
 */
export function WorkspaceOverview(): JSX.Element {
  const { state } = useTrial();
  const highlighted = state !== null && (state.locked || state.is_active);

  return (
    <Dashboard
      tariffSlot={
        <div
          className={styles['trial-card-block']}
          data-trial={highlighted ? 'true' : 'false'}
          data-locked={state?.locked ? 'true' : 'false'}
          data-testid="trial-tariff-block"
        >
          <TrialNotice />
          <DashboardTariff />
        </div>
      }
    />
  );
}
