/**
 * Browser API client for the Plugin (task 15.1; Req 13.2, 13.7, 13.8).
 *
 * - Sends the Role_Switcher selection as `X-Role` / `X-Identity` on every role-scoped call.
 * - Every request has a 10-second timeout (AbortController). A caller-supplied signal can also
 *   abort it (used by `useRoleData` to drop superseded requests).
 * - Every failure is an `ApiError` whose message names the failed operation, e.g.
 *   "Saving consent failed: Only the Data_Owner can change Consent".
 * - `fetch` is injectable so tests run without a server.
 *
 * Only TYPES are imported from `src/core`; nothing from `src/server` or Node.
 */
import type { ForecastQuarter } from '../core/forecast';
import type {
  EsgBatteryView,
  FleetBatteryView,
  OwnerBatteryView,
  RecyclerBatteryView,
  RoleView,
  SecondLifeBatteryView,
  ServicePartnerBatteryView,
} from '../core/projection';
import type {
  ApiErrorBody,
  ConsentStatus,
  EndOfLifeRecord,
  ErrorCode,
  FieldError,
  ISODate,
  InspectionFlag,
  OwnerReturnedBatteryView,
  ReturnConfirmation,
  Role,
  Scope3Report,
  ServiceRecord,
} from '../core/types';

export const DEFAULT_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Prefix for every path; defaults to '' (same origin). */
  baseUrl?: string;
  /** Defaults to 10 000 ms (Req 13.8). */
  timeoutMs?: number;
}

/** The two Plugin inputs, sent as headers. */
export interface RoleContext {
  role: Role;
  identityId: string;
}

/** Server error codes plus client-side failure kinds. */
export type ApiErrorCode = ErrorCode | 'TIMEOUT' | 'NETWORK' | 'ABORTED' | 'BAD_RESPONSE' | 'HTTP_ERROR';

export class ApiError extends Error {
  /** Human-readable operation name, e.g. "Loading batteries". */
  readonly operation: string;
  readonly code: ApiErrorCode;
  /** HTTP status, when a response was received. */
  readonly status: number | undefined;
  /** Per-field validation errors from the server (VALIDATION_ERROR). */
  readonly fields: FieldError[];
  /** The server's (or client's) message without the operation prefix. */
  readonly detail: string;

  constructor(operation: string, code: ApiErrorCode, detail: string, opts: { status?: number; fields?: FieldError[] } = {}) {
    super(`${operation} failed: ${detail}`);
    this.name = 'ApiError';
    this.operation = operation;
    this.code = code;
    this.detail = detail;
    this.status = opts.status;
    this.fields = opts.fields ?? [];
  }

