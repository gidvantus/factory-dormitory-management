import { useTrial } from '../auth/TrialProvider';
import { Dashboard } from './dashboard/Dashboard';
import { TariffPeriods } from './TariffPeriods';
import { TrialNotice } from './TrialNotice';
import styles from './Workspace.module.css';

/**
 * Обзор: он остаётся открытым и на закрытом кабинете, поэтому состояние
 * подписки живёт здесь.
 *
 * Порядок блоков — от срочного к подробному: предупреждение о сроке, оплаченные
 * периоды. Сам тариф с обзора убран (#124): его карточка стоит в левой панели
 * кабинета (`SidebarTariff`), а здесь о сроке говорит только предупреждение.
 * Предупреждение и периоды читают одну и ту же подписку
 * (`SubscriptionProvider`), поэтому запрос за ней один.
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
          <TariffPeriods />
        </div>
      }
    />
  );
}
