import { Dashboard } from './dashboard/Dashboard';
import { DashboardTariff } from './dashboard/DashboardTariff';

export function WorkspaceOverview(): JSX.Element {
  return <Dashboard tariffSlot={<DashboardTariff />} />;
}
