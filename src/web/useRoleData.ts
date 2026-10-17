/**
 * Data hook for role views (task 15.1; Req 13.2, 13.7, 13.8).
 *
 * - Loads data for the current Role_Switcher selection and reloads when the role, identity,
 *   or `key` changes.
 * - Discards stale responses: a new load aborts the previous request, and any response that
 *   arrives for a superseded request is ignored.
 * - On error or timeout it keeps the last good `data` (and `dataContext`), and exposes the
 *   `ApiError`, whose message names the failed operation.
 * - `refresh()` re-runs the loader (e.g. after a command); `setData()` applies a command's
 *   returned view without a round trip.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type RoleContext } from './apiClient';

export type RoleDataLoader<T> = (ctx: RoleContext, signal: AbortSignal) => Promise<T>;

export interface RoleDataOptions {
  /** Extra reload trigger (e.g. a selected battery ID). */
  key?: string;
  /** Operation name used when the loader throws a non-ApiError. Default "Loading data". */
  operation?: string;
}

export interface RoleDataState<T> {
  /** Last successfully loaded data (kept on error). */
  data: T | undefined;
  /** The selection `data` was loaded for; may differ from the current selection after an error. */
  dataContext: RoleContext | undefined;
  /** True while a request for the current selection is in flight. */
  loading: boolean;
  /** Error of the most recent load, cleared when a load succeeds. */
  error: ApiError | undefined;
  /** Reloads for the current selection; resolves when that load settles (never rejects). */
  refresh: () => Promise<void>;
  setData: (update: T | ((prev: T | undefined) => T)) => void;
  clearError: () => void;
}

function toApiError(err: unknown, operation: string): ApiError {
  if (err instanceof ApiError) return err;
  const detail = err instanceof Error && err.message ? err.message : 'Unexpected error';
  return new ApiError(operation, 'NETWORK', detail);
}

export function useRoleData<T>(
  ctx: RoleContext | null,
  load: RoleDataLoader<T>,
  options: RoleDataOptions = {},
): RoleDataState<T> {
  const { key = '', operation = 'Loading data' } = options;
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [dataContext, setDataContext] = useState<RoleContext | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  // The loader is usually an inline closure; keep the latest one without re-triggering loads.
  const loadRef = useRef(load);
  loadRef.current = load;
  const seqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const role = ctx?.role;
  const identityId = ctx?.identityId;

  const run = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const seq = ++seqRef.current;
    if (role === undefined || identityId === undefined) {
      controllerRef.current = null;
      setLoading(false);
      return;
    }
    const current: RoleContext = { role, identityId };
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const result = await loadRef.current(current, controller.signal);
      if (!mountedRef.current || seq !== seqRef.current) return; // stale
      setDataState(() => result);
      setDataContext(current);
      setError(undefined);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return; // stale or superseded
      const apiErr = toApiError(err, operation);
      if (apiErr.code === 'ABORTED') return;
      setError(apiErr);
      setLoading(false);
    }
  }, [role, identityId, key, operation]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const setData = useCallback((update: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof update === 'function' ? (update as (p: T | undefined) => T)(prev) : update));
  }, []);

  const clearError = useCallback(() => setError(undefined), []);

  return { data, dataContext, loading, error, refresh: run, setData, clearError };
}
