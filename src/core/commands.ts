/**
 * Command functions: the write path of the Digital_Twin.
 *
 * Every command is pure: it takes the twin, the acting viewer, the input, and the
 * date(s) explicitly, never reads the clock, never mutates its inputs, and returns
 * `Result<{ twin, ...payload }, DomainError>`. On success the new twin has passed
 * `assertAppendOnlyChanges` against the input twin, so the caller can persist it in
 * one atomic write. On failure nothing should be written.
 *
 * Gating convention:
 *  1. `roleCanPerform(role, action)` → ACTION_NOT_PERMITTED (static role/action matrix, Req 3.9).
 *  2. Owner commands: `isReturnedFor` → ACTION_NOT_PERMITTED, before any other domain check (Req 3.18, 4.14).
 *  3. Command-specific domain checks with their own error codes
 *     (NOT_DATA_OWNER, OFFER_NOT_ACCEPTABLE, NOT_CURRENT_HOLDER, NO_INSPECTION_FLAG, ...).
 *
 * Sections:
 *  - Shared helpers
 *  - Custody, consent, return offer, inspection, fleet handover (task 10.1)
 *  - Repair, routing, second-life, recycler commands (task 10.2, appended below)
 */

import { roleCanPerform, inScope, isCurrentHolder, isDataOwner } from './access';
import { addDays } from './dates';
import { finalImpact } from './impact';
import { reconcileNudges } from './nudges';
import { intakeStatusOf, latestDispatchIndex } from './projection';
import {
  assertAppendOnlyChanges,
  consentEventSchema,
  custodyEntrySchema,
  endOfLifeRecordSchema,
  formatZodErrors,
  inspectionFlagSchema,
  isValidIsoDate,
  returnRecordSchema,
  serviceRecordSchema,
  validate,
} from './schemas';
import { isReturnedFor, latestInspectionFlag, returnRecordFor, safetyFlag } from './telemetry';
import { RETURN_CONFIRMATION_MESSAGE } from './types';
import type {
  Action,
  ConsentEvent,
  CustodyEntry,
  DigitalTwin,
  DomainError,
  EndOfLifeRecord,
  ErrorCode,
  FieldError,
  ISODate,
  ISODateTime,
  InspectionFlag,
  Nudge,
  RecyclerIntake,
  Result,
  ReturnConfirmation,
  ReturnRecord,
  ServiceRecord,
  Stakeholder,
  ViewerContext,
} from './types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Successful command output: the new twin plus any command-specific payload. */
export type CommandOutput<P extends object = object> = { twin: DigitalTwin } & P;
export type CommandResult<P extends object = object> = Result<CommandOutput<P>, DomainError>;

export function domainError(code: ErrorCode, message: string, fields?: FieldError[]): { ok: false; error: DomainError } {
  return { ok: false, error: fields ? { code, message, fields } : { code, message } };
}

function actionNotPermitted(): { ok: false; error: DomainError } {
  return domainError('ACTION_NOT_PERMITTED', 'This action is not permitted for the active role');
}

/** Static role/action gate (Req 3.9). Returns an error result, or undefined when allowed. */
function gateRole(viewer: ViewerContext, action: Action): { ok: false; error: DomainError } | undefined {
  return roleCanPerform(viewer.role, action) ? undefined : actionNotPermitted();
}

/** Owner Returned_Battery guard (Req 3.18, 4.14); runs before any other Owner domain check. */
function gateReturnedOwner(twin: DigitalTwin, viewer: ViewerContext): { ok: false; error: DomainError } | undefined {
  return viewer.role === 'Owner' && isReturnedFor(twin, viewer.identityId) ? actionNotPermitted() : undefined;
}

/** Final step of every command: only appends to append-only lists (Req 1.13, 4.13, 7.21). */
function finish<P extends object>(oldTwin: DigitalTwin, newTwin: DigitalTwin, payload: P): CommandResult<P> {
  const guard = assertAppendOnlyChanges(oldTwin, newTwin);
  if (!guard.ok) return guard;
  return { ok: true, value: { twin: newTwin, ...payload } };
}

