/**
 * Access rules: battery scope per role, the role/action permission matrix,
 * consent visibility of Owner_Data, and the ESG custody projection.
 * Pure: no clock, no I/O. Requirements 3, 4.4–4.9, 4.14, 8.7.
 */

import { currentHolder, consentStatus, isReturnedFor, latestInspectionFlag } from './telemetry';
import type {
  Action,
  CustodyEntry,
  DigitalTwin,
  EsgCustodyEntry,
  HolderRole,
  Role,
  Stakeholder,
  ViewerContext,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the viewer's role and identity equal the twin's Current_Holder. */
export function isCurrentHolder(twin: Pick<DigitalTwin, 'custodyLog'>, viewer: ViewerContext): boolean {
  const holder = currentHolder(twin.custodyLog);
  return holder !== undefined && holder.toHolderRole === viewer.role && holder.toHolderId === viewer.identityId;
}

/** True when the viewer is the twin's Data_Owner (Owner, or Fleet_Operator for fleet batteries; Req 4.4). */
export function isDataOwner(twin: Pick<DigitalTwin, 'dataOwner'>, viewer: ViewerContext): boolean {
  return twin.dataOwner.role === viewer.role && twin.dataOwner.id === viewer.identityId;
}

// ---------------------------------------------------------------------------
// Scope (Req 3.2–3.7, 8.7)
// ---------------------------------------------------------------------------

/**
 * Whether a battery is in the viewer's live scope. For Owners this is the held
 * list only; Returned_Batteries are covered by `ownerReturnedScope`.
 */
export function inScope(twin: DigitalTwin, viewer: ViewerContext): boolean {
  switch (viewer.role) {
    case 'Owner':
    case 'Fleet_Operator':
      return isCurrentHolder(twin, viewer);
    case 'Service_Partner':
      return (
        isCurrentHolder(twin, viewer) ||
        twin.returnRecords.some((r) => r.servicePartnerId === viewer.identityId) ||
        latestInspectionFlag(twin)?.servicePartnerId === viewer.identityId
      );
    case 'Second_Life_Provider':
      return twin.routedPathway === 'Second_Life_Review' && isCurrentHolder(twin, viewer);
    case 'Recycler':
      // Latest Custody_Log entry is a handover to this Recycler.
      return twin.routedPathway === 'Certified_Recycling' && isCurrentHolder(twin, viewer);
    case 'ESG_Officer':
      return viewer.manufacturer !== undefined && twin.passport.manufacturer === viewer.manufacturer;
    default:
      return false;
  }
}

/** An Owner's Returned_Batteries: a ReturnRecord for the Owner exists and the Owner no longer holds custody. */
export function ownerReturnedScope(twins: readonly DigitalTwin[], ownerId: string): DigitalTwin[] {
  return twins.filter((t) => isReturnedFor(t, ownerId));
}

// ---------------------------------------------------------------------------
// Role/action permission matrix (Req 3.9, 3.13, 3.14, 3.18, 4.14)
// ---------------------------------------------------------------------------

/** Static matrix: the actions each role may ever attempt. */
export const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  Owner: ['consent', 'acceptReturnOffer'],
  Fleet_Operator: ['consent', 'flagInspection', 'handover'],
  Service_Partner: ['repair', 'referral', 'dispatch'],
  Second_Life_Provider: ['acceptSecondLife', 'dispatch'],
  Recycler: ['intake', 'materials'],
  ESG_Officer: [],
};

/** Static check against `ROLE_ACTIONS`, independent of battery state. */
export function roleCanPerform(role: Role, action: Action): boolean {
  return ROLE_ACTIONS[role]?.includes(action) ?? false;
}

/**
 * Actions the viewer may attempt on this twin in its current state. Commands still
 * run their own domain checks (Data_Owner, active offer, intake status, dates, ...)
 * and return the specific error codes for those.
 */
