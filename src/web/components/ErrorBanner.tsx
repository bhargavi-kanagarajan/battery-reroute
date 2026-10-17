export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorBannerProps {
  /** Name of the failed operation, e.g. "Saving consent" (Req 13.8). */
  operation: string;
  /** Error message returned by the server or client. */
  message: string;
  /** Per-field validation errors (VALIDATION_ERROR `fields`), listed under the message. */
  fields?: readonly FieldError[];
  /** When provided, a "Dismiss" button is rendered. */
  onDismiss?: () => void;
}

/**
 * Error announcement naming the failed operation (Req 7.11, 7.12, 8.10, 8.13, 13.8).
 * Uses role="alert" so assistive technologies announce it immediately; the "Error:"
 * prefix means meaning is not conveyed by color alone.
 */
export function ErrorBanner({ operation, message, fields, onDismiss }: ErrorBannerProps) {
  return (
    <div className="br-error-banner" role="alert">
      <p>
        <strong>Error:</strong> {operation} failed: {message}
      </p>
      {fields && fields.length > 0 ? (
        <ul aria-label="Invalid fields">
          {fields.map((f, i) => (
            <li key={`${f.field}-${i}`}>
              <code>{f.field}</code>: {f.message}
            </li>
          ))}
        </ul>
      ) : null}
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label={`Dismiss ${operation} error`}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
