/**
 * Deterministic synthetic dataset generator for the Seed_Script (Req 2, 14.6).
 *
 * `generateDataset(seed, runDate)` is a pure function: it uses a local mulberry32 PRNG
 * seeded from `seed`, derives every date as an offset from `runDate`, and never reads the
 * clock, the file system, or `Math.random`. Same seed + same run date → deeply equal Store
 * (Req 2.8, 2.11).
 *
 * The dataset is built from fixed archetypes, so coverage does not depend on the seed:
 * the seed only varies values inside safe margins (SoH jitter, cycle counts, capacities,
 * charging energies, temperatures, reading lags, and which Owner-held twins have Consent).
 * Lifecycle events (returns, fleet handovers, referrals, dispatches, intake, materials) are
 * produced by the pure core command functions with past "today" dates, so every seeded
 * history is one the Platform itself could have written.
 *
 * Stakeholder names are generic placeholders; Locations are city/state only.
 */
import { acceptReturnOffer, dispatchToRecycler, flagInspection, handOverToServicePartner, logIntake, logMaterials, logRepair, recordConsent, referToSecondLife, acceptSecondLife } from '../src/core/commands';
import { addDays, addMonths, daysBetween, isIsoDate } from '../src/core/dates';
import { reconcileNudges } from '../src/core/nudges';
import { currentHolder } from '../src/core/telemetry';
import type {
  ChargingSession,
  DataOwner,
  DigitalTwin,
  DomainError,
  ISODate,
  Module,
  Result,
  ServiceRecord,
  Stakeholder,
  Store,
  TelemetryReading,
  ViewerContext,
} from '../src/core/types';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Seed used when `--seed` is not supplied (Req 2.11). */
export const DEFAULT_SEED = 20250101;

/** The designated demo battery (Req 2.7, 14.6). Same ID on every run. */
export const DEMO_BATTERY_ID = 'BR-DEMO-0001';
/** Demo walkthrough identities (README / walkthrough test, Req 14.3). */
export const DEMO_OWNER_ID = 'OWN-001';
/** Designated Service_Partner for the demo Owner (Texas; first by name among Texas SPs). */
export const DEMO_SERVICE_PARTNER_ID = 'SP-004';
export const DEMO_SECOND_LIFE_PROVIDER_ID = 'SLP-001';
export const DEMO_RECYCLER_ID = 'RCY-001';
export const DEMO_ESG_OFFICER_ID = 'ESG-001';
export const DEMO_MANUFACTURER = 'Voltara Motors';

/** Fleet_Operator holding the main fleet (≥ 10 twins, Consent granted, Req 2.4, 2.5). */
export const MAIN_FLEET_OPERATOR_ID = 'FLT-001';
/** Fleet battery held by FLT-001 with an Inspection_Flag for FLAGGED_FLEET_SERVICE_PARTNER_ID (no handover yet). */
export const FLAGGED_FLEET_BATTERY_ID = 'BR-0006';
export const FLAGGED_FLEET_SERVICE_PARTNER_ID = 'SP-002';
/** Fleet battery held by FLT-001 with no Inspection_Flag. */
export const UNFLAGGED_FLEET_BATTERY_ID = 'BR-0001';
/** Owner with no held and no returned batteries (empty-state demo). */
export const EMPTY_OWNER_ID = 'OWN-012';

export const MANUFACTURERS = ['Voltara Motors', 'Northwind Auto', 'Helio EV Co.'] as const;
export const CHEMISTRIES = ['NMC', 'LFP', 'NCA'] as const;

/** Days before runDate of the backdated Service_Prompt `createdOn` on selected archetypes. */
export const BACKDATED_SERVICE_PROMPT_DAYS = 45;

/** Target share of Owner-held twins with Consent granted (Req 2.5: 50–70%, target 60%). */
export const OWNER_CONSENT_TARGET = 0.6;

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, deterministic 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Folds a safe integer (possibly negative or above 2^32) into a 32-bit PRNG seed. */
function seed32(seed: number): number {
  const lo = seed >>> 0;
  const hi = Math.floor(seed / 4294967296) | 0;
  return (lo ^ Math.imul(hi, 0x9e3779b1)) >>> 0;
}

interface Rng {
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** Float in [min, max] rounded to `dp` decimals. */
  float(min: number, max: number, dp?: number): number;
  shuffle<T>(items: readonly T[]): T[];
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed32(seed));
  const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max, dp = 1) => round(min + next() * (max - min), dp),
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Seed argument parsing (Req 2.11, 2.12)
// ---------------------------------------------------------------------------

