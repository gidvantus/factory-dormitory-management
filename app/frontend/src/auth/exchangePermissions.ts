import { createContext, useContext } from 'react';

export interface ExchangePermissions {
  import_enabled: boolean;
  export_enabled: boolean;
  overview_enabled?: boolean;
  dormitories_enabled?: boolean;
  personnel_enabled?: boolean;
  statistics_enabled?: boolean;
  documents_enabled?: boolean;
  shop_enabled?: boolean;
  organization_enabled?: boolean;
  members_enabled?: boolean;
  profile_enabled?: boolean;
}

export const NO_EXCHANGE_PERMISSIONS: ExchangePermissions = {
  import_enabled: false,
  export_enabled: false,
};

export const ExchangePermissionsContext = createContext(NO_EXCHANGE_PERMISSIONS);

export function useExchangePermissions(): ExchangePermissions {
  return useContext(ExchangePermissionsContext);
}
