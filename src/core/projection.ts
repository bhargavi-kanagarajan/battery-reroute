/**
 * Role projection, consent gating, and Returned_Battery redaction
 * (Req 3.2–3.7, 3.10, 3.15–3.17, 4.5–4.8, 4.10, 6.9, 7.22, 8.1, 8.2, 8.11, 9.1, 9.9,
 * 10.1, 11.1, 12.1).
 *
 * Pure: no clock, no I/O, never mutates its inputs. Every DTO is built from an
 * explicit field list (never by spreading the twin), so unlisted fields cannot leak.
 * Wherever `dataConfidence` appears, a separate `consentStatus` sits next to it.
 */

import { esgCustodyEntries, inScope, isCurrentHolder, ownerDataVisible, ownerReturnedScope } from './access';
import { dataConfidence } from './confidence';
import { evaluateHealth, type ContributingFactor, type HealthResult } from './health';
import { impactComponents, impactScore } from './impact';
import { reconcileNudges } from './nudges';
import { recommendPathway, type FiredRule, type PathwayResult, type RuleName } from './pathway';
import { dispositionAsOf, measurementStatusAsOf } from './scope3';
import { applicationFit, roundUsableCapacity, usableCapacity, type ApplicationFit } from './secondLife';
import {
  consentStatus,
  currentHolder,
  latestInspectionFlag,
  latestReading,
  recentFault,
  returnRecordFor,
  safetyCriticalFaults,
  safetyFlag,
} from './telemetry';
import type {
  ConsentStatus,
  DigitalTwin,
  Disposition,
  EolPathway,
  EsgCustodyEntry,
  ISODate,
  ISODateTime,
  ImpactComponents,
  ImpactScore,
  IntakeStatus,
  Location,
  MeasurementStatus,
  Module,
  ModuleCondition,
  Nudge,
  OwnerReturnedBatteryView,
  Pathway,
  ReturnOffer,
  ReturnRecord,
  ServiceRecord,
  Stakeholder,
  ViewerContext,
} from './types';

// ---------------------------------------------------------------------------
// Withheld marker (Req 4.6)
// ---------------------------------------------------------------------------

export const WITHHELD_REASON = 'Owner data withheld pending consent' as const;

export interface Withheld {
  withheld: true;
  reason: typeof WITHHELD_REASON;
}

/** A value that may be replaced by the withheld-pending-consent marker. */
export type Gated<T> = T | Withheld;

export function withheld(): Withheld {
  return { withheld: true, reason: WITHHELD_REASON };
}

