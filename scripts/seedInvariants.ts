/**
 * Seeding invariants checked before the Seed_Script writes the store (design: Seed_Script step 8).
 *
 * `checkSeedInvariants(dataset, runDate)` is pure: it reads only its arguments, recomputes
 * pathways on `runDate` with the core Pathway_Recommender, and returns every violated
 * invariant (it never stops at the first). The seed CLI refuses to write when `ok` is false.
 *
 * Each semantic check runs in isolation, so a malformed dataset that makes one check throw
 * is reported as a violation of that invariant instead of aborting the whole run.
 */
import { DEMO_BATTERY_ID } from './seedGenerator';
import { hasEmptyPassportField } from '../src/core/confidence';
import { datePart, isIsoDate } from '../src/core/dates';
import { designateServicePartner } from '../src/core/nudges';
import { recommendPathway } from '../src/core/pathway';
import { formatZodErrors, storeSchema } from '../src/core/schemas';
import { consentStatus, currentHolder, recentFault, safetyFlag } from '../src/core/telemetry';
import type { DigitalTwin, HolderRole, ISODate, Pathway, Role, Store } from '../src/core/types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SeedInvariant =
  | 'SCHEMA_VALID' // whole store passes storeSchema(runDate)
  | 'TWIN_COUNT' // Req 2.1: 45–55 twins, unique battery IDs
  | 'MANUFACTURER_COVERAGE' // Req 2.2
  | 'CHEMISTRY_COVERAGE' // Req 2.2
  | 'PATHWAY_COVERAGE' // Req 2.3
  | 'FLEET_SIZE' // Req 2.4
  | 'HOLDER_ROLE_COVERAGE' // Req 2.4
  | 'OWNER_CONSENT_RATIO' // Req 2.5
  | 'FLEET_CONSENT' // Req 2.5
  | 'EOL_COVERAGE' // Req 2.5
  | 'MISSING_RECORDS_COVERAGE' // Req 2.5
  | 'ROUTED_SECOND_LIFE' // Req 2.6
  | 'ROUTED_RECYCLING' // Req 2.6
  | 'STAKEHOLDER_COVERAGE' // Req 2.6, 13.3: ≥ 1 identity per role, every identity located
  | 'TELEMETRY_SOH' // Req 2.10
  | 'CONSENT_BEFORE_HANDOVER' // Req 2.14
  | 'DEMO_BATTERY'; // Req 2.7, 14.6

export interface SeedInvariantViolation {
  invariant: SeedInvariant;
  message: string;
}

export type SeedInvariantResult = { ok: true } | { ok: false; violations: SeedInvariantViolation[] };

export const MIN_TWINS = 45;
export const MAX_TWINS = 55;
export const MIN_PER_MANUFACTURER_OR_CHEMISTRY = 3;
export const MIN_DISTINCT_MANUFACTURERS_OR_CHEMISTRIES = 3;
export const MIN_PER_PATHWAY = 3;
export const MIN_FLEET_SIZE = 10;
export const MIN_OWNER_CONSENT_RATIO = 0.5;
export const MAX_OWNER_CONSENT_RATIO = 0.7;
export const MIN_EOL_TWINS = 5;
export const MIN_NON_EOL_TWINS = 5;
export const MIN_MISSING_RECORD_TWINS = 5;

const ALL_ROLES: readonly Role[] = [
  'Owner',
  'Fleet_Operator',
  'Service_Partner',
  'Second_Life_Provider',
  'Recycler',
  'ESG_Officer',
];
const REQUIRED_HOLDER_ROLES: readonly HolderRole[] = ['Owner', 'Service_Partner', 'Second_Life_Provider', 'Recycler'];
const PATHWAYS: readonly Pathway[] = ['Continue_Use', 'Inspect_Repair', 'Second_Life_Review', 'Certified_Recycling'];
const DOWNSTREAM_ROLES: readonly HolderRole[] = ['Service_Partner', 'Second_Life_Provider', 'Recycler'];