export type SeedParseResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Parses a `--seed` value. `undefined`/`null` (not supplied) → DEFAULT_SEED.
 * Anything that is not a decimal integer within the safe-integer range is invalid.
 */
export function parseSeed(arg: string | undefined | null): SeedParseResult {
  if (arg === undefined || arg === null) return { ok: true, value: DEFAULT_SEED };
  const text = arg.trim();
  const n = Number(text);
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(n)) {
    return { ok: false, error: `Invalid seed value: ${JSON.stringify(arg)} (must be an integer)` };
  }
  return { ok: true, value: n === 0 ? 0 : n };
}

// ---------------------------------------------------------------------------
// Stakeholders (fixed; Req 2.6, 13.3)
// ---------------------------------------------------------------------------

function sh(id: string, role: Stakeholder['role'], name: string, city: string, state: string, manufacturer?: string): Stakeholder {
  const s: Stakeholder = { id, role, name, location: { city, state } };
  if (manufacturer !== undefined) s.manufacturer = manufacturer;
  return s;
}

const OWNER_LOCATIONS: ReadonlyArray<[string, string]> = [
  ['Austin', 'TX'],
  ['Dallas', 'TX'],
  ['Portland', 'OR'],
  ['Denver', 'CO'],
  ['Columbus', 'OH'],
  ['Houston', 'TX'],
  ['Eugene', 'OR'],
  ['Boulder', 'CO'],
  ['Cleveland', 'OH'],
  ['El Paso', 'TX'],
  ['Salem', 'OR'],
  ['Fort Collins', 'CO'],
];

/** All stakeholder identities, at least one per role, each with a city/state Location. */
export function buildStakeholders(): Stakeholder[] {
  const owners = OWNER_LOCATIONS.map(([city, state], i) => {
    const n = String(i + 1).padStart(2, '0');
    return sh(`OWN-0${n}`, 'Owner', `Sample Owner ${n}`, city, state);
  });
  return [
    ...owners,
    sh('FLT-001', 'Fleet_Operator', 'Metro Rideshare Fleet', 'Austin', 'TX'),
    sh('FLT-002', 'Fleet_Operator', 'Coastal Delivery Fleet', 'Portland', 'OR'),
    sh('SP-001', 'Service_Partner', 'Lone Star Battery Service', 'Austin', 'TX'),
    sh('SP-002', 'Service_Partner', 'Cascade EV Repair', 'Portland', 'OR'),
    sh('SP-003', 'Service_Partner', 'Front Range Battery Care', 'Denver', 'CO'),
    sh('SP-004', 'Service_Partner', 'Alamo Battery Clinic', 'San Antonio', 'TX'),
    sh('SLP-001', 'Second_Life_Provider', 'GridReuse Storage Co.', 'Denver', 'CO'),
    sh('SLP-002', 'Second_Life_Provider', 'Second Spin Mobility', 'Columbus', 'OH'),
    sh('RCY-001', 'Recycler', 'Certified Cell Recovery', 'Reno', 'NV'),
    sh('RCY-002', 'Recycler', 'Great Lakes Battery Recycling', 'Toledo', 'OH'),
    sh('ESG-001', 'ESG_Officer', 'Voltara Motors ESG Office', 'Detroit', 'MI', 'Voltara Motors'),
    sh('ESG-002', 'ESG_Officer', 'Northwind Auto Sustainability Team', 'Seattle', 'WA', 'Northwind Auto'),
    sh('ESG-003', 'ESG_Officer', 'Helio EV Co. Compliance Desk', 'Phoenix', 'AZ', 'Helio EV Co.'),
  ];
}

// ---------------------------------------------------------------------------
// Twin archetypes
// ---------------------------------------------------------------------------

interface TelemetrySpec {
  /** Target SoH of the latest reading (jittered by ±0.8). */
  finalSoh: number;
  /** SoH decline per monthly reading (percentage points). */
  decline: number;
  /** Number of monthly intervals; readings = months + 1. Default 18. */
  months?: number;
  /** Readings with index ≥ this have thermal event count 1. */
  thermalFrom?: number;
  /** Module replacement before reading `bumpAt`; SoH rises by `bumpGain` across it. */
  bumpAt?: number;
  bumpGain?: number;
}

type ChargingProfile = 'low' | 'high' | 'none';

interface Ctx {
  runDate: ISODate;
  stakeholders: Stakeholder[];
  rng: Rng;
}