export function isWithheld(value: unknown): value is Withheld {
  return typeof value === 'object' && value !== null && (value as { withheld?: unknown }).withheld === true;
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

export type SecondLifeAcceptance = 'Pending' | 'Accepted';

export interface Derived {
  evalDate: ISODate;
  health: HealthResult;
  pathway: PathwayResult;
  /** Active nudge set reconciled for evalDate (Owner-held twins), else the stored set. */
  nudges: Nudge[];
  /** True when `nudges` differs from `twin.nudges`; the server persists only then. */
  nudgesChanged: boolean;
  /** Only for batteries whose Current_Holder role is Owner (Req 7.13). */
  impact: { components: ImpactComponents; score: ImpactScore } | null;
  safetyFlag: boolean;
  recentFault: ServiceRecord | undefined;
  /** Latest SoH on or before evalDate, or null without Telemetry. */
  soh: number | null;
  /** Unrounded; null without Telemetry. */
  usableCapacity: number | null;
  applicationFit: ApplicationFit;
  intakeStatus: IntakeStatus | null;
  acceptance: SecondLifeAcceptance;
  disposition: Disposition;
  measurementStatus: MeasurementStatus;
  dataConfidence: number;
  consentStatus: ConsentStatus;
}

/** Index of the latest Custody_Log handover to a Recycler, or -1. */
export function latestDispatchIndex(twin: Pick<DigitalTwin, 'custodyLog'>): number {
  for (let i = twin.custodyLog.length - 1; i >= 0; i--) {
    if (twin.custodyLog[i]!.toHolderRole === 'Recycler') return i;
  }
  return -1;
}

/**
 * Intake_Status: null unless Routed_Pathway is Certified_Recycling with a dispatch
 * handover; Received when `recyclerIntake` applies to the latest dispatch handover.
 */
export function intakeStatusOf(
  twin: Pick<DigitalTwin, 'routedPathway' | 'custodyLog' | 'recyclerIntake'>,
): IntakeStatus | null {
  if (twin.routedPathway !== 'Certified_Recycling') return null;
  const idx = latestDispatchIndex(twin);
  if (idx < 0) return null;
  return twin.recyclerIntake?.handoverIndex === idx ? 'Received' : 'Awaiting_Intake';
}

/** Accepted when the End_Of_Life_Record is a Second_Life_Review record. */
export function secondLifeAcceptance(twin: Pick<DigitalTwin, 'endOfLife'>): SecondLifeAcceptance {
  return twin.endOfLife?.pathway === 'Second_Life_Review' ? 'Accepted' : 'Pending';
}

/**
 * Combines every derived value a projection needs. Nudges are reconciled for the
 * Owner Current_Holder (resolved from `stakeholders`), and Impact_Score is computed
 * on the reconciled set. `_viewer` is accepted for API symmetry; derived values do
 * not depend on the viewer (Req 6.15).
 */
export function evaluateDerived(
  twin: DigitalTwin,
  evalDate: ISODate,
  _viewer: ViewerContext,
  stakeholders: readonly Stakeholder[],
): Derived {
  const holder = currentHolder(twin.custodyLog);
  const ownerHeld = holder?.toHolderRole === 'Owner';

  let nudges: Nudge[] = twin.nudges;
  if (ownerHeld) {
    const owner = stakeholders.find((s) => s.id === holder.toHolderId && s.role === 'Owner');
    if (owner) {
      nudges = reconcileNudges(twin, evalDate, owner, stakeholders.filter((s) => s.role === 'Service_Partner'));
    }
  } else {
    nudges = [];
  }
  const nudgesChanged = JSON.stringify(nudges) !== JSON.stringify(twin.nudges);

  let impact: Derived['impact'] = null;
  if (ownerHeld) {
    const components = impactComponents({ ...twin, nudges }, evalDate, holder.toHolderId);
    impact = { components, score: impactScore(components) };
  }

  const soh = latestReading(twin, evalDate)?.sohPct ?? null;

  return {
    evalDate,
    health: evaluateHealth(twin, evalDate),
    pathway: recommendPathway(twin, evalDate),
    nudges,
    nudgesChanged,
    impact,
    safetyFlag: safetyFlag(twin, evalDate),
    recentFault: recentFault(twin, evalDate),
    soh,
    usableCapacity: soh === null ? null : usableCapacity(twin.passport.capacityKwh, soh),
    applicationFit: applicationFit(twin, evalDate),
    intakeStatus: intakeStatusOf(twin),
    acceptance: secondLifeAcceptance(twin),
    disposition: dispositionAsOf(twin, evalDate),
    measurementStatus: measurementStatusAsOf(twin, evalDate),
    dataConfidence: dataConfidence(twin),
    consentStatus: consentStatus(twin),
  };
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export type RemainingLifeView =
  | { months: number; cycles: number }
  | { unknown: true; reason: 'TELEMETRY_MISSING' | 'INSUFFICIENT_TELEMETRY_HISTORY' };

export interface PathwayView {
  pathway: Pathway;
  decidingRule: RuleName;
  firedRules: FiredRule[];
  reason?: string;
  /** Shown so the Plugin can place the Validation_Notice (Req 6.13). */
  routedPathway: EolPathway | null;
  eolPathway: EolPathway | null;
}

export interface OwnerBatteryView {
  batteryId: string;
  healthScore: Gated<number | null>;
  factors: Gated<ContributingFactor[]>;
  impactScore: Gated<ImpactScore>;
  impactComponents: Gated<ImpactComponents>;
  nudges: Nudge[];
  remainingLife: Gated<RemainingLifeView>;
  pathway: PathwayView;
  dataConfidence: number;
  returnOffer: ReturnOffer | null;
  consentStatus: ConsentStatus;
}

export interface SohPoint {
  timestamp: ISODateTime;
  sohPct: number;
}

export type InspectionFlagSummary =
  | { flagged: false }
  | { flagged: true; flagDate: ISODate; servicePartnerId: string; servicePartnerName: string };

export interface FleetBatteryView {
  batteryId: string;
  healthScore: Gated<number | null>;
  soh: Gated<number | null>;
  sohSeries: Gated<SohPoint[]>;
  remainingLife: Gated<RemainingLifeView>;
  safetyFlag: boolean;
  recentFault: boolean;
  inspectionFlag: InspectionFlagSummary;
  consentStatus: ConsentStatus;
}

export type ServiceAssignment = 'Assigned' | 'ReferredForInspection';

export const PENDING_HANDOVER_REASON = 'Custody handover from the Fleet_Operator is pending' as const;
export const CUSTODY_MOVED_REASON = 'Custody has passed to another holder' as const;

export interface ServicePartnerBatteryView {
  batteryId: string;
  /** Reverse chronological. */
  serviceHistory: ServiceRecord[];
  /** Non-empty fault codes with their dates, reverse chronological. */
  faultCodes: { date: ISODate; faultCode: string }[];
  modules: { moduleId: string; condition: ModuleCondition }[];
  pathway: PathwayView;
  dataConfidence: number;
  consentStatus: ConsentStatus;
  assignment: ServiceAssignment;
  actionsEnabled: boolean;
  actionsDisabledReason?: string;
}

export interface SafetyHistoryView {
  safetyFlag: boolean;
  /** Thermal event count of the latest reading; null without Telemetry. */
  thermalEventCount: Gated<number | null>;
  safetyCriticalFaults: { date: ISODate; faultCode: string }[];
}

export interface SecondLifeBatteryView {
  batteryId: string;
  capacityKwh: number;
  soh: Gated<number | null>;
  /** Rounded to one decimal place. */
  usableCapacity: Gated<number | null>;
  safetyHistory: SafetyHistoryView;
  applicationFit: Gated<ApplicationFit>;
  acceptance: SecondLifeAcceptance;
  pathway: PathwayView;
  dataConfidence: number;
  consentStatus: ConsentStatus;
}

export interface RecyclerBatteryView {
  batteryId: string;
  chemistry: string;
  packMassKg: number;
  /** City/state of the from-holder of the latest handover; null when unknown. */
  location: Location | null;
  expectedArrival: ISODate | null;
  intakeStatus: IntakeStatus | null;
}

export interface EsgBatteryView {
  batteryId: string;
  disposition: Disposition;
  custodyLog: EsgCustodyEntry[];
  measurementStatus: MeasurementStatus;
  dataConfidence: number;
  consentStatus: ConsentStatus;
}

export type RoleView =
  | OwnerBatteryView
  | OwnerReturnedBatteryView
  | FleetBatteryView
  | ServicePartnerBatteryView
  | SecondLifeBatteryView
  | RecyclerBatteryView
  | EsgBatteryView;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function remainingLifeView(health: HealthResult): RemainingLifeView {
  if (!health.ok) return { unknown: true, reason: 'TELEMETRY_MISSING' };
  if (health.remainingLife === null) return { unknown: true, reason: 'INSUFFICIENT_TELEMETRY_HISTORY' };
  return { months: health.remainingLife.months, cycles: health.remainingLife.cycles };
}

/**
 * Pathway recommendation view. It is not consent-gated (decision support), but when
 * Owner_Data is withheld the telemetry-derived rule inputs (SoH, thermal events) are
 * stripped so no Owner_Data value appears in the response (Property 13).
 */
function pathwayView(twin: DigitalTwin, pathway: PathwayResult, gated: boolean): PathwayView {
  const firedRules: FiredRule[] = pathway.firedRules.map((fr) => {
    const inputs: FiredRule['inputs'] = {};
    if (!gated && fr.inputs.soh !== undefined) inputs.soh = fr.inputs.soh;
    if (!gated && fr.inputs.thermalEvents !== undefined) inputs.thermalEvents = fr.inputs.thermalEvents;
    if (fr.inputs.safetyCriticalFaultCode !== undefined) inputs.safetyCriticalFaultCode = fr.inputs.safetyCriticalFaultCode;
    if (fr.inputs.recentFaultDate !== undefined) inputs.recentFaultDate = fr.inputs.recentFaultDate;
    if (fr.inputs.telemetryMissing) inputs.telemetryMissing = true;
    return { rule: fr.rule, inputs };
  });
  const view: PathwayView = {
    pathway: pathway.pathway,
    decidingRule: pathway.decidingRule,
    firedRules,
    routedPathway: twin.routedPathway,
    eolPathway: twin.endOfLife?.pathway ?? null,
  };
  if (pathway.reason !== undefined) view.reason = pathway.reason;
  return view;
}

function gate<T>(gated: boolean, value: T): Gated<T> {
  return gated ? withheld() : value;
}

function copyServiceRecord(s: ServiceRecord): ServiceRecord {
  return { date: s.date, faultCode: s.faultCode, actionTaken: s.actionTaken, modulesReplaced: [...s.modulesReplaced] };
}

function copyModule(m: Module): { moduleId: string; condition: ModuleCondition } {
  return { moduleId: m.moduleId, condition: m.condition };
}

/** Telemetry sorted by timestamp ascending (stable), one point per reading (Req 8.2). */
export function sohSeriesOf(twin: Pick<DigitalTwin, 'telemetry'>): SohPoint[] {
  return twin.telemetry
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.timestamp < b.r.timestamp ? -1 : a.r.timestamp > b.r.timestamp ? 1 : a.i - b.i))
    .map(({ r }) => ({ timestamp: r.timestamp, sohPct: r.sohPct }));
}