/** Checks every seeding invariant; returns all violations. */
export function checkSeedInvariants(dataset: Store, runDate: ISODate): SeedInvariantResult {
  const violations: SeedInvariantViolation[] = [];
  const report = (invariant: SeedInvariant, message: string) => violations.push({ invariant, message });

  if (!isIsoDate(runDate)) {
    report('SCHEMA_VALID', `Invalid run date: ${String(runDate)}`);
    return { ok: false, violations };
  }

  // Schema validity (dotted field paths).
  const parsed = storeSchema(runDate).safeParse(dataset);
  if (!parsed.success) {
    for (const f of formatZodErrors(parsed.error)) report('SCHEMA_VALID', `${f.field}: ${f.message}`);
  }

  const ctx: Ctx = { dataset, runDate, twins: Object.values(dataset?.twins ?? {}), report };
  for (const [invariant, check] of CHECKS) {
    try {
      check(ctx);
    } catch (err) {
      report(invariant, `Could not be evaluated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Human-readable multi-line summary for CLI output. */
export function formatSeedInvariantViolations(violations: readonly SeedInvariantViolation[]): string {
  return violations.map((v) => `[${v.invariant}] ${v.message}`).join('\n');
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

interface Ctx {
  dataset: Store;
  runDate: ISODate;
  twins: DigitalTwin[];
  report: (invariant: SeedInvariant, message: string) => void;
}

const holderOf = (t: DigitalTwin) => currentHolder(t.custodyLog);
const idOf = (t: DigitalTwin) => t.passport.batteryId;

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

/** Twins held by each Fleet_Operator identity. */
function fleets(twins: readonly DigitalTwin[]): Map<string, DigitalTwin[]> {
  const m = new Map<string, DigitalTwin[]>();
  for (const t of twins) {
    const h = holderOf(t);
    if (h?.toHolderRole !== 'Fleet_Operator') continue;
    m.set(h.toHolderId, [...(m.get(h.toHolderId) ?? []), t]);
  }
  return m;
}

function checkTwinCount({ twins, report }: Ctx) {
  if (twins.length < MIN_TWINS || twins.length > MAX_TWINS) {
    report('TWIN_COUNT', `Expected ${MIN_TWINS}–${MAX_TWINS} twins, found ${twins.length}`);
  }
  const dupes = [...countBy(twins, idOf)].filter(([, n]) => n > 1).map(([id]) => id);
  if (dupes.length > 0) report('TWIN_COUNT', `Duplicate battery IDs: ${dupes.join(', ')}`);
}

function checkPassportCoverage(field: 'manufacturer' | 'chemistry', invariant: SeedInvariant) {
  return ({ twins, report }: Ctx) => {
    const counts = countBy(
      twins.filter((t) => t.passport[field] !== ''),
      (t) => t.passport[field],
    );
    const qualifying = [...counts].filter(([, n]) => n >= MIN_PER_MANUFACTURER_OR_CHEMISTRY);
    if (qualifying.length < MIN_DISTINCT_MANUFACTURERS_OR_CHEMISTRIES) {
      const seen = [...counts].map(([k, n]) => `${k}=${n}`).join(', ') || 'none';
      report(
        invariant,
        `Expected ≥ ${MIN_DISTINCT_MANUFACTURERS_OR_CHEMISTRIES} distinct ${field} values on ≥ ${MIN_PER_MANUFACTURER_OR_CHEMISTRY} twins each, found ${qualifying.length} (${seen})`,
      );
    }
  };
}

function checkPathwayCoverage({ twins, runDate, report }: Ctx) {
  const counts = countBy(twins, (t) => recommendPathway(t, runDate).pathway);
  for (const p of PATHWAYS) {
    const n = counts.get(p) ?? 0;
    if (n < MIN_PER_PATHWAY) report('PATHWAY_COVERAGE', `Pathway ${p} assigned to ${n} twins on ${runDate}; expected ≥ ${MIN_PER_PATHWAY}`);
  }
}

function checkFleetSize({ twins, report }: Ctx) {
  const largest = Math.max(0, ...[...fleets(twins).values()].map((f) => f.length));
  if (largest < MIN_FLEET_SIZE) {
    report('FLEET_SIZE', `Expected a Fleet_Operator holding ≥ ${MIN_FLEET_SIZE} twins; largest fleet has ${largest}`);
  }
}

function checkHolderRoles({ twins, report }: Ctx) {
  const roles = new Set(twins.map((t) => holderOf(t)?.toHolderRole));
  for (const r of REQUIRED_HOLDER_ROLES) {
    if (!roles.has(r)) report('HOLDER_ROLE_COVERAGE', `No twin has a Current_Holder with role ${r}`);
  }
}

function checkOwnerConsentRatio({ twins, report }: Ctx) {
  const ownerHeld = twins.filter((t) => holderOf(t)?.toHolderRole === 'Owner');
  if (ownerHeld.length === 0) {
    report('OWNER_CONSENT_RATIO', 'No Owner-held twins');
    return;
  }
  const granted = ownerHeld.filter((t) => consentStatus(t) === 'granted').length;
  const ratio = granted / ownerHeld.length;
  if (ratio < MIN_OWNER_CONSENT_RATIO || ratio > MAX_OWNER_CONSENT_RATIO) {
    report(
      'OWNER_CONSENT_RATIO',
      `${granted} of ${ownerHeld.length} Owner-held twins have Consent (${(ratio * 100).toFixed(1)}%); expected 50–70%`,
    );
  }
}

/** At least one fleet whose every twin has that Fleet_Operator as Data_Owner and Consent granted. */
function checkFleetConsent({ twins, report }: Ctx) {
  const ok = [...fleets(twins)].some(([foId, ts]) =>
    ts.every((t) => t.dataOwner.role === 'Fleet_Operator' && t.dataOwner.id === foId && consentStatus(t) === 'granted'),
  );
  if (!ok) report('FLEET_CONSENT', 'No fleet has Consent granted by its Fleet_Operator on every battery');
}

function checkEolCoverage({ twins, report }: Ctx) {
  const withEol = twins.filter((t) => t.endOfLife !== null).length;
  const withoutEol = twins.length - withEol;
  if (withEol < MIN_EOL_TWINS) report('EOL_COVERAGE', `${withEol} twins have an End_Of_Life_Record; expected ≥ ${MIN_EOL_TWINS}`);
  if (withoutEol < MIN_NON_EOL_TWINS) {
    report('EOL_COVERAGE', `${withoutEol} twins have no End_Of_Life_Record; expected ≥ ${MIN_NON_EOL_TWINS}`);
  }
}

function checkMissingRecords({ twins, report }: Ctx) {
  const n = twins.filter(
    (t) =>
      t.telemetry.length === 0 ||
      t.chargingHistory.length === 0 ||
      t.serviceHistory.length === 0 ||
      hasEmptyPassportField(t.passport),
  ).length;
  if (n < MIN_MISSING_RECORD_TWINS) {
    report('MISSING_RECORDS_COVERAGE', `${n} twins have missing records; expected ≥ ${MIN_MISSING_RECORD_TWINS}`);
  }
}

function checkRoutedSecondLife({ twins, report }: Ctx) {
  const ok = twins.some((t) => t.routedPathway === 'Second_Life_Review' && holderOf(t)?.toHolderRole === 'Second_Life_Provider');
  if (!ok) report('ROUTED_SECOND_LIFE', 'No twin with Routed_Pathway Second_Life_Review is held by a Second_Life_Provider');
}

function checkRoutedRecycling({ twins, report }: Ctx) {
  const ok = twins.some((t) => t.routedPathway === 'Certified_Recycling' && holderOf(t)?.toHolderRole === 'Recycler');
  if (!ok) report('ROUTED_RECYCLING', 'No twin with Routed_Pathway Certified_Recycling has been dispatched to a Recycler');
}

function checkStakeholders({ dataset, report }: Ctx) {
  for (const r of ALL_ROLES) {
    if (!dataset.stakeholders.some((s) => s.role === r)) report('STAKEHOLDER_COVERAGE', `No stakeholder identity with role ${r}`);
  }
  for (const s of dataset.stakeholders) {
    if (!s.location?.city || !s.location?.state) report('STAKEHOLDER_COVERAGE', `${s.id} has no city/state Location`);
  }
}

/** Req 2.10: SoH in [0, 100] and non-increasing except across a module-replacement record. */
function checkTelemetry({ twins, report }: Ctx) {
  for (const t of twins) {
    const rs = [...t.telemetry].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    rs.forEach((r, i) => {
      if (!(r.sohPct >= 0 && r.sohPct <= 100)) {
        report('TELEMETRY_SOH', `${idOf(t)}: SoH ${r.sohPct} at ${r.timestamp} is outside 0–100`);
      }
      const prev = rs[i - 1];
      if (prev && r.sohPct > prev.sohPct) {
        const from = datePart(prev.timestamp);
        const to = datePart(r.timestamp);
        const replaced = t.serviceHistory.some((s) => s.modulesReplaced.length > 0 && s.date >= from && s.date <= to);
        if (!replaced) {
          report('TELEMETRY_SOH', `${idOf(t)}: SoH rose from ${prev.sohPct} to ${r.sohPct} between ${from} and ${to} without a module replacement`);
        }
      }
    });
  }
}

/**
 * Req 2.14: every twin with Routed_Pathway Second_Life_Review or a Second_Life_Provider holder
 * has a Data_Owner grant on or before the first handover away from the Data_Owner, and no
 * Data_Owner withdrawal between that grant and that handover.
 */
function checkConsentBeforeHandover({ twins, report }: Ctx) {
  for (const t of twins) {
    if (t.routedPathway !== 'Second_Life_Review' && holderOf(t)?.toHolderRole !== 'Second_Life_Provider') continue;
    const ownerId = t.dataOwner.id;
    const leave = t.custodyLog.find((e) => e.fromHolderId === ownerId);
    if (!leave) {
      report('CONSENT_BEFORE_HANDOVER', `${idOf(t)}: no Custody_Log handover away from Data_Owner ${ownerId}`);
      continue;
    }
    const before = t.consentEvents.filter((c) => c.byId === ownerId && datePart(c.at) <= leave.date);
    const lastGrant = before.map((c) => c.type).lastIndexOf('grant');
    if (lastGrant < 0) {
      report('CONSENT_BEFORE_HANDOVER', `${idOf(t)}: no Data_Owner Consent grant on or before the handover on ${leave.date}`);
    } else if (before.slice(lastGrant + 1).some((c) => c.type === 'withdraw')) {
      report('CONSENT_BEFORE_HANDOVER', `${idOf(t)}: Consent withdrawn between the grant and the handover on ${leave.date}`);
    }
  }
}

/** Req 2.7, 14.6: exactly one demo battery in its walkthrough start state. */
function checkDemoBattery({ dataset, twins, runDate, report }: Ctx) {
  const fail = (msg: string) => report('DEMO_BATTERY', `${DEMO_BATTERY_ID}: ${msg}`);
  const demos = twins.filter((t) => idOf(t) === DEMO_BATTERY_ID);
  if (demos.length !== 1) {
    report('DEMO_BATTERY', `Expected exactly one ${DEMO_BATTERY_ID}, found ${demos.length}`);
    return;
  }
  const t = demos[0]!;
  const holder = holderOf(t);
  if (holder?.toHolderRole !== 'Owner') fail(`Current_Holder role is ${holder?.toHolderRole ?? 'none'}, expected Owner`);
  if (consentStatus(t) !== 'not_granted') fail('Consent is granted, expected not granted');
  if (t.endOfLife !== null) fail('has an End_Of_Life_Record');
  if (t.routedPathway !== null) fail(`has Routed_Pathway ${t.routedPathway}`);
  if (t.returnRecords.length > 0) fail('has a ReturnRecord');
  const downstream = t.custodyLog.filter((e) => DOWNSTREAM_ROLES.includes(e.toHolderRole));
  if (downstream.length > 0) fail(`has handovers to ${downstream.map((e) => e.toHolderRole).join(', ')}`);
  if (safetyFlag(t, runDate)) fail('has a Safety_Flag');
  if (recentFault(t, runDate)) fail('has a Recent_Fault');
  const pathway = recommendPathway(t, runDate).pathway;
  if (pathway !== 'Second_Life_Review') fail(`Pathway on ${runDate} is ${pathway}, expected Second_Life_Review`);

  // A Return_Offer naming the designated Service_Partner is shown to the Owner (Req 14.6, 7.17).
  const owner = holder ? dataset.stakeholders.find((s) => s.id === holder.toHolderId) : undefined;
  const offer = t.nudges.find((n) => n.type === 'Return_Incentive');
  if (!offer || offer.type !== 'Return_Incentive') {
    fail('has no Return_Incentive Nudge with a Return_Offer');
  } else if (owner) {
    const expected = designateServicePartner(owner, dataset.stakeholders);
    if (offer.returnOffer.servicePartnerId !== expected.id) {
      fail(`Return_Offer names ${offer.returnOffer.servicePartnerId}, expected designated ${expected.id}`);
    }
  }
}

const CHECKS: ReadonlyArray<[SeedInvariant, (ctx: Ctx) => void]> = [
  ['TWIN_COUNT', checkTwinCount],
  ['MANUFACTURER_COVERAGE', checkPassportCoverage('manufacturer', 'MANUFACTURER_COVERAGE')],
  ['CHEMISTRY_COVERAGE', checkPassportCoverage('chemistry', 'CHEMISTRY_COVERAGE')],
  ['PATHWAY_COVERAGE', checkPathwayCoverage],
  ['FLEET_SIZE', checkFleetSize],
  ['HOLDER_ROLE_COVERAGE', checkHolderRoles],
  ['OWNER_CONSENT_RATIO', checkOwnerConsentRatio],
  ['FLEET_CONSENT', checkFleetConsent],
  ['EOL_COVERAGE', checkEolCoverage],
  ['MISSING_RECORDS_COVERAGE', checkMissingRecords],
  ['ROUTED_SECOND_LIFE', checkRoutedSecondLife],
  ['ROUTED_RECYCLING', checkRoutedRecycling],
  ['STAKEHOLDER_COVERAGE', checkStakeholders],
  ['TELEMETRY_SOH', checkTelemetry],
  ['CONSENT_BEFORE_HANDOVER', checkConsentBeforeHandover],
  ['DEMO_BATTERY', checkDemoBattery],
];