  /** Message for one field (inline form errors), if the server named it. */
  fieldMessage(field: string): string | undefined {
    return this.fields.find((f) => f.field === field)?.message;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface StakeholderEntry {
  id: string;
  name: string;
  manufacturer?: string;
}

export interface StakeholdersResponse {
  roles: Role[];
  stakeholders: Record<Role, StakeholderEntry[]>;
}

export interface OwnerListResponse {
  batteries: OwnerBatteryView[];
  returnedBatteries: OwnerReturnedBatteryView[];
}
export interface FleetListResponse {
  batteries: FleetBatteryView[];
  replacementForecast: ForecastQuarter[];
}
export interface ServicePartnerListResponse {
  batteries: ServicePartnerBatteryView[];
}
export interface SecondLifeListResponse {
  batteries: SecondLifeBatteryView[];
}
export interface RecyclerListResponse {
  batteries: RecyclerBatteryView[];
}
export interface EsgListResponse {
  batteries: EsgBatteryView[];
}

/** `GET /api/batteries` response shape per role. */
export interface BatteryListByRole {
  Owner: OwnerListResponse;
  Fleet_Operator: FleetListResponse;
  Service_Partner: ServicePartnerListResponse;
  Second_Life_Provider: SecondLifeListResponse;
  Recycler: RecyclerListResponse;
  ESG_Officer: EsgListResponse;
}

export interface ForecastResponse {
  evalDate: ISODate;
  replacementForecast: ForecastQuarter[];
}

export interface Scope3Query {
  start: string;
  end: string;
  manufacturer?: string;
}

export interface CsvDownload {
  filename: string;
  csv: string;
}

/** Every command returns the updated projected view, or null when it left the viewer's scope. */
export type CommandResponse<P extends object = object> = { battery: RoleView | null } & P;

export interface RepairPayload {
  date: string;
  faultCode: string;
  actionTaken: string;
  modulesReplaced: string[];
}

export interface ApiClient {
  getStakeholders(signal?: AbortSignal): Promise<StakeholdersResponse>;
  listBatteries<R extends Role>(ctx: RoleContext & { role: R }, signal?: AbortSignal): Promise<BatteryListByRole[R]>;
  getBattery(ctx: RoleContext, batteryId: string, signal?: AbortSignal): Promise<{ battery: RoleView }>;
  getFleetForecast(ctx: RoleContext, signal?: AbortSignal): Promise<ForecastResponse>;
  getScope3Report(ctx: RoleContext, query: Scope3Query, signal?: AbortSignal): Promise<{ report: Scope3Report }>;
  downloadScope3Csv(ctx: RoleContext, query: Scope3Query, signal?: AbortSignal): Promise<CsvDownload>;

  setConsent(ctx: RoleContext, batteryId: string, action: 'grant' | 'withdraw'): Promise<CommandResponse<{ consentStatus: ConsentStatus }>>;
  acceptReturnOffer(ctx: RoleContext, batteryId: string): Promise<CommandResponse<{ confirmation: ReturnConfirmation }>>;
  flagInspection(ctx: RoleContext, batteryId: string, servicePartnerId: string): Promise<CommandResponse<{ inspectionFlag: InspectionFlag }>>;
  handOver(ctx: RoleContext, batteryId: string): Promise<CommandResponse<{ servicePartnerId: string }>>;
  logRepair(ctx: RoleContext, batteryId: string, payload: RepairPayload): Promise<CommandResponse<{ serviceRecord: ServiceRecord }>>;
  referToSecondLife(ctx: RoleContext, batteryId: string, secondLifeProviderId: string): Promise<CommandResponse<{ secondLifeProviderId: string }>>;
  dispatchToRecycler(
    ctx: RoleContext,
    batteryId: string,
    payload: { recyclerId: string; expectedArrivalDate: string },
  ): Promise<CommandResponse<{ recyclerId: string; expectedArrivalDate: ISODate }>>;
  acceptSecondLife(ctx: RoleContext, batteryId: string): Promise<CommandResponse<{ endOfLife: EndOfLifeRecord }>>;
  logIntake(ctx: RoleContext, batteryId: string, intakeDate: string): Promise<CommandResponse<{ intakeDate: ISODate; intakeStatus: 'Received' }>>;
  logMaterials(ctx: RoleContext, batteryId: string, materials: Record<string, number>): Promise<CommandResponse<{ endOfLife: EndOfLifeRecord }>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RequestSpec {
  operation: string;
  method: 'GET' | 'POST';
  path: string;
  ctx?: RoleContext;
  body?: unknown;
  signal?: AbortSignal;
  accept?: 'json' | 'text';
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

function scope3QueryString(q: Scope3Query): string {
  const params = new URLSearchParams();
  params.set('start', q.start);
  params.set('end', q.end);
  if (q.manufacturer !== undefined) params.set('manufacturer', q.manufacturer);
  return params.toString();
}

/** Filename from `Content-Disposition: attachment; filename="..."`. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  return match?.[1] ?? fallback;
}

const enc = encodeURIComponent;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? '';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send(spec: RequestSpec): Promise<{ response: Response; text: string }> {
    const { operation } = spec;
    if (spec.signal?.aborted) throw new ApiError(operation, 'ABORTED', 'Request was cancelled');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    spec.signal?.addEventListener('abort', onExternalAbort);

    const headers: Record<string, string> = {
      Accept: spec.accept === 'text' ? 'text/csv, text/plain, */*' : 'application/json',
    };
    if (spec.ctx) {
      headers['X-Role'] = spec.ctx.role;
      headers['X-Identity'] = spec.ctx.identityId;
    }
    const init: RequestInit = { method: spec.method, headers, signal: controller.signal };
    if (spec.method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(spec.body ?? {});
    }

    // Races the fetch (and body read) against the abort signal so a fetch implementation that
    // ignores `signal` still times out.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    aborted.catch(() => undefined); // never an unhandled rejection

    try {
      const response = await Promise.race([doFetch(baseUrl + spec.path, init), aborted]);
      const text = await Promise.race([response.text(), aborted]);
      return { response, text };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (timedOut) {
        throw new ApiError(operation, 'TIMEOUT', `The server did not respond within ${Math.round(timeoutMs / 1000)} seconds`);
      }
      if (controller.signal.aborted) throw new ApiError(operation, 'ABORTED', 'Request was cancelled');
      throw new ApiError(operation, 'NETWORK', 'Could not reach the server');
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  function toHttpError(operation: string, response: Response, text: string): ApiError {
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (isErrorBody(parsed)) {
      const fields = parsed.error.fields;
      return new ApiError(operation, parsed.error.code, parsed.error.message, {
        status: response.status,
        ...(fields ? { fields } : {}),
      });
    }
    return new ApiError(operation, 'HTTP_ERROR', `Unexpected server response (HTTP ${response.status})`, {
      status: response.status,
    });
  }

  async function json<T>(spec: RequestSpec): Promise<T> {
    const { response, text } = await send(spec);
    if (!response.ok) throw toHttpError(spec.operation, response, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(spec.operation, 'BAD_RESPONSE', 'The server returned an invalid response', {
        status: response.status,
      });
    }
  }

  const post = <P extends object>(operation: string, ctx: RoleContext, batteryId: string, action: string, body?: unknown) =>
    json<CommandResponse<P>>({ operation, method: 'POST', path: `/api/batteries/${enc(batteryId)}/${action}`, ctx, body });

  return {
    getStakeholders: (signal) =>
      json({ operation: 'Loading stakeholders', method: 'GET', path: '/api/stakeholders', ...(signal ? { signal } : {}) }),

    listBatteries: (ctx, signal) =>
      json({ operation: 'Loading batteries', method: 'GET', path: '/api/batteries', ctx, ...(signal ? { signal } : {}) }),

    getBattery: (ctx, batteryId, signal) =>
      json({ operation: 'Loading battery', method: 'GET', path: `/api/batteries/${enc(batteryId)}`, ctx, ...(signal ? { signal } : {}) }),

    getFleetForecast: (ctx, signal) =>
      json({ operation: 'Loading replacement forecast', method: 'GET', path: '/api/fleet/forecast', ctx, ...(signal ? { signal } : {}) }),

    getScope3Report: (ctx, query, signal) =>
      json({
        operation: 'Generating Scope 3 report',
        method: 'GET',
        path: `/api/scope3?${scope3QueryString(query)}`,
        ctx,
        ...(signal ? { signal } : {}),
      }),

    async downloadScope3Csv(ctx, query, signal) {
      const operation = 'Exporting Scope 3 CSV';
      const { response, text } = await send({
        operation,
        method: 'GET',
        path: `/api/scope3.csv?${scope3QueryString(query)}`,
        ctx,
        accept: 'text',
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw toHttpError(operation, response, text);
      const fallback = `scope3-${query.start}-${query.end}.csv`;
      return { filename: filenameFromDisposition(response.headers.get('Content-Disposition'), fallback), csv: text };
    },

    setConsent: (ctx, id, action) => post('Saving consent', ctx, id, 'consent', { action }),
    acceptReturnOffer: (ctx, id) => post('Accepting return offer', ctx, id, 'return-offer/accept'),
    flagInspection: (ctx, id, servicePartnerId) => post('Flagging for inspection', ctx, id, 'inspection-flag', { servicePartnerId }),
    handOver: (ctx, id) => post('Hand over', ctx, id, 'handover'),
    logRepair: (ctx, id, payload) => post('Logging repair', ctx, id, 'repairs', payload),
    referToSecondLife: (ctx, id, secondLifeProviderId) => post('Referring to second life', ctx, id, 'referral', { secondLifeProviderId }),
    dispatchToRecycler: (ctx, id, payload) => post('Dispatching to recycler', ctx, id, 'dispatch', payload),
    acceptSecondLife: (ctx, id) => post('Accepting battery', ctx, id, 'second-life/accept'),
    logIntake: (ctx, id, intakeDate) => post('Logging intake', ctx, id, 'intake', { intakeDate }),
    logMaterials: (ctx, id, materials) => post('Logging materials', ctx, id, 'materials', { materials }),
  };
}