/** Service_History in reverse chronological order (stable for equal dates: later entries first). */
export function serviceHistoryDesc(twin: Pick<DigitalTwin, 'serviceHistory'>): ServiceRecord[] {
  return twin.serviceHistory
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.date < b.s.date ? 1 : a.s.date > b.s.date ? -1 : b.i - a.i))
    .map(({ s }) => copyServiceRecord(s));
}

// ---------------------------------------------------------------------------
// Per-role projections
// ---------------------------------------------------------------------------

export function projectOwner(twin: DigitalTwin, d: Derived, viewer: ViewerContext): OwnerBatteryView {
  const gated = !ownerDataVisible(twin, viewer);
  const incentive = d.nudges.find((n) => n.type === 'Return_Incentive');
  const components = d.impact?.components ?? impactComponents({ ...twin, nudges: d.nudges }, d.evalDate, viewer.identityId);
  return {
    batteryId: twin.passport.batteryId,
    healthScore: gate(gated, d.health.ok ? d.health.healthScore : null),
    factors: gate(gated, d.health.ok ? d.health.factors.map((f) => ({ ...f })) : []),
    // Charging_Component derives from Fast_Charge_Share (charging group).
    impactScore: gate(gated, impactScore(components)),
    impactComponents: gate(gated, { ...components }),
    nudges: d.nudges.map((n) => (n.type === 'Return_Incentive' ? { ...n, returnOffer: { ...n.returnOffer } } : { ...n })),
    remainingLife: gate(gated, remainingLifeView(d.health)),
    pathway: pathwayView(twin, d.pathway, gated),
    dataConfidence: d.dataConfidence,
    returnOffer: incentive?.type === 'Return_Incentive' ? { ...incentive.returnOffer } : null,
    consentStatus: d.consentStatus,
  };
}