interface TwinSpec {
  holder: DataOwner;
  telemetry: TelemetrySpec | null;
  charging: ChargingProfile;
  /** Adds an early routine (no-fault) service record. Default true. */
  routineService?: boolean;
  /** Extra seeded service records, as [daysAgo, faultCode, actionTaken]. */
  faults?: ReadonlyArray<[number, string, string]>;
  /** Empty chemistry (missing-record twin, Req 2.5). */
  emptyChemistry?: boolean;
  /** Fleet_Operator Data_Owner grants Consent shortly after acquisition. */
  fleetConsent?: 'grant' | 'grant-withdraw';
  /** Owner-held: start with a Service_Prompt created BACKDATED_SERVICE_PROMPT_DAYS ago. */
  backdatedPrompt?: boolean;
  /** Lifecycle events applied with the core commands. */
  life?: (twin: DigitalTwin, ctx: Ctx) => DigitalTwin;
}

const DAY_MS_TIME = 'T08:00:00Z';

function ts(date: ISODate, time = DAY_MS_TIME): string {
  return `${date}${time}`;
}

function must<T>(result: Result<{ twin: DigitalTwin } & T, DomainError>, what: string, id: string): DigitalTwin {
  if (!result.ok) {
    throw new Error(`Seed generator: ${what} failed for ${id}: ${result.error.code} ${result.error.message}`);
  }
  return result.value.twin;
}

function holderId(twin: DigitalTwin): string {
  const h = currentHolder(twin.custodyLog);
  if (!h) throw new Error(`Seed generator: ${twin.passport.batteryId} has no Current_Holder`);
  return h.toHolderId;
}

// --- Lifecycle steps (each uses a core command with a past "today") --------

const viewer = (role: ViewerContext['role'], identityId: string): ViewerContext => ({ role, identityId });

function grantConsent(twin: DigitalTwin, ctx: Ctx, daysAgo: number): DigitalTwin {
  const { id, role } = twin.dataOwner;
  const at = ts(addDays(ctx.runDate, -daysAgo), 'T10:00:00Z');
  return must(recordConsent(twin, viewer(role, id), 'grant', at), 'consent grant', twin.passport.batteryId);
}

function withdrawConsent(twin: DigitalTwin, ctx: Ctx, daysAgo: number): DigitalTwin {
  const { id, role } = twin.dataOwner;
  const at = ts(addDays(ctx.runDate, -daysAgo), 'T11:00:00Z');
  return must(recordConsent(twin, viewer(role, id), 'withdraw', at), 'consent withdrawal', twin.passport.batteryId);
}

function ownerReturn(twin: DigitalTwin, ctx: Ctx, daysAgo: number): DigitalTwin {
  const ownerId = holderId(twin);
  const today = addDays(ctx.runDate, -daysAgo);
  return must(acceptReturnOffer(twin, viewer('Owner', ownerId), ctx.stakeholders, today), 'return acceptance', twin.passport.batteryId);
}

function fleetToSp(twin: DigitalTwin, ctx: Ctx, spId: string, flagDaysAgo: number, handDaysAgo: number): DigitalTwin {
  const fleet = viewer('Fleet_Operator', holderId(twin));
  const id = twin.passport.batteryId;
  const flagged = must(
    flagInspection(twin, fleet, { servicePartnerId: spId }, ctx.stakeholders, addDays(ctx.runDate, -flagDaysAgo)),
    'inspection flag',
    id,
  );
  return must(handOverToServicePartner(flagged, fleet, addDays(ctx.runDate, -handDaysAgo)), 'fleet handover', id);
}

function referToSlp(twin: DigitalTwin, ctx: Ctx, slpId: string, daysAgo: number): DigitalTwin {
  const sp = viewer('Service_Partner', holderId(twin));
  return must(
    referToSecondLife(twin, sp, { secondLifeProviderId: slpId }, ctx.stakeholders, addDays(ctx.runDate, -daysAgo)),
    'referral',
    twin.passport.batteryId,
  );
}

function slpAccept(twin: DigitalTwin, ctx: Ctx, daysAgo: number): DigitalTwin {
  const slp = viewer('Second_Life_Provider', holderId(twin));
  return must(acceptSecondLife(twin, slp, addDays(ctx.runDate, -daysAgo)), 'second-life acceptance', twin.passport.batteryId);
}

