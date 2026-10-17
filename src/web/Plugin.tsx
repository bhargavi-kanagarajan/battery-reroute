/**
 * Plugin (task 15.3, 15.10; Req 13.1, 13.2, 13.7–13.9).
 *
 * Exactly two inputs: `role` and `identityId`. The Plugin validates them against
 * `/api/stakeholders`, loads the role-scoped battery list, and renders the view registered for
 * that role. While a request is pending it shows a LoadingIndicator; on error or timeout it keeps
 * the last good view (and its controls) on screen and shows an ErrorBanner naming the operation.
 */
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { isApiError, type ApiError, type BatteryListByRole, type RoleContext, type StakeholdersResponse } from './apiClient';
import { useApiClient } from './apiContext';
import { ErrorBanner, LoadingIndicator } from './components';
import { useRoleData } from './useRoleData';
import type { Role } from '../core/types';
import { EsgView } from './views/EsgView';
import { FleetView } from './views/FleetView';
import { OwnerView } from './views/OwnerView';
import { RecyclerView } from './views/RecyclerView';
import { SecondLifeView } from './views/SecondLifeView';
import { ServicePartnerView } from './views/ServicePartnerView';
import { ROLE_LABELS, type RoleViewProps } from './views/shared';

export const INVALID_SELECTION_TEXT = 'Invalid role or identity: no battery data can be shown.' as const;

type ViewRegistry = { [R in Role]: ComponentType<RoleViewProps<BatteryListByRole[R]>> };

/** Role → view component (task 15.10). */
export const VIEW_REGISTRY: ViewRegistry = {
  Owner: OwnerView,
  Fleet_Operator: FleetView,
  Service_Partner: ServicePartnerView,
  Second_Life_Provider: SecondLifeView,
  Recycler: RecyclerView,
  ESG_Officer: EsgView,
};

export interface PluginProps {
  role: string;
  identityId: string;
}

export function Plugin({ role, identityId }: PluginProps) {
  const client = useApiClient();
  const [directory, setDirectory] = useState<StakeholdersResponse | null>(null);
  const [directoryError, setDirectoryError] = useState<ApiError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .getStakeholders(controller.signal)
      .then((d) => {
        setDirectory(d);
        setDirectoryError(null);
      })
      .catch((err: unknown) => {
        if (isApiError(err) && err.code !== 'ABORTED') setDirectoryError(err);
      });
    return () => controller.abort();
  }, [client]);

  const valid = useMemo(() => {
    if (!directory) return null;
    if (!(directory.roles as string[]).includes(role)) return false;
    return directory.stakeholders[role as Role].some((s) => s.id === identityId);
  }, [directory, role, identityId]);

  const ctx: RoleContext | null = valid ? { role: role as Role, identityId } : null;
  const state = useRoleData(ctx, (c, signal) => client.listBatteries(c, signal), { operation: 'Loading batteries' });

  if (directoryError && !directory) {
    return <ErrorBanner operation={directoryError.operation} message={directoryError.detail} />;
  }
  if (!directory) return <LoadingIndicator />;
  if (valid === false) {
    return (
      <p className="br-error-banner" role="alert">
        {INVALID_SELECTION_TEXT}
      </p>
    );
  }

  const shown = state.data !== undefined && state.dataContext ? state.dataContext : null;
  const View = shown ? (VIEW_REGISTRY[shown.role] as ComponentType<RoleViewProps<unknown>>) : null;
  const viewerName = shown ? directory.stakeholders[shown.role].find((s) => s.id === shown.identityId)?.name : undefined;

  return (
    <div className="br-plugin" data-testid="plugin">
      {state.loading ? <LoadingIndicator /> : null}
      {state.error ? (
        <ErrorBanner operation={state.error.operation} message={state.error.detail} onDismiss={state.clearError} />
      ) : null}
      {shown && View ? (
        <>
          <h2 className="br-plugin__title">
            {ROLE_LABELS[shown.role]} view{viewerName ? `: ${viewerName}` : ''}
          </h2>
          <View
            key={`${shown.role}:${shown.identityId}`}
            ctx={shown}
            data={state.data}
            client={client}
            stakeholders={directory.stakeholders}
            refresh={state.refresh}
          />
        </>
      ) : null}
    </div>
  );
}