// ---------------------------------------------------------------------------
// Custody (Req 1.11, 1.13)
// ---------------------------------------------------------------------------

/**
 * Appends one handover to the Custody_Log. The entry must be well-formed and dated
 * no earlier than the last entry; otherwise CUSTODY_APPEND_ONLY (backdated) or
 * VALIDATION_ERROR (malformed). The new entry becomes the Current_Holder.
 * Not role-gated: it is the shared primitive used by the role-specific commands.
 */
export function appendCustody(twin: DigitalTwin, entry: CustodyEntry): CommandResult {
  const parsed = validate(custodyEntrySchema, entry);
  if (!parsed.ok) return parsed;
  const last = twin.custodyLog[twin.custodyLog.length - 1];
  if (last && entry.date < last.date) {
    return domainError('CUSTODY_APPEND_ONLY', 'The Custody_Log is append-only; a handover cannot be dated before the last entry', [
      { field: 'date', message: `Must not be earlier than ${last.date}` },
    ]);
  }
  const next: DigitalTwin = { ...twin, custodyLog: [...twin.custodyLog, { ...entry }] };
  return finish(twin, next, {});
}

// ---------------------------------------------------------------------------
// Consent (Req 4.1–4.4, 4.12–4.14)
// ---------------------------------------------------------------------------

export type ConsentAction = 'grant' | 'withdraw';

/**
 * Records a Consent grant or withdrawal by the Data_Owner (the Owner, or the
 * Fleet_Operator for fleet batteries). Appends a ConsentEvent with `at` and the
 * Data_Owner identity. Payload carries the resulting `consentStatus`.
 */
export function recordConsent(
  twin: DigitalTwin,
  viewer: ViewerContext,
  type: ConsentAction,
  at: ISODateTime,
): CommandResult<{ consentStatus: 'granted' | 'not_granted' }> {
  const roleErr = gateRole(viewer, 'consent');
  if (roleErr) return roleErr;
  const returnedErr = gateReturnedOwner(twin, viewer);
  if (returnedErr) return returnedErr;
  if (!isDataOwner(twin, viewer)) {
    return domainError('NOT_DATA_OWNER', 'The requester is not permitted to change Consent for this battery');
  }
  const event: ConsentEvent = { type, at, byId: viewer.identityId };
  const parsed = validate(consentEventSchema, event);
  if (!parsed.ok) return parsed;
  const next: DigitalTwin = { ...twin, consentEvents: [...twin.consentEvents, event] };
  return finish(twin, next, { consentStatus: type === 'grant' ? 'granted' : 'not_granted' });
}

// ---------------------------------------------------------------------------
// Return_Offer acceptance (Req 7.6, 7.7, 7.11, 7.18–7.21)
// ---------------------------------------------------------------------------

function offerNotAcceptable(message: string): { ok: false; error: DomainError } {
  return domainError('OFFER_NOT_ACCEPTABLE', message);
}

/**
 * Owner accepts the active Return_Offer on `today`, in one pure step:
 * reconcile nudges for `today`, compute the Final_Impact_Score on that pre-handover
 * twin, append the Owner → designated Service_Partner handover, remove the
 * Return_Incentive nudge, and append the immutable ReturnRecord.
 *
 * `stakeholders` must contain the Owner and the Service_Partners (other roles are ignored).
 */
