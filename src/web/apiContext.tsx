/**
 * React context that supplies the ApiClient to the Plugin and its views, so tests can inject
 * a client built with a mocked `fetch`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createApiClient, type ApiClient } from './apiClient';

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client?: ApiClient; children: ReactNode }) {
  const value = useMemo(() => client ?? createApiClient(), [client]);
  return <ApiClientContext.Provider value={value}>{children}</ApiClientContext.Provider>;
}

let fallback: ApiClient | null = null;

/** The provided client, or a default same-origin client when no provider is present. */
export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client) return client;
  fallback ??= createApiClient();
  return fallback;
}
