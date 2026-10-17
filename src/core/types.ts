/**
 * Core domain types for Battery ReRoute.
 *
 * This module is pure: it imports nothing from Node, Express, or React.
 * The Zod schemas in `schemas.ts` mirror these types and enforce the ranges in Req 1.
 */

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/** Calendar date, ISO `YYYY-MM-DD`. */
export type ISODate = string;
/** Full ISO timestamp (used for Telemetry readings and Consent events). */
export type ISODateTime = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type Role =
  | 'Owner'
  | 'Fleet_Operator'
  | 'Service_Partner'
  | 'Second_Life_Provider'
  | 'Recycler'
  | 'ESG_Officer';

/** Roles that can hold custody of a battery (Req 1.7). */
export type HolderRole = Exclude<Role, 'ESG_Officer'>;

export type Pathway = 'Continue_Use' | 'Inspect_Repair' | 'Second_Life_Review' | 'Certified_Recycling';

/** Pathways valid on an End_Of_Life_Record and as a Routed_Pathway (Req 1.8). */
export type EolPathway = 'Second_Life_Review' | 'Certified_Recycling';

export type ModuleCondition = 'Good' | 'Degraded' | 'Failed';

export type ConsentStatus = 'granted' | 'not_granted';

export type IntakeStatus = 'Awaiting_Intake' | 'Received';

export type ChargeType = 'DC_Fast' | 'AC';

export type Disposition = 'In_Use' | 'Second_Life' | 'Recycled' | 'Unknown';

export type MeasurementStatus = 'Measured' | 'Estimated';

// ---------------------------------------------------------------------------
// Stakeholders
// ---------------------------------------------------------------------------

/** City and state/region only; never a street address. */
export interface Location {
  city: string;
  state: string;
}

export interface Stakeholder {
  /** e.g. 'OWN-001', 'FLT-001', 'SP-001'. */
  id: string;
  role: Role;
  name: string;
  location: Location;
  /** ESG_Officer only: the manufacturer the officer reports for. */
  manufacturer?: string;
}

// ---------------------------------------------------------------------------
// Digital_Twin components
// ---------------------------------------------------------------------------

export interface BatteryPassport {
  /** 1..64 chars. */
  batteryId: string;
  /** 1..64 chars ('' allowed only in seeded missing-record twins). */
  chemistry: string;
  /** (0, 500]. */
  capacityKwh: number;
  /** > 0. */
  packMassKg: number;
  /** Not later than the write date. */
  manufactureDate: ISODate;
  /** 1..128 chars. */
  manufacturer: string;
  /** >= 0. */
  embeddedCarbonKgCo2e: number;
  /** [0, 100]. */
  recycledContentPct: number;
}

export interface Module {
  moduleId: string;
  condition: ModuleCondition;
}

export interface TelemetryReading {
  timestamp: ISODateTime;
  /** [0, 100]. */
  sohPct: number;
  /** Integer >= 0. */
  cycleCount: number;
  /** Integer >= 0. */
  thermalEventCount: number;
}

export interface ChargingSession {
  date: ISODate;
  /** >= 0. */
  energyKwh: number;
  chargeType: ChargeType;
  /** [-50, 60]. */
  ambientTempC: number;
}

export interface ServiceRecord {
  date: ISODate;
  /** '' or 1..32 chars. */
  faultCode: string;
  /** 0..500 chars when seeded; 1..500 when logged through the Platform. */
  actionTaken: string;
  modulesReplaced: string[];
}

export interface CustodyEntry {
  date: ISODate;
  /** null for the first (manufacturer-to-first-holder) entry. */
  fromHolderId: string | null;
  toHolderId: string;
  toHolderRole: HolderRole;
  /** Dispatch-to-Recycler entries only. */
  expectedArrivalDate?: ISODate;
}

export interface ConsentEvent {
  type: 'grant' | 'withdraw';
  at: ISODateTime;
  byId: string;
}

export interface InspectionFlag {
  flagDate: ISODate;
  fleetOperatorId: string;
  servicePartnerId: string;
}

export interface ReturnOffer {
  /** '<batteryId>:<ownerId>:return'. */
  offerId: string;
  servicePartnerId: string;
  servicePartnerName: string;
}

export type NudgeType = 'Charging_Guidance' | 'Service_Prompt' | 'Return_Incentive';

/** Active owner-facing nudge; at most one per type per battery (Req 7.10). */
export type Nudge =
  | { type: 'Charging_Guidance'; createdOn: ISODate; message: string }
  /** `createdOn` is retained unchanged while the nudge stays active (Req 7.16). */
  | { type: 'Service_Prompt'; createdOn: ISODate; message: string }
  | { type: 'Return_Incentive'; createdOn: ISODate; message: string; returnOffer: ReturnOffer };

export interface ImpactComponents {
  charging: boolean;
  servicing: boolean;
  consent: boolean;
  return: boolean;
}

export type FinalImpactScore = 25 | 50 | 75 | 100;
export type ImpactScore = 0 | FinalImpactScore;

/** Returned_Battery entry. Written once at Return_Offer acceptance and never modified (Req 7.19–7.21). */
export interface ReturnRecord {
  readonly batteryId: string;
  readonly ownerId: string;
  readonly offerId: string;
  /** Acceptance date. */
  readonly returnDate: ISODate;
  readonly servicePartnerId: string;
  readonly servicePartnerName: string;
  readonly finalImpactScore: FinalImpactScore;
  /** `return` is always true. */
  readonly components: Readonly<ImpactComponents>;
}