function dispatch(twin: DigitalTwin, ctx: Ctx, recyclerId: string, daysAgo: number, arrivalAfterDays: number): DigitalTwin {
  const holder = currentHolder(twin.custodyLog)!;
  const actor = viewer(holder.toHolderRole, holder.toHolderId);
  const today = addDays(ctx.runDate, -daysAgo);
  return must(
    dispatchToRecycler(twin, actor, { recyclerId, expectedArrivalDate: addDays(today, arrivalAfterDays) }, ctx.stakeholders, today),
    'dispatch',
    twin.passport.batteryId,
  );
}

function intake(twin: DigitalTwin, ctx: Ctx, daysAgo: number): DigitalTwin {
  const rcy = viewer('Recycler', holderId(twin));
  const today = addDays(ctx.runDate, -daysAgo);
  return must(logIntake(twin, rcy, { intakeDate: today }, today), 'intake', twin.passport.batteryId);
}

function recoverMaterials(twin: DigitalTwin, ctx: Ctx, daysAgo: number): DigitalTwin {
  const rcy = viewer('Recycler', holderId(twin));
  const m = twin.passport.packMassKg;
  const kg = (share: number) => Math.round(m * share * 10) / 10;
  const materials: Record<string, number> =
    twin.passport.chemistry === 'LFP'
      ? { lithium: kg(0.02), iron: kg(0.1), copper: kg(0.08), aluminum: kg(0.12), graphite: kg(0.13) }
      : { lithium: kg(0.02), nickel: kg(0.09), cobalt: kg(0.03), manganese: kg(0.02), copper: kg(0.08), aluminum: kg(0.12), graphite: kg(0.13) };
  const today = addDays(ctx.runDate, -daysAgo);
  return must(logMaterials(twin, rcy, { materials }, today), 'materials recovered', twin.passport.batteryId);
}

function spRepair(twin: DigitalTwin, ctx: Ctx, daysAgo: number, faultCode: string, actionTaken: string, modules: string[]): DigitalTwin {
  const sp = viewer('Service_Partner', holderId(twin));
  const today = addDays(ctx.runDate, -daysAgo);
  return must(logRepair(twin, sp, { date: today, faultCode, actionTaken, modulesReplaced: modules }, today), 'repair', twin.passport.batteryId);
}

const owner = (id: string): DataOwner => ({ id, role: 'Owner' });
const fleet = (id: string): DataOwner => ({ id, role: 'Fleet_Operator' });

/**
 * Archetype list in battery-ID order (BR-0001, BR-0002, ...). The demo battery is added separately.
 * Pathways noted are the Pathway_Recommender result on runDate.
 */
