/**
 * Host page (task 15.3; Req 13.5): one Role_Switcher and one Plugin on a single page.
 */
import { useEffect, useState } from 'react';
import { isApiError, type ApiError, type StakeholdersResponse } from './apiClient';
import { useApiClient } from './apiContext';
import { ErrorBanner, LoadingIndicator } from './components';
import { Plugin } from './Plugin';
import { RoleSwitcher, firstIdentity, type RoleSelection } from './RoleSwitcher';

export function HostPage() {
  const client = useApiClient();
  const [directory, setDirectory] = useState<StakeholdersResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selection, setSelection] = useState<RoleSelection | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .getStakeholders(controller.signal)
      .then((d) => {
        setDirectory(d);
        const role = d.roles[0] ?? 'Owner';
        setSelection({ role, identityId: firstIdentity(d, role) });
      })
      .catch((err: unknown) => {
        if (isApiError(err) && err.code !== 'ABORTED') setError(err);
      });
    return () => controller.abort();
  }, [client]);

  return (
    <div className="br-page">
      <header className="br-header">
        <div>
          <h1>Battery ReRoute</h1>
          <p className="br-tagline">Routing every retired battery to its next best life</p>
        </div>
        {directory && selection ? <RoleSwitcher directory={directory} value={selection} onChange={setSelection} /> : null}
      </header>
      <main className="br-main">
        {error ? <ErrorBanner operation={error.operation} message={error.detail} /> : null}
        {!directory && !error ? <LoadingIndicator /> : null}
        {selection ? <Plugin role={selection.role} identityId={selection.identityId} /> : null}
      </main>
      <footer className="br-footer">
        Prototype with synthetic data. The role switcher stands in for login; recommendations are decision support only.
      </footer>
    </div>
  );
}