export function projectFleet(
  twin: DigitalTwin,
  d: Derived,
  viewer: ViewerContext,
  stakeholders: readonly Stakeholder[],
): FleetBatteryView {
  const gated = !ownerDataVisible(twin, viewer);
  const flag = latestInspectionFlag(twin);
  const inspectionFlag: InspectionFlagSummary = flag
    ? {
        flagged: true,
        flagDate: flag.flagDate,
        servicePartnerId: flag.servicePartnerId,
        servicePartnerName: stakeholders.find((s) => s.id === flag.servicePartnerId)?.name ?? flag.servicePartnerId,
      }
    : { flagged: false };
  return {
    batteryId: twin.passport.batteryId,
    healthScore: gate(gated, d.health.ok ? d.health.healthScore : null),
    soh: gate(gated, d.soh),
    sohSeries: gate(gated, sohSeriesOf(twin)),
    remainingLife: gate(gated, remainingLifeView(d.health)),
    safetyFlag: d.safetyFlag,
    recentFault: d.recentFault !== undefined,
    inspectionFlag,
    consentStatus: d.consentStatus,
  };
}

export function projectServicePartner(twin: DigitalTwin, d: Derived, viewer: ViewerContext): ServicePartnerBatteryView {
  const gated = !ownerDataVisible(twin, viewer);
  const history = serviceHistoryDesc(twin);
  const holder = currentHolder(twin.custodyLog);

  let assignment: ServiceAssignment;
  let actionsEnabled: boolean;
  let actionsDisabledReason: string | undefined;
  if (isCurrentHolder(twin, viewer)) {
    assignment = 'Assigned';
    actionsEnabled = true;
  } else if (twin.returnRecords.some((r) => r.servicePartnerId === viewer.identityId)) {
    // Visible only through a past ReturnRecord after custody moved on.
    assignment = 'Assigned';
    actionsEnabled = false;
    actionsDisabledReason = CUSTODY_MOVED_REASON;
  } else {
    // Visible through the most recent Inspection_Flag.
    assignment = 'ReferredForInspection';
    actionsEnabled = false;
    actionsDisabledReason = holder?.toHolderRole === 'Fleet_Operator' ? PENDING_HANDOVER_REASON : CUSTODY_MOVED_REASON;
  }

  const view: ServicePartnerBatteryView = {
    batteryId: twin.passport.batteryId,
    serviceHistory: history,
    faultCodes: history.filter((s) => s.faultCode !== '').map((s) => ({ date: s.date, faultCode: s.faultCode })),
    modules: twin.modules.map(copyModule),
    pathway: pathwayView(twin, d.pathway, gated),
    dataConfidence: d.dataConfidence,
    consentStatus: d.consentStatus,
    assignment,
    actionsEnabled,
  };
  if (actionsDisabledReason !== undefined) view.actionsDisabledReason = actionsDisabledReason;
  return view;
}