export function acceptReturnOffer(
  twin: DigitalTwin,
  viewer: ViewerContext,
  stakeholders: readonly Stakeholder[],
  today: ISODate,
): CommandResult<{ confirmation: ReturnConfirmation; returnRecord: ReturnRecord }> {
  const roleErr = gateRole(viewer, 'acceptReturnOffer');
  if (roleErr) return roleErr;
  const returnedErr = gateReturnedOwner(twin, viewer);
  if (returnedErr) return returnedErr;

  const ownerId = viewer.identityId;
  if (!isCurrentHolder(twin, viewer)) return offerNotAcceptable('The requester is not the Current_Holder of this battery');
  if (returnRecordFor(twin, ownerId)) return offerNotAcceptable('The Return_Offer has already been accepted');

  const owner = stakeholders.find((s) => s.id === ownerId && s.role === 'Owner');
  if (!owner) return offerNotAcceptable('The requesting Owner is unknown');
  const servicePartners = stakeholders.filter((s) => s.role === 'Service_Partner');

  // Nudges as they stand on the acceptance date, immediately before the handover.
  const pre: Nudge[] = reconcileNudges(twin, today, owner, servicePartners);
  const incentive = pre.find((n): n is Extract<Nudge, { type: 'Return_Incentive' }> => n.type === 'Return_Incentive');
  if (!incentive) return offerNotAcceptable('There is no active Return_Offer for this battery');
  const offer = incentive.returnOffer;

  const { finalImpactScore, components } = finalImpact({ ...twin, nudges: pre }, today, ownerId);

  const custody = appendCustody(twin, {
    date: today,
    fromHolderId: ownerId,
    toHolderId: offer.servicePartnerId,
    toHolderRole: 'Service_Partner',
  });
  if (!custody.ok) return custody;

  const returnRecord: ReturnRecord = {
    batteryId: twin.passport.batteryId,
    ownerId,
    offerId: offer.offerId,
    returnDate: today,
    servicePartnerId: offer.servicePartnerId,
    servicePartnerName: offer.servicePartnerName,
    finalImpactScore,
    components: { ...components },
  };
  const parsedRecord = validate(returnRecordSchema, returnRecord);
  if (!parsedRecord.ok) return parsedRecord;

  const next: DigitalTwin = {
    ...twin,
    custodyLog: custody.value.twin.custodyLog,
    nudges: pre.filter((n) => n.type !== 'Return_Incentive'),
    returnRecords: [...twin.returnRecords, returnRecord],
  };
  const confirmation: ReturnConfirmation = {
    message: RETURN_CONFIRMATION_MESSAGE,
    servicePartnerName: offer.servicePartnerName,
    acceptanceDate: today,
    finalImpactScore,
    components: { ...components },
  };
  return finish(twin, next, { confirmation, returnRecord });
}

// ---------------------------------------------------------------------------
// Inspection_Flag (Req 8.6, 8.7, 8.10)
// ---------------------------------------------------------------------------

/**
 * Fleet_Operator flags a battery it holds for inspection by one Service_Partner.
 * NOT_CURRENT_HOLDER when the Fleet_Operator does not hold the battery;
 * VALIDATION_ERROR (field `servicePartnerId`) when no valid Service_Partner is selected.
 */
export function flagInspection(
  twin: DigitalTwin,
  viewer: ViewerContext,
  input: { servicePartnerId?: string | null },
  stakeholders: readonly Stakeholder[],
  today: ISODate,
): CommandResult<{ inspectionFlag: InspectionFlag }> {
  const roleErr = gateRole(viewer, 'flagInspection');
  if (roleErr) return roleErr;
  if (!isCurrentHolder(twin, viewer)) {
    return domainError('NOT_CURRENT_HOLDER', 'Only the Fleet_Operator holding this battery can flag it for inspection');
  }
  const spId = input.servicePartnerId;
  if (typeof spId !== 'string' || spId === '') {
    return domainError('VALIDATION_ERROR', 'A Service_Partner must be selected', [
      { field: 'servicePartnerId', message: 'Required' },
    ]);
  }
  if (!stakeholders.some((s) => s.id === spId && s.role === 'Service_Partner')) {
    return domainError('VALIDATION_ERROR', 'The selected Service_Partner does not exist', [
      { field: 'servicePartnerId', message: 'Must identify a Service_Partner' },
    ]);
  }
  const inspectionFlag: InspectionFlag = { flagDate: today, fleetOperatorId: viewer.identityId, servicePartnerId: spId };
  const parsed = validate(inspectionFlagSchema, inspectionFlag);
  if (!parsed.ok) return parsed;
  const next: DigitalTwin = { ...twin, inspectionFlags: [...twin.inspectionFlags, inspectionFlag] };
  return finish(twin, next, { inspectionFlag });
}

// ---------------------------------------------------------------------------
// Fleet handover to the flagged Service_Partner (Req 3.14, 8.12, 8.13)
// ---------------------------------------------------------------------------