/** Kept separate from the Custody_Log so custody entries stay immutable (Req 11.3). */
export interface RecyclerIntake {
  /** Index into `custodyLog` of the dispatch handover this intake applies to. */
  handoverIndex: number;
  intakeDate: ISODate;
}

export interface EndOfLifeRecord {
  pathway: EolPathway;
  date: ISODate;
  receivingPartyId: string;
  /** kg by material; each >= 0. */
  materialsRecoveredKg: Record<string, number>;
}

export interface DataOwner {
  id: string;
  role: 'Owner' | 'Fleet_Operator';
}

export interface DigitalTwin {
  passport: BatteryPassport;
  /** Length >= 1. */
  modules: Module[];
  telemetry: TelemetryReading[];
  chargingHistory: ChargingSession[];
  serviceHistory: ServiceRecord[];
  /** Length >= 1, append-only, dates non-decreasing. */
  custodyLog: CustodyEntry[];
  endOfLife: EndOfLifeRecord | null;
  /** Part of Owner_Data. */
  dataOwner: DataOwner;
  /** Chronological, append-only. */
  consentEvents: ConsentEvent[];
  routedPathway: EolPathway | null;
  /** Append-only; the last element is the most recent flag. */
  inspectionFlags: InspectionFlag[];
  /** Active set, at most one per type. */
  nudges: Nudge[];
  /** Append-only, at most one per ownerId. */
  returnRecords: ReturnRecord[];
  recyclerIntake: RecyclerIntake | null;
}

export interface Store {
  version: 2;
  seed: number;
  runDate: ISODate;
  stakeholders: Stakeholder[];
  /** Keyed by batteryId, so there is exactly one twin per ID. */
  twins: Record<string, DigitalTwin>;
}

// ---------------------------------------------------------------------------
// Report and view models
// ---------------------------------------------------------------------------

/** ESG custody projection: id/name only for non-Owner roles; no from-holder (Req 3.15, 3.16). */
export interface EsgCustodyEntry {
  date: ISODate;
  toRole: HolderRole;
  toHolderId?: string;
  toHolderName?: string;
}

export interface Scope3Row {
  batteryId: string;
  disposition: Disposition;
  measurementStatus: MeasurementStatus;
  dataConfidence: number;
  consentStatus: ConsentStatus;
  /** '' when no End_Of_Life_Record is dated on or before the period end. */
  eolDate: ISODate | '';
  /** JSON only; never written to CSV. */
  custodyLog: EsgCustodyEntry[];
}

export interface Scope3Report {
  manufacturer: string;
  periodStart: ISODate;
  periodEnd: ISODate;
  rows: Scope3Row[];
  /** All four keys always present. */
  counts: Record<Disposition, number>;
  /** Equals counts.In_Use; labeled "not yet at end of life". */
  notYetEolCount: number;
  /** One decimal place, e.g. '33.3'. */
  measuredShare: string;
}

export type Scope3CsvRow = Omit<Scope3Row, 'custodyLog'>;
export type Scope3CsvReport = Omit<Scope3Report, 'rows'> & { rows: Scope3CsvRow[] };

export interface OwnerReturnedBatteryView {
  batteryId: string;
  returnDate: ISODate;
  servicePartnerName: string;
  finalImpactScore: FinalImpactScore;
  components: ImpactComponents;
}

export const RETURN_CONFIRMATION_MESSAGE = 'Return accepted, +25 Impact points' as const;

export interface ReturnConfirmation {
  message: typeof RETURN_CONFIRMATION_MESSAGE;
  servicePartnerName: string;
  acceptanceDate: ISODate;
  finalImpactScore: FinalImpactScore;
  components: ImpactComponents;
}

// ---------------------------------------------------------------------------
// Access, actions, results, errors
// ---------------------------------------------------------------------------

export interface ViewerContext {
  role: Role;
  identityId: string;
  /** ESG_Officer only. */
  manufacturer?: string;
}

/** Write actions governed by the role/action permission matrix in `access.ts`. */
export type Action =
  | 'consent'
  | 'acceptReturnOffer'
  | 'flagInspection'
  | 'handover'
  | 'repair'
  | 'referral'
  | 'dispatch'
  | 'acceptSecondLife'
  | 'intake'
  | 'materials';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Error codes from the design Error Handling table. */
export type ErrorCode =
  | 'INVALID_ROLE_CONTEXT'
  | 'ACCESS_DENIED'
  | 'ACTION_NOT_PERMITTED'
  | 'VALIDATION_ERROR'
  | 'DUPLICATE_BATTERY_ID'
  | 'CUSTODY_APPEND_ONLY'
  | 'EOL_EXISTS'
  | 'NOT_DATA_OWNER'
  | 'OFFER_NOT_ACCEPTABLE'
  | 'NOT_CURRENT_HOLDER'
  | 'NO_INSPECTION_FLAG'
  | 'SAFETY_FLAGGED'
  | 'NOT_AVAILABLE'
  | 'INTAKE_REQUIRED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export interface FieldError {
  field: string;
  message: string;
}

export interface DomainError {
  code: ErrorCode;
  message: string;
  fields?: FieldError[];
}

/** JSON error body shared by every API error response. */
export interface ApiErrorBody {
  error: DomainError;
}