export function projectSecondLife(twin: DigitalTwin, d: Derived, viewer: ViewerContext): SecondLifeBatteryView {
  const gated = !ownerDataVisible(twin, viewer);
  const latest = latestReading(twin, d.evalDate);
  return {
    batteryId: twin.passport.batteryId,
    capacityKwh: twin.passport.capacityKwh,
    soh: gate(gated, d.soh),
    usableCapacity: gate(gated, d.usableCapacity === null ? null : roundUsableCapacity(d.usableCapacity)),
    safetyHistory: {
      safetyFlag: d.safetyFlag,
      thermalEventCount: gate(gated, latest ? latest.thermalEventCount : null),
      safetyCriticalFaults: safetyCriticalFaults(twin, d.evalDate).map((s) => ({ date: s.date, faultCode: s.faultCode })),
    },
    applicationFit: gate(gated, d.applicationFit),
    acceptance: d.acceptance,
    pathway: pathwayView(twin, d.pathway, gated),
    dataConfidence: d.dataConfidence,
    consentStatus: d.consentStatus,
  };
}

export function projectRecycler(
  twin: DigitalTwin,
  d: Derived,
  stakeholders: readonly Stakeholder[],
): RecyclerBatteryView {
  const last = currentHolder(twin.custodyLog);
  const from = last?.fromHolderId ? stakeholders.find((s) => s.id === last.fromHolderId) : undefined;
  return {
    batteryId: twin.passport.batteryId,
    chemistry: twin.passport.chemistry,
    packMassKg: twin.passport.packMassKg,
    location: from ? { city: from.location.city, state: from.location.state } : null,
    expectedArrival: last?.expectedArrivalDate ?? null,
    intakeStatus: d.intakeStatus,
  };
}

export function projectEsg(twin: DigitalTwin, d: Derived, stakeholders: readonly Stakeholder[]): EsgBatteryView {
  return {
    batteryId: twin.passport.batteryId,
    disposition: d.disposition,
    custodyLog: esgCustodyEntries(twin.custodyLog, stakeholders),
    measurementStatus: d.measurementStatus,
    dataConfidence: d.dataConfidence,
    consentStatus: d.consentStatus,
  };
}

/**
 * Returned_Battery view (Req 3.2, 3.17, 7.22). Reads only the immutable ReturnRecord,
 * never the live twin, so nothing recorded after the handover can reach the Owner.
 */
export function projectReturned(record: ReturnRecord): OwnerReturnedBatteryView {
  return {
    batteryId: record.batteryId,
    returnDate: record.returnDate,
    servicePartnerName: record.servicePartnerName,
    finalImpactScore: record.finalImpactScore,
    components: {
      charging: record.components.charging,
      servicing: record.components.servicing,
      consent: record.components.consent,
      return: record.components.return,
    },
  };
}