/**
 * Fleet_Operator hands custody to the Service_Partner of the most recent
 * Inspection_Flag. NOT_CURRENT_HOLDER when the actor does not hold the battery;
 * NO_INSPECTION_FLAG when the battery has never been flagged.
 */
export function handOverToServicePartner(
  twin: DigitalTwin,
  viewer: ViewerContext,
  today: ISODate,
): CommandResult<{ servicePartnerId: string }> {
  const roleErr = gateRole(viewer, 'handover');
  if (roleErr) return roleErr;
  if (!isCurrentHolder(twin, viewer)) {
    return domainError('NOT_CURRENT_HOLDER', 'Only the Fleet_Operator holding this battery can hand it over');
  }
  const flag = latestInspectionFlag(twin);
  if (!flag) return domainError('NO_INSPECTION_FLAG', 'The battery has no Inspection_Flag');
  const custody = appendCustody(twin, {
    date: today,
    fromHolderId: viewer.identityId,
    toHolderId: flag.servicePartnerId,
    toHolderRole: 'Service_Partner',
  });
  if (!custody.ok) return custody;
  return finish(twin, custody.value.twin, { servicePartnerId: flag.servicePartnerId });
}

// ===========================================================================
// Repair, routing, second-life, and recycler commands (task 10.2)
// ===========================================================================

/** Maximum days between a dispatch and its expected arrival (Req 9.5, 10.4). */
export const MAX_ARRIVAL_DAYS = 90;

function validationError(message: string, fields: FieldError[]): { ok: false; error: DomainError } {
  return domainError('VALIDATION_ERROR', message, fields);
}

/** Repair, referral, and dispatch by a Service_Partner require custody (Req 3.13, 3.14). */
function gateServicePartnerHolder(twin: DigitalTwin, viewer: ViewerContext): { ok: false; error: DomainError } | undefined {
  if (viewer.role === 'Service_Partner' && !isCurrentHolder(twin, viewer)) {
    return domainError(
      'ACTION_NOT_PERMITTED',
      'The Service_Partner must hold custody of this battery; custody handover is pending',
    );
  }
  return undefined;
}

/** Stakeholder lookup restricted to one role. */
function findStakeholder(
  stakeholders: readonly Stakeholder[],
  id: unknown,
  role: Stakeholder['role'],
): Stakeholder | undefined {
  return typeof id === 'string' && id !== '' ? stakeholders.find((s) => s.id === id && s.role === role) : undefined;
}

// ---------------------------------------------------------------------------
// Repair log (Req 9.2, 9.3, 9.6)
// ---------------------------------------------------------------------------

export interface RepairInput {
  date?: unknown;
  /** Optional; defaults to '' (no fault). */
  faultCode?: unknown;
  actionTaken?: unknown;
  /** Optional; defaults to []. */
  modulesReplaced?: unknown;
}

/**
 * Service_Partner holder logs a repair: appends one Service_History record and sets
 * each replaced module to Good. VALIDATION_ERROR names every invalid field
 * (`date`, `faultCode`, `actionTaken`, `modulesReplaced` / `modulesReplaced.<i>`).
 */