const ARCHETYPES: readonly TwinSpec[] = [
  // --- Main fleet FLT-001 (12 twins, Consent granted) -----------------------------------------
  /* 0001 CU            */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 92, decline: 0.3 }, charging: 'high' },
  /* 0002 CU            */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 88, decline: 0.25 }, charging: 'low' },
  /* 0003 CU (≤12 mo)   */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 82, decline: 0.4 }, charging: 'high' },
  /* 0004 CU (≤12 mo)   */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 81, decline: 0.5 }, charging: 'low' },
  /* 0005 CU            */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 85, decline: 0.6 }, charging: 'low' },
  /* 0006 IR, flagged   */ {
    holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 84, decline: 0.3 }, charging: 'high',
    faults: [[20, 'COOLANT_LOW', 'Coolant topped up; inspection recommended']],
    life: (t, ctx) => must(
      flagInspection(t, viewer('Fleet_Operator', 'FLT-001'), { servicePartnerId: FLAGGED_FLEET_SERVICE_PARTNER_ID }, ctx.stakeholders, addDays(ctx.runDate, -10)),
      'inspection flag', t.passport.batteryId),
  },
  /* 0007 IR            */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 78, decline: 0.3 }, charging: 'low', faults: [[45, 'BMS_COMM_LOSS', 'BMS connector reseated']] },
  /* 0008 SLR           */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 74, decline: 0.4 }, charging: 'high' },
  /* 0009 SLR           */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 66, decline: 0.3 }, charging: 'low' },
  /* 0010 CR (SoH<60)   */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 55, decline: 0.5 }, charging: 'high' },
  /* 0011 CR (thermal)  */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 83, decline: 0.3, thermalFrom: 17 }, charging: 'high' },
  /* 0012 CU, no charge */ { holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 90, decline: 0.2 }, charging: 'none' },

  // --- Second fleet FLT-002 (no Consent) ----------------------------------------------------
  /* 0013 CU            */ { holder: fleet('FLT-002'), telemetry: { finalSoh: 91, decline: 0.2 }, charging: 'low' },
  /* 0014 CU, withdrawn */ { holder: fleet('FLT-002'), fleetConsent: 'grant-withdraw', telemetry: { finalSoh: 87, decline: 0.3 }, charging: 'high' },
  /* 0015 SLR           */ { holder: fleet('FLT-002'), telemetry: { finalSoh: 70, decline: 0.3 }, charging: 'low' },

  // --- Owner-held (Consent assigned later to ~60%) ------------------------------------------
  /* 0016 CU            */ { holder: owner('OWN-001'), telemetry: { finalSoh: 90, decline: 0.2 }, charging: 'low' },
  /* 0017 CU, guidance  */ { holder: owner('OWN-002'), telemetry: { finalSoh: 86, decline: 0.3 }, charging: 'high' },
  /* 0018 CU, old prompt*/ { holder: owner('OWN-003'), telemetry: { finalSoh: 84, decline: 0.6 }, charging: 'low', backdatedPrompt: true },
  /* 0019 CU, module rep*/ {
    holder: owner('OWN-003'), telemetry: { finalSoh: 88, decline: 0.3, bumpAt: 10, bumpGain: 4 }, charging: 'low',
  },
  /* 0020 IR, prompt    */ { holder: owner('OWN-004'), telemetry: { finalSoh: 81, decline: 0.5 }, charging: 'low', faults: [[30, 'CONTACTOR_WEAR', 'Contactor inspected; replacement scheduled']] },
  /* 0021 IR, no telem. */ { holder: owner('OWN-005'), telemetry: null, charging: 'low' },
  /* 0022 IR            */ { holder: owner('OWN-006'), telemetry: { finalSoh: 70, decline: 0.3 }, charging: 'low', faults: [[60, 'CELL_IMBALANCE', 'Cells rebalanced']] },
  /* 0023 SLR, guidance */ { holder: owner('OWN-006'), telemetry: { finalSoh: 76, decline: 0.3 }, charging: 'high' },
  /* 0024 SLR, old prmpt*/ { holder: owner('OWN-007'), telemetry: { finalSoh: 68, decline: 0.5 }, charging: 'low', backdatedPrompt: true },
  /* 0025 SLR           */ { holder: owner('OWN-008'), telemetry: { finalSoh: 62, decline: 0.2 }, charging: 'low' },
  /* 0026 CR (SoH<60)   */ { holder: owner('OWN-009'), telemetry: { finalSoh: 52, decline: 0.4 }, charging: 'high' },
  /* 0027 CR, fault only*/ { holder: owner('OWN-010'), telemetry: null, charging: 'low', faults: [[120, 'ISOLATION_FAULT', 'Isolation fault logged; pack isolated']] },
  /* 0028 CR (thermal)  */ { holder: owner('OWN-011'), telemetry: { finalSoh: 79, decline: 0.3, thermalFrom: 16 }, charging: 'low' },
  /* 0029 CU, missing   */ { holder: owner('OWN-008'), telemetry: { finalSoh: 95, decline: 0.2 }, charging: 'low', routineService: false, emptyChemistry: true },
  /* 0030 CU, no charge */ { holder: owner('OWN-010'), telemetry: { finalSoh: 93, decline: 0.2 }, charging: 'none' },
  /* 0031 CU            */ { holder: owner('OWN-011'), telemetry: { finalSoh: 89, decline: 0.2 }, charging: 'low' },

  // --- Service_Partner-held -----------------------------------------------------------------
  /* 0032 returned SLR  */ {
    holder: owner('OWN-002'), telemetry: { finalSoh: 70, decline: 0.2 }, charging: 'low',
    life: (t, ctx) => ownerReturn(grantConsent(t, ctx, 60), ctx, 40),
  },
  /* 0033 fleet→SP rep. */ {
    holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 83, decline: 0.3 }, charging: 'low',
    life: (t, ctx) => spRepair(fleetToSp(t, ctx, 'SP-001', 30, 25), ctx, 20, 'CONTACTOR_WEAR', 'Replaced worn main contactor module', [`${t.passport.batteryId}-M01`]),
  },
  /* 0034 returned CR   */ {
    holder: owner('OWN-011'), telemetry: { finalSoh: 56, decline: 0.3 }, charging: 'high',
    life: (t, ctx) => ownerReturn(t, ctx, 15),
  },

  // --- Second_Life_Provider-held (Routed_Pathway Second_Life_Review) ------------------------
  /* 0035 pending       */ {
    holder: owner('OWN-004'), telemetry: { finalSoh: 72, decline: 0.2 }, charging: 'low',
    life: (t, ctx) => referToSlp(ownerReturn(grantConsent(t, ctx, 100), ctx, 90), ctx, 'SLP-001', 80),
  },
  /* 0036 accepted      */ {
    holder: owner('OWN-005'), telemetry: { finalSoh: 68, decline: 0.2 }, charging: 'low',
    life: (t, ctx) => slpAccept(referToSlp(ownerReturn(grantConsent(t, ctx, 200), ctx, 180), ctx, 'SLP-001', 170), ctx, 150),
  },
  /* 0037 fleet pending */ {
    holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 71, decline: 0.3 }, charging: 'high',
    life: (t, ctx) => referToSlp(fleetToSp(t, ctx, 'SP-003', 130, 125), ctx, 'SLP-002', 110),
  },
  /* 0038 safety-flagged*/ {
    holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 75, decline: 0.3, thermalFrom: 14 }, charging: 'low',
    life: (t, ctx) => referToSlp(fleetToSp(t, ctx, 'SP-001', 60, 55), ctx, 'SLP-002', 50),
  },
  /* 0039 accepted      */ {
    holder: owner('OWN-008'), telemetry: { finalSoh: 65, decline: 0.2 }, charging: 'low',
    life: (t, ctx) => slpAccept(referToSlp(ownerReturn(grantConsent(t, ctx, 160), ctx, 150), ctx, 'SLP-002', 140), ctx, 120),
  },

  // --- Recycler-held (Routed_Pathway Certified_Recycling) -----------------------------------
  /* 0040 awaiting      */ {
    holder: owner('OWN-007'), telemetry: { finalSoh: 50, decline: 0.3 }, charging: 'high',
    life: (t, ctx) => dispatch(ownerReturn(t, ctx, 30), ctx, 'RCY-001', 5, 15),
  },
  /* 0041 received      */ {
    holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 54, decline: 0.4 }, charging: 'high',
    life: (t, ctx) => intake(dispatch(fleetToSp(t, ctx, 'SP-001', 70, 65), ctx, 'RCY-001', 40, 10), ctx, 28),
  },
  /* 0042 recycled      */ {
    holder: owner('OWN-009'), telemetry: { finalSoh: 45, decline: 0.3 }, charging: 'high',
    life: (t, ctx) => recoverMaterials(intake(dispatch(ownerReturn(grantConsent(t, ctx, 210), ctx, 200), ctx, 'RCY-001', 190, 10), ctx, 178), ctx, 160),
  },
  /* 0043 SLR→recycled  */ {
    holder: owner('OWN-003'), telemetry: { finalSoh: 66, decline: 0.2 }, charging: 'low',
    life: (t, ctx) =>
      recoverMaterials(
        intake(dispatch(slpAccept(referToSlp(ownerReturn(grantConsent(t, ctx, 300), ctx, 290), ctx, 'SLP-001', 280), ctx, 270), ctx, 'RCY-002', 60, 10), ctx, 45),
        ctx,
        20,
      ),
  },
  /* 0044 fleet recycled*/ {
    holder: fleet('FLT-002'), telemetry: { finalSoh: 57, decline: 0.3 }, charging: 'high',
    life: (t, ctx) => recoverMaterials(intake(dispatch(fleetToSp(t, ctx, 'SP-002', 150, 148), ctx, 'RCY-002', 140, 12), ctx, 130), ctx, 110),
  },
  /* 0045 SLR→awaiting  */ {
    holder: fleet('FLT-001'), fleetConsent: 'grant', telemetry: { finalSoh: 64, decline: 0.3 }, charging: 'low',
    life: (t, ctx) => dispatch(referToSlp(fleetToSp(t, ctx, 'SP-003', 115, 112), ctx, 'SLP-002', 100), ctx, 'RCY-001', 3, 20),
  },
  /* 0046 old recycled  */ {
    holder: owner('OWN-006'), telemetry: { finalSoh: 48, decline: 0.2 }, charging: 'high',
    life: (t, ctx) => recoverMaterials(intake(dispatch(ownerReturn(t, ctx, 400), ctx, 'RCY-001', 390, 10), ctx, 385), ctx, 370),
  },
];

