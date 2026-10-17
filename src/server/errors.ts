/**
 * API error shape and HTTP status mapping (design "Error Handling").
 *
 * Every API error body is `{ error: { code, message, fields? } }`. Handlers throw `HttpError`
 * (or return a `DomainError` through `fromDomainError`); the app's error middleware serializes it.
 */
import type { ApiErrorBody, DomainError, ErrorCode, FieldError } from '../core/types';

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_ROLE_CONTEXT: 400,
  ACCESS_DENIED: 403,
  ACTION_NOT_PERMITTED: 403,
  VALIDATION_ERROR: 422,
  DUPLICATE_BATTERY_ID: 409,
  CUSTODY_APPEND_ONLY: 409,
  EOL_EXISTS: 409,
  NOT_DATA_OWNER: 403,
  OFFER_NOT_ACCEPTABLE: 409,
  NOT_CURRENT_HOLDER: 409,
  NO_INSPECTION_FLAG: 409,
  SAFETY_FLAGGED: 409,
  NOT_AVAILABLE: 409,
  INTAKE_REQUIRED: 409,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

/** Generic message for unexpected failures; details go to the server log only. */
export const INTERNAL_MESSAGE = 'Internal server error';

/**
 * Identical message for "battery does not exist" and "battery out of scope", so the two
 * cases are indistinguishable (Req 3.8, 12.15).
 */
export const ACCESS_DENIED_MESSAGE = 'Access denied';

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: FieldError[] | undefined;

  constructor(code: ErrorCode, message: string, fields?: FieldError[]) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fields = fields;
  }

  toBody(): ApiErrorBody {
    const error: DomainError = { code: this.code, message: this.message };
    if (this.fields && this.fields.length > 0) error.fields = this.fields.map((f) => ({ ...f }));
    return { error };
  }
}

export function fromDomainError(err: DomainError): HttpError {
  return new HttpError(err.code, err.message, err.fields);
}

/** The single access-denied error used for missing, out-of-scope, and not-permitted reads. */
export function accessDenied(): HttpError {
  return new HttpError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE);
}

export function internalError(): HttpError {
  return new HttpError('INTERNAL', INTERNAL_MESSAGE);
}