export function logRepair(
  twin: DigitalTwin,
  viewer: ViewerContext,
  input: RepairInput,
  today: ISODate,
): CommandResult<{ serviceRecord: ServiceRecord }> {
  const roleErr = gateRole(viewer, 'repair');
  if (roleErr) return roleErr;
  const holderErr = gateServicePartnerHolder(twin, viewer);
  if (holderErr) return holderErr;

  const candidate = {
    date: input.date,
    faultCode: input.faultCode === undefined || input.faultCode === null ? '' : input.faultCode,
    actionTaken: input.actionTaken,
    modulesReplaced: input.modulesReplaced === undefined || input.modulesReplaced === null ? [] : input.modulesReplaced,
  };
  const fields: FieldError[] = [];
  const parsed = serviceRecordSchema().safeParse(candidate);
  if (!parsed.success) fields.push(...formatZodErrors(parsed.error));

  if (typeof candidate.date === 'string' && isValidIsoDate(candidate.date) && candidate.date > today) {
    fields.push({ field: 'date', message: `Must not be later than ${today}` });
  }
  if (Array.isArray(candidate.modulesReplaced)) {
    const known = new Set(twin.modules.map((m) => m.moduleId));
    candidate.modulesReplaced.forEach((id: unknown, i: number) => {
      if (typeof id === 'string' && id !== '' && !known.has(id)) {
        fields.push({ field: `modulesReplaced.${i}`, message: 'Must identify a module of this battery' });
      }
    });
  }
  if (fields.length > 0 || !parsed.success) return validationError('The repair log is invalid', fields);

  const serviceRecord: ServiceRecord = {
    date: parsed.data.date,
    faultCode: parsed.data.faultCode,
    actionTaken: parsed.data.actionTaken,
    modulesReplaced: [...parsed.data.modulesReplaced],
  };
  const replaced = new Set(serviceRecord.modulesReplaced);
  const next: DigitalTwin = {
    ...twin,
    serviceHistory: [...twin.serviceHistory, serviceRecord],
    modules: twin.modules.map((m) => (replaced.has(m.moduleId) ? { moduleId: m.moduleId, condition: 'Good' } : { ...m })),
  };
  return finish(twin, next, { serviceRecord });
}

// ---------------------------------------------------------------------------
// Referral to a Second_Life_Provider (Req 9.4, 9.7)
// ---------------------------------------------------------------------------

/**
 * Service_Partner holder refers the battery to a Second_Life_Provider: appends one
 * handover dated today and sets Routed_Pathway to Second_Life_Review.
 * VALIDATION_ERROR (field `secondLifeProviderId`) when the target is not a Second_Life_Provider.
 */
export function referToSecondLife(
  twin: DigitalTwin,
  viewer: ViewerContext,
  input: { secondLifeProviderId?: unknown },
  stakeholders: readonly Stakeholder[],
  today: ISODate,
): CommandResult<{ secondLifeProviderId: string }> {
  const roleErr = gateRole(viewer, 'referral');
  if (roleErr) return roleErr;
  const holderErr = gateServicePartnerHolder(twin, viewer);
  if (holderErr) return holderErr;

  const slp = findStakeholder(stakeholders, input.secondLifeProviderId, 'Second_Life_Provider');
  if (!slp) {
    return validationError('The referral target must be a Second_Life_Provider', [
      { field: 'secondLifeProviderId', message: 'Must identify a Second_Life_Provider' },
    ]);
  }
  const custody = appendCustody(twin, {
    date: today,
    fromHolderId: viewer.identityId,
    toHolderId: slp.id,
    toHolderRole: 'Second_Life_Provider',
  });
  if (!custody.ok) return custody;
  const next: DigitalTwin = { ...twin, custodyLog: custody.value.twin.custodyLog, routedPathway: 'Second_Life_Review' };
  return finish(twin, next, { secondLifeProviderId: slp.id });
}

// ---------------------------------------------------------------------------
// Dispatch to a Recycler (Req 9.5, 9.7, 10.4, 10.7, 10.8)
// ---------------------------------------------------------------------------

/**
 * Dispatches the battery to a Recycler. Allowed for the Service_Partner holder, or
 * for the Second_Life_Provider holder of a Second_Life_Review battery (else NOT_AVAILABLE).
 * Appends one handover dated today with `expectedArrivalDate` in [today, today + 90],
 * sets Routed_Pathway to Certified_Recycling; Intake_Status is then Awaiting_Intake
 * (derived: no `recyclerIntake` applies to the new dispatch handover).
 * VALIDATION_ERROR names `recyclerId` and/or `expectedArrivalDate`.
 */
