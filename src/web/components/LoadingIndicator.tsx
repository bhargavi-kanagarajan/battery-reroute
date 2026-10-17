import type { ReactNode } from 'react';

export const DEFAULT_LOADING_LABEL = 'Loading battery data' as const;

export interface LoadingIndicatorProps {
  /** Accessible name; defaults to "Loading battery data" (Req 13.7). */
  label?: string;
}

/** Polite live region shown while awaiting the API_Server (Req 13.7). */
export function LoadingIndicator({ label = DEFAULT_LOADING_LABEL }: LoadingIndicatorProps) {
  return (
    <div className="br-loading" role="status" aria-live="polite" aria-label={label}>
      {label}…
    </div>
  );
}

export interface StatusMessageProps {
  children: ReactNode;
}

/** Polite live region for success confirmations (e.g. return accepted, referral sent). */
export function StatusMessage({ children }: StatusMessageProps) {
  return (
    <div className="br-status" role="status" aria-live="polite">
      {children}
    </div>
  );
}