export function allowedActions(twin: DigitalTwin, viewer: ViewerContext): Set<Action> {
  const allowed = new Set<Action>();
  const holder = isCurrentHolder(twin, viewer);

  switch (viewer.role) {
    case 'Owner':
      // Returned_Battery guard: no Owner action at all (Req 3.18, 4.14).
      if (isReturnedFor(twin, viewer.identityId)) return allowed;
      if (holder) {
        allowed.add('consent');
        allowed.add('acceptReturnOffer');
      }
      break;
    case 'Fleet_Operator':
      if (holder) {
        allowed.add('consent');
        allowed.add('flagInspection');
        if (twin.inspectionFlags.length > 0) allowed.add('handover');
      }
      break;
    case 'Service_Partner':
      // Inspection-only or past-return SPs get none (Req 3.13); holder SPs get all three (Req 3.14).
      if (holder) {
        allowed.add('repair');
        allowed.add('referral');
        allowed.add('dispatch');
      }
      break;
    case 'Second_Life_Provider':
      if (inScope(twin, viewer)) {
        allowed.add('acceptSecondLife');
        allowed.add('dispatch');
      }
      break;
    case 'Recycler':
      if (inScope(twin, viewer)) {
        allowed.add('intake');
        allowed.add('materials');
      }
      break;
    case 'ESG_Officer':
      break;
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Consent visibility of Owner_Data (Req 4.4–4.8)
// ---------------------------------------------------------------------------

const CUSTODIAL_ROLES: readonly HolderRole[] = ['Service_Partner', 'Second_Life_Provider', 'Recycler'];

/**
 * Whether Owner_Data may be returned to this viewer:
 * 1. the viewer is the Data_Owner;
 * 2. the viewer is the Current_Holder with role SP/SLP/Recycler (regardless of Consent);
 * 3. the Data_Owner is the Current_Holder and Consent is granted;
 * otherwise false.
 */
export function ownerDataVisible(twin: DigitalTwin, viewer: ViewerContext): boolean {
  if (isDataOwner(twin, viewer)) return true;
  const holder = currentHolder(twin.custodyLog);
  if (!holder) return false;
  if (isCurrentHolder(twin, viewer) && CUSTODIAL_ROLES.includes(holder.toHolderRole)) return true;
  const dataOwnerHolds = holder.toHolderId === twin.dataOwner.id && holder.toHolderRole === twin.dataOwner.role;
  return dataOwnerHolds && consentStatus(twin) === 'granted';
}

// ---------------------------------------------------------------------------
// ESG custody projection (Req 3.15, 3.16)
// ---------------------------------------------------------------------------

const ESG_IDENTIFIED_ROLES: readonly HolderRole[] = [
  'Fleet_Operator',
  'Service_Partner',
  'Second_Life_Provider',
  'Recycler',
];

/**
 * Projects custody entries for the ESG_Officer: `{ date, toRole }`, plus
 * `toHolderId`/`toHolderName` only for non-Owner holders. No from-holder field.
 * The name falls back to the id when the stakeholder is unknown.
 */
export function esgCustodyEntries(
  custodyLog: readonly CustodyEntry[],
  stakeholders: readonly Stakeholder[],
): EsgCustodyEntry[] {
  return custodyLog.map((e) => {
    const entry: EsgCustodyEntry = { date: e.date, toRole: e.toHolderRole };
    if (ESG_IDENTIFIED_ROLES.includes(e.toHolderRole)) {
      entry.toHolderId = e.toHolderId;
      entry.toHolderName = stakeholders.find((s) => s.id === e.toHolderId)?.name ?? e.toHolderId;
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Permitted response fields per role (Req 3.2–3.7), for projection and tests
// ---------------------------------------------------------------------------

export const PERMITTED_FIELDS = {
  Owner: [
    'batteryId',
    'healthScore',
    'factors',
    'impactScore',
    'impactComponents',
    'nudges',
    'remainingLife',
    'pathway',
    'dataConfidence',
    'returnOffer',
    'consentStatus',
  ],
  OwnerReturned: ['batteryId', 'returnDate', 'servicePartnerName', 'finalImpactScore', 'components'],
  Fleet_Operator: [
    'batteryId',
    'healthScore',
    'soh',
    'sohSeries',
    'remainingLife',
    'safetyFlag',
    'recentFault',
    'inspectionFlag',
    'consentStatus',
  ],
  Service_Partner: [
    'batteryId',
    'serviceHistory',
    'faultCodes',
    'modules',
    'pathway',
    'dataConfidence',
    'consentStatus',
    'assignment',
    'actionsEnabled',
    'actionsDisabledReason',
  ],
  Second_Life_Provider: [
    'batteryId',
    'capacityKwh',
    'soh',
    'usableCapacity',
    'safetyHistory',
    'applicationFit',
    'acceptance',
    'pathway',
    'dataConfidence',
    'consentStatus',
  ],
  Recycler: ['batteryId', 'chemistry', 'packMassKg', 'location', 'expectedArrival', 'intakeStatus'],
  ESG_Officer: ['batteryId', 'disposition', 'custodyLog', 'measurementStatus', 'dataConfidence', 'consentStatus'],
} as const satisfies Record<Role | 'OwnerReturned', readonly string[]>;