export function dispatchToRecycler(
  twin: DigitalTwin,
  viewer: ViewerContext,
  input: { recyclerId?: unknown; expectedArrivalDate?: unknown },
  stakeholders: readonly Stakeholder[],
  today: ISODate,
): CommandResult<{ recyclerId: string; expectedArrivalDate: ISODate }> {
  const roleErr = gateRole(viewer, 'dispatch');
  if (roleErr) return roleErr;
  const holderErr = gateServicePartnerHolder(twin, viewer);
  if (holderErr) return holderErr;
  if (viewer.role === 'Second_Life_Provider' && !inScope(twin, viewer)) {
    return domainError('NOT_AVAILABLE', 'The battery is not available to this Second_Life_Provider');
  }

  const fields: FieldError[] = [];
  const recycler = findStakeholder(stakeholders, input.recyclerId, 'Recycler');
  if (!recycler) fields.push({ field: 'recyclerId', message: 'Must identify a Recycler' });
  const arrival = input.expectedArrivalDate;
  const latest = addDays(today, MAX_ARRIVAL_DAYS);
  if (typeof arrival !== 'string' || !isValidIsoDate(arrival)) {
    fields.push({ field: 'expectedArrivalDate', message: 'Required as a valid calendar date (YYYY-MM-DD)' });
  } else if (arrival < today || arrival > latest) {
    fields.push({ field: 'expectedArrivalDate', message: `Must be between ${today} and ${latest}` });
  }
  if (fields.length > 0 || !recycler || typeof arrival !== 'string') {
    return validationError('The dispatch request is invalid', fields);
  }

  const custody = appendCustody(twin, {
    date: today,
    fromHolderId: viewer.identityId,
    toHolderId: recycler.id,
    toHolderRole: 'Recycler',
    expectedArrivalDate: arrival,
  });
  if (!custody.ok) return custody;
  const next: DigitalTwin = { ...twin, custodyLog: custody.value.twin.custodyLog, routedPathway: 'Certified_Recycling' };
  return finish(twin, next, { recyclerId: recycler.id, expectedArrivalDate: arrival });
}

// ---------------------------------------------------------------------------
// Second-life acceptance (Req 1.10, 10.3, 10.6, 10.7)
// ---------------------------------------------------------------------------

/**
 * Second_Life_Provider accepts a battery in its view. Checks in order:
 * out of view → NOT_AVAILABLE; Safety_Flag (as of today) → SAFETY_FLAGGED;
 * existing End_Of_Life_Record → NOT_AVAILABLE. On success creates the
 * Second_Life_Review End_Of_Life_Record dated today with the provider as receiving party.
 */
export function acceptSecondLife(
  twin: DigitalTwin,
  viewer: ViewerContext,
  today: ISODate,
): CommandResult<{ endOfLife: EndOfLifeRecord }> {
  const roleErr = gateRole(viewer, 'acceptSecondLife');
  if (roleErr) return roleErr;
  if (!inScope(twin, viewer)) {
    return domainError('NOT_AVAILABLE', 'The battery is not available to this Second_Life_Provider');
  }
  if (safetyFlag(twin, today)) {
    return domainError('SAFETY_FLAGGED', 'The battery is safety-flagged and cannot be accepted for second life');
  }
  if (twin.endOfLife) {
    return domainError('NOT_AVAILABLE', 'The battery already has an End_Of_Life_Record');
  }
  const endOfLife: EndOfLifeRecord = {
    pathway: 'Second_Life_Review',
    date: today,
    receivingPartyId: viewer.identityId,
    materialsRecoveredKg: {},
  };
  const parsed = validate(endOfLifeRecordSchema, endOfLife);
  if (!parsed.ok) return parsed;
  return finish(twin, { ...twin, endOfLife }, { endOfLife });
}

// ---------------------------------------------------------------------------
// Recycler intake (Req 11.3, 11.4)
// ---------------------------------------------------------------------------

function notInRecyclerView(): { ok: false; error: DomainError } {
  return validationError('The battery is not in this Recycler\u2019s incoming list', [
    { field: 'batteryId', message: 'Must be a battery dispatched to this Recycler' },
  ]);
}

/**
 * Recycler logs intake for an Awaiting_Intake battery in its view. Records
 * `recyclerIntake` against the latest dispatch handover; appends no custody entry.
 * VALIDATION_ERROR: out of view (`batteryId`), already Received (`intakeStatus`),
 * or intake date missing / before the dispatch date / after today (`intakeDate`).
 */
