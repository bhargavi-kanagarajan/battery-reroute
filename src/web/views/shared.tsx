/**
 * Small helpers shared by the role views (task 15.4–15.9).
 */
import { useCallback, useState, type ReactNode } from 'react';
import { ApiError, isApiError, type ApiClient, type RoleContext, type StakeholdersResponse } from '../apiClient';
import { ErrorBanner, StatusMessage } from '../components';
import type { RemainingLifeView } from '../../core/projection';
import type { ConsentStatus, Role } from '../../core/types';

/** Props every role view receives from the Plugin. */
export interface RoleViewProps<T> {
  /** The selection `data` was loaded for (commands run as this role and identity). */
  ctx: RoleContext;
  data: T;
  client: ApiClient;
  stakeholders: StakeholdersResponse['stakeholders'];
  /** Reloads the view after a command. */
  refresh: () => Promise<void>;
}

export const ROLE_LABELS: Record<Role, string> = {
  Owner: 'EV owner',
  Fleet_Operator: 'Fleet operator',
  Service_Partner: 'Service partner',
  Second_Life_Provider: 'Second-life provider',
  Recycler: 'Recycler',
  ESG_Officer: 'ESG officer',
};

/** Local calendar date as YYYY-MM-DD, used as the default value of date inputs. */
export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysLocal(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatRemainingLife(rl: RemainingLifeView): string {
  if ('unknown' in rl) return 'unknown';
  return `${rl.months} months / ${rl.cycles} cycles`;
}

export function consentLabel(status: ConsentStatus): string {
  return status === 'granted' ? 'granted' : 'not granted';
}

export function stakeholderName(
  stakeholders: StakeholdersResponse['stakeholders'],
  role: Role,
  id: string,
): string {
  return stakeholders[role].find((s) => s.id === id)?.name ?? id;
}

export function Card({ title, children, testId }: { title: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="br-card" data-testid={testId}>
      <h3 className="br-card__title">{title}</h3>
      {children}
    </section>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="br-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Runs a command, tracking busy state, the last error (shown by <ActionFeedback/>) and an
 * optional success message. Returns true on success.
 */
export function useCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [success, setSuccess] = useState<ReactNode>(null);

  const run = useCallback(async (fn: () => Promise<unknown>, onSuccess?: ReactNode): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    setSuccess(null);
    try {
      await fn();
      if (onSuccess !== undefined) setSuccess(onSuccess);
      return true;
    } catch (err) {
      setError(isApiError(err) ? err : new ApiError('Saving change', 'NETWORK', err instanceof Error ? err.message : 'Unexpected error'));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, success, run, clearError: () => setError(undefined), clearSuccess: () => setSuccess(null) };
}

export function ActionFeedback({ command }: { command: ReturnType<typeof useCommand> }) {
  return (
    <>
      {command.error ? (
        <ErrorBanner
          operation={command.error.operation}
          message={command.error.detail}
          fields={command.error.fields}
          onDismiss={command.clearError}
        />
      ) : null}
      {command.success ? <StatusMessage>{command.success}</StatusMessage> : null}
    </>
  );
}

/** Inline message for one field of a VALIDATION_ERROR, if the server named it. */
export function FieldMessage({ error, field }: { error: ApiError | undefined; field: string }) {
  const msg = error?.fields.find((f) => f.field === field || f.field.startsWith(`${field}.`))?.message;
  if (!msg) return null;
  return <span className="br-field-error">{msg}</span>;
}