const DEMO_SPEC: TwinSpec = {
  holder: owner(DEMO_OWNER_ID),
  telemetry: { finalSoh: 72, decline: 0.3, months: 20 },
  charging: 'low',
};

// --- Record builders -----------------------------------------------------------------------

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function buildTelemetry(spec: TelemetrySpec, runDate: ISODate, rng: Rng): TelemetryReading[] {
  const months = spec.months ?? 18;
  const finalSoh = round1(spec.finalSoh + rng.float(-0.8, 0.8));
  const last = addDays(runDate, -rng.int(1, 10));
  const baseCycles = rng.int(20, 80);
  const cyclesPerMonth = rng.int(25, 45);
  const gain = spec.bumpAt !== undefined ? (spec.bumpGain ?? 4) : 0;
  const out: TelemetryReading[] = [];
  for (let i = 0; i <= months; i++) {
    const remaining = months - i;
    // Non-increasing within each segment; the only rise is across the module replacement.
    let soh = finalSoh + spec.decline * remaining;
    if (spec.bumpAt !== undefined && i < spec.bumpAt) soh -= gain;
    out.push({
      timestamp: ts(addMonths(last, -remaining)),
      sohPct: Math.max(0, Math.min(100, round1(soh))),
      cycleCount: baseCycles + cyclesPerMonth * i,
      thermalEventCount: spec.thermalFrom !== undefined && i >= spec.thermalFrom ? 1 : 0,
    });
  }
  return out;
}