export function logIntake(
  twin: DigitalTwin,
  viewer: ViewerContext,
  input: { intakeDate?: unknown },
  today: ISODate,
): CommandResult<{ recyclerIntake: RecyclerIntake }> {
  const roleErr = gateRole(viewer, 'intake');
  if (roleErr) return roleErr;
  if (!inScope(twin, viewer)) return notInRecyclerView();
  const status = intakeStatusOf(twin);
  const handoverIndex = latestDispatchIndex(twin);
  const dispatch = twin.custodyLog[handoverIndex];
  if (status === null || !dispatch) return notInRecyclerView();
  if (status === 'Received') {
    return validationError('Intake has already been logged for this battery', [
      { field: 'intakeStatus', message: 'Already Received' },
    ]);
  }
  const intakeDate = input.intakeDate;
  if (typeof intakeDate !== 'string' || !isValidIsoDate(intakeDate)) {
    return validationError('The intake date is invalid', [
      { field: 'intakeDate', message: 'Required as a valid calendar date (YYYY-MM-DD)' },
    ]);
  }
  if (intakeDate < dispatch.date || intakeDate > today) {
    return validationError('The intake date is out of range', [
      { field: 'intakeDate', message: `Must be between ${dispatch.date} and ${today}` },
    ]);
  }
  const recyclerIntake: RecyclerIntake = { handoverIndex, intakeDate };
  return finish(twin, { ...twin, recyclerIntake }, { recyclerIntake });
}

// ---------------------------------------------------------------------------
// Materials recovered (Req 1.10, 11.5, 11.6, 11.7)
// ---------------------------------------------------------------------------

/**
 * Recycler logs materials recovered for a Received battery in its view and writes the
 * Certified_Recycling End_Of_Life_Record dated today, replacing a prior
 * Second_Life_Review record. Errors: out of view → VALIDATION_ERROR (`batteryId`);
 * not Received → INTAKE_REQUIRED; existing Certified_Recycling record → EOL_EXISTS;
 * empty map, negative / non-numeric mass, or total above Pack_Mass → VALIDATION_ERROR (`materials...`).
 */
export function logMaterials(
  twin: DigitalTwin,
  viewer: ViewerContext,
  input: { materials?: unknown },
  today: ISODate,
): CommandResult<{ endOfLife: EndOfLifeRecord }> {
  const roleErr = gateRole(viewer, 'materials');
  if (roleErr) return roleErr;
  if (!inScope(twin, viewer)) return notInRecyclerView();
  if (intakeStatusOf(twin) !== 'Received') {
    return domainError('INTAKE_REQUIRED', 'Intake must be logged before materials recovered');
  }
  if (twin.endOfLife?.pathway === 'Certified_Recycling') {
    return domainError('EOL_EXISTS', 'Materials recovered have already been recorded for this battery');
  }

  const raw = input.materials;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return validationError('At least one material must be recorded', [
      { field: 'materials', message: 'Must contain at least one material' },
    ]);
  }
  const fields: FieldError[] = [];
  const materials: Record<string, number> = {};
  let total = 0;
  for (const [name, kg] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim() === '') {
      fields.push({ field: 'materials', message: 'Material names must not be empty' });
    } else if (typeof kg !== 'number' || !Number.isFinite(kg)) {
      fields.push({ field: `materials.${name}`, message: 'Must be a number' });
    } else if (kg < 0) {
      fields.push({ field: `materials.${name}`, message: 'Must be 0 or greater' });
    } else {
      materials[name] = kg;
      total += kg;
    }
  }
  if (fields.length === 0 && total > twin.passport.packMassKg) {
    fields.push({ field: 'materials', message: `Total mass must not exceed the Pack_Mass of ${twin.passport.packMassKg} kg` });
  }
  if (fields.length > 0) return validationError('The materials recovered are invalid', fields);

  const endOfLife: EndOfLifeRecord = {
    pathway: 'Certified_Recycling',
    date: today,
    receivingPartyId: viewer.identityId,
    materialsRecoveredKg: materials,
  };
  const parsed = validate(endOfLifeRecordSchema, endOfLife);
  if (!parsed.ok) return parsed;
  return finish(twin, { ...twin, endOfLife }, { endOfLife });
}