/**
 * Role DTO for one battery. Does not check scope (callers use `inScope` first).
 * For an Owner viewing one of its Returned_Batteries, returns only the returned view.
 */
export function project(
  twin: DigitalTwin,
  derived: Derived,
  viewer: ViewerContext,
  stakeholders: readonly Stakeholder[],
): RoleView {
  switch (viewer.role) {
    case 'Owner': {
      const record = returnRecordFor(twin, viewer.identityId);
      if (record && !isCurrentHolder(twin, viewer)) return projectReturned(record);
      return projectOwner(twin, derived, viewer);
    }
    case 'Fleet_Operator':
      return projectFleet(twin, derived, viewer, stakeholders);
    case 'Service_Partner':
      return projectServicePartner(twin, derived, viewer);
    case 'Second_Life_Provider':
      return projectSecondLife(twin, derived, viewer);
    case 'Recycler':
      return projectRecycler(twin, derived, stakeholders);
    case 'ESG_Officer':
      return projectEsg(twin, derived, stakeholders);
  }
}

// ---------------------------------------------------------------------------
// List helpers (Req 8.1, 11.1)
// ---------------------------------------------------------------------------

const byId = (a: { batteryId: string }, b: { batteryId: string }) =>
  a.batteryId < b.batteryId ? -1 : a.batteryId > b.batteryId ? 1 : 0;

function numericOrNull(v: Gated<number | null>): number | null {
  return typeof v === 'number' ? v : null;
}

/** Fleet list by Health_Score ascending; unknown or withheld scores last; ties by battery ID. */
export function sortFleetByHealth(views: readonly FleetBatteryView[]): FleetBatteryView[] {
  return [...views].sort((a, b) => {
    const x = numericOrNull(a.healthScore);
    const y = numericOrNull(b.healthScore);
    if (x !== null && y !== null && x !== y) return x - y;
    if (x === null && y !== null) return 1;
    if (x !== null && y === null) return -1;
    return byId(a, b);
  });
}

/** Recycler list by expected arrival ascending; missing dates last; ties by battery ID. */
export function sortRecyclerByArrival(views: readonly RecyclerBatteryView[]): RecyclerBatteryView[] {
  return [...views].sort((a, b) => {
    const x = a.expectedArrival;
    const y = b.expectedArrival;
    if (x !== null && y !== null && x !== y) return x < y ? -1 : 1;
    if (x === null && y !== null) return 1;
    if (x !== null && y === null) return -1;
    return byId(a, b);
  });
}

export interface BatteryListProjection {
  batteries: RoleView[];
  /** Owner only. */
  returnedBatteries?: OwnerReturnedBatteryView[];
  /** Reconciled nudge sets that differ from the stored set, keyed by battery ID (persist these). */
  nudgeUpdates: Record<string, Nudge[]>;
}

/**
 * Scoped, projected, and ordered battery list for a viewer. Owners additionally get
 * `returnedBatteries` built only from ReturnRecords, ordered by return date then ID.
 */
export function projectBatteryList(
  twins: readonly DigitalTwin[],
  evalDate: ISODate,
  viewer: ViewerContext,
  stakeholders: readonly Stakeholder[],
): BatteryListProjection {
  const nudgeUpdates: Record<string, Nudge[]> = {};
  const scoped = twins.filter((t) => inScope(t, viewer));
  const views = scoped.map((t) => {
    const d = evaluateDerived(t, evalDate, viewer, stakeholders);
    if (d.nudgesChanged) nudgeUpdates[t.passport.batteryId] = d.nudges;
    return project(t, d, viewer, stakeholders);
  });

  let batteries: RoleView[];
  if (viewer.role === 'Fleet_Operator') batteries = sortFleetByHealth(views as FleetBatteryView[]);
  else if (viewer.role === 'Recycler') batteries = sortRecyclerByArrival(views as RecyclerBatteryView[]);
  else batteries = [...views].sort(byId);

  if (viewer.role !== 'Owner') return { batteries, nudgeUpdates };

  const returnedBatteries = ownerReturnedScope(twins, viewer.identityId)
    .map((t) => projectReturned(returnRecordFor(t, viewer.identityId)!))
    .sort((a, b) => (a.returnDate < b.returnDate ? -1 : a.returnDate > b.returnDate ? 1 : byId(a, b)));
  return { batteries, returnedBatteries, nudgeUpdates };
}
