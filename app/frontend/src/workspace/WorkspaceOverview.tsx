import { Dashboard } from './dashboard/Dashboard';
import { DashboardTariff } from './dashboard/DashboardTariff';
import { TrialNotice } from './TrialNotice';

/**
 * Обзор: он остаётся открытым и на закрытом кабинете, поэтому сообщение о
 * пробном периоде живёт здесь — выше показателей и рядом с карточкой тарифа.
 */
export function WorkspaceOverview(): JSX.Element {
  return (
    <Dashboard
      tariffSlot={
        <>
          <TrialNotice />
          <DashboardTariff />
        </>
      }
    />
  );
}