function buildCharging(profile: ChargingProfile, runDate: ISODate, rng: Rng): ChargingSession[] {
  if (profile === 'none') return [];
  const n = rng.int(8, 12);
  const lag = rng.int(0, 6);
  const fastCount = profile === 'high' ? n - rng.int(1, 2) : rng.int(0, 1);
  const fastIdx = new Set(rng.shuffle([...Array(n).keys()]).slice(0, fastCount));
  const sessions: ChargingSession[] = [];
  for (let i = 0; i < n; i++) {
    const fast = fastIdx.has(i);
    sessions.push({
      date: addDays(runDate, -(lag + 21 * (n - 1 - i))),
      energyKwh: fast ? rng.float(25, 45) : rng.float(15, 30),
      chargeType: fast ? 'DC_Fast' : 'AC',
      ambientTempC: rng.int(-10, 35),
    });
  }
  return sessions;
}

function buildTwin(batteryId: string, index: number, spec: TwinSpec, ctx: Ctx, overrides: { manufacturer?: string; chemistry?: string } = {}): DigitalTwin {
  const { runDate, rng } = ctx;
  const acquired = addDays(runDate, -rng.int(720, 1000));
  const manufactureDate = addDays(acquired, -rng.int(20, 120));
  const capacityKwh = rng.int(40, 100);
  const manufacturer = overrides.manufacturer ?? MANUFACTURERS[index % MANUFACTURERS.length]!;
  const chemistry = spec.emptyChemistry ? '' : (overrides.chemistry ?? CHEMISTRIES[Math.floor(index / 3) % CHEMISTRIES.length]!);

  const telemetry = spec.telemetry ? buildTelemetry(spec.telemetry, runDate, rng) : [];
  const latestSoh = telemetry[telemetry.length - 1]?.sohPct;
  const moduleCount = rng.int(4, 8);
  const modules: Module[] = [];
  for (let m = 1; m <= moduleCount; m++) {
    let condition: Module['condition'] = 'Good';
    if (m === 1 && latestSoh !== undefined && latestSoh < 60) condition = 'Failed';
    else if (m <= 2 && latestSoh !== undefined && latestSoh < 80) condition = 'Degraded';
    modules.push({ moduleId: `${batteryId}-M${String(m).padStart(2, '0')}`, condition });
  }

  const serviceHistory: ServiceRecord[] = [];
  if (spec.routineService !== false) {
    serviceHistory.push({ date: addDays(acquired, rng.int(60, 180)), faultCode: '', actionTaken: 'Routine battery inspection', modulesReplaced: [] });
  }
  if (spec.telemetry?.bumpAt !== undefined) {
    const before = telemetry[spec.telemetry.bumpAt - 1]!;
    serviceHistory.push({
      date: addDays(before.timestamp.slice(0, 10), 12),
      faultCode: 'CELL_IMBALANCE',
      actionTaken: 'Replaced degraded module',
      modulesReplaced: [`${batteryId}-M02`],
    });
  }
  for (const [daysAgo, faultCode, actionTaken] of spec.faults ?? []) {
    serviceHistory.push({ date: addDays(runDate, -daysAgo), faultCode, actionTaken, modulesReplaced: [] });
  }
  serviceHistory.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let twin: DigitalTwin = {
    passport: {
      batteryId,
      chemistry,
      capacityKwh,
      packMassKg: Math.round(capacityKwh * rng.float(5.8, 7.2, 2)),
      manufactureDate,
      manufacturer,
      embeddedCarbonKgCo2e: capacityKwh * rng.int(60, 100),
      recycledContentPct: rng.int(0, 25),
    },
    modules,
    telemetry,
    chargingHistory: buildCharging(spec.charging, runDate, rng),
    serviceHistory,
    custodyLog: [{ date: acquired, fromHolderId: null, toHolderId: spec.holder.id, toHolderRole: spec.holder.role }],
    endOfLife: null,
    dataOwner: { ...spec.holder },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };

  if (spec.fleetConsent) {
    twin = grantConsent(twin, ctx, daysBetween(addDays(acquired, 3), runDate));
    if (spec.fleetConsent === 'grant-withdraw') twin = withdrawConsent(twin, ctx, rng.int(10, 60));
  }
  if (spec.life) twin = spec.life(twin, ctx);
  return twin;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/** Battery ID of archetype `n` (1-based). */
export function seededBatteryId(n: number): string {
  return `BR-${String(n).padStart(4, '0')}`;
}

/**
 * Builds the full synthetic Store for `seed` and `runDate`. Pure and deterministic.
 * Throws on a non-integer seed or an invalid runDate (CLI validation happens earlier).
 */
export function generateDataset(seed: number, runDate: ISODate): Store {
  if (!Number.isSafeInteger(seed)) throw new RangeError(`Invalid seed value: ${String(seed)}`);
  if (!isIsoDate(runDate)) throw new RangeError(`Invalid run date: ${String(runDate)}`);

  const stakeholders = buildStakeholders();
  const ctx: Ctx = { runDate, stakeholders, rng: makeRng(seed) };

  const specs = new Map<string, TwinSpec>();
  const twins: DigitalTwin[] = ARCHETYPES.map((spec, i) => {
    const id = seededBatteryId(i + 1);
    specs.set(id, spec);
    return buildTwin(id, i, spec, ctx);
  });
  specs.set(DEMO_BATTERY_ID, DEMO_SPEC);
  twins.push(buildTwin(DEMO_BATTERY_ID, 0, DEMO_SPEC, ctx, { manufacturer: DEMO_MANUFACTURER, chemistry: 'NMC' }));

  // Owner Consent (Req 2.5): ~60% of Owner-held twins granted; the demo battery stays not granted (Req 14.6).
  const ownerHeld = twins.filter((t) => currentHolder(t.custodyLog)?.toHolderRole === 'Owner');
  const candidates = ctx.rng.shuffle(ownerHeld.filter((t) => t.passport.batteryId !== DEMO_BATTERY_ID).map((t) => t.passport.batteryId));
  const grantCount = Math.round(OWNER_CONSENT_TARGET * ownerHeld.length);
  const granted = new Set(candidates.slice(0, grantCount));
  const withdrawn = new Set(candidates.slice(grantCount, grantCount + 2));

  const owners = new Map(stakeholders.filter((s) => s.role === 'Owner').map((s) => [s.id, s]));
  const servicePartners = stakeholders.filter((s) => s.role === 'Service_Partner');

  const out: Record<string, DigitalTwin> = {};
  for (let twin of twins) {
    const id = twin.passport.batteryId;
    const holder = currentHolder(twin.custodyLog)!;
    if (holder.toHolderRole === 'Owner') {
      const acquiredDaysAgo = daysBetween(twin.custodyLog[0]!.date, runDate);
      if (granted.has(id) || withdrawn.has(id)) twin = grantConsent(twin, ctx, acquiredDaysAgo - ctx.rng.int(10, 60));
      if (withdrawn.has(id)) twin = withdrawConsent(twin, ctx, ctx.rng.int(5, 60));

      const ownerSh = owners.get(holder.toHolderId)!;
      const prior = specs.get(id)?.backdatedPrompt
        ? [{ type: 'Service_Prompt' as const, createdOn: addDays(runDate, -BACKDATED_SERVICE_PROMPT_DAYS), message: '' }]
        : [];
      twin = { ...twin, nudges: reconcileNudges({ ...twin, nudges: prior }, runDate, ownerSh, servicePartners) };
    } else {
      // Nudges exist only for Owner-held batteries.
      twin = { ...twin, nudges: [] };
    }
    out[id] = twin;
  }

  return { version: 2, seed, runDate, stakeholders, twins: out };
}
